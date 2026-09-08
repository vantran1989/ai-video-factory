import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const app = express();

const PORT = Number(process.env.PORT) || 10000;
const HOST = "0.0.0.0";

const ROOT = process.cwd();
const WORK_DIR = path.join(ROOT, "work");
const OUTPUT_DIR = path.join(ROOT, "output");

fs.mkdirSync(WORK_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

app.use(express.json({ limit: "1mb" }));
app.use("/output", express.static(OUTPUT_DIR));

const jobs = new Map();
const queue = [];
let processing = false;

function text(v, fallback = "") {
  return String(v ?? fallback)
    .replace(/\s+/g, " ")
    .trim();
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function fileSafe(v) {
  return (
    text(v, "video")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 70) || "video"
  );
}

function updateJob(job, data) {
  Object.assign(job, data, {
    updatedAt: new Date().toISOString()
  });
}

function publicJob(job) {
  return {
    id: job.id,
    topic: job.topic,
    count: job.count,
    duration: job.duration,
    style: job.style,
    status: job.status,
    step: job.step,
    progress: job.progress,
    outputs: job.outputs || [],
    error: job.error || null,
    mode: job.mode,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}

async function exec(file, args, options = {}) {
  return execFileAsync(file, args, {
    maxBuffer: 30 * 1024 * 1024,
    windowsHide: true,
    ...options
  });
}

async function existsCommand(command) {
  try {
    await exec("which", [command]);
    return true;
  } catch {
    return false;
  }
}

async function fetchTimeout(url, options = {}, timeout = 20000) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}: ${url}`
      );
    }

    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, options = {}, timeout = 20000) {
  const response = await fetchTimeout(
    url,
    options,
    timeout
  );

  return response.json();
}

async function download(url, output) {
  const response = await fetchTimeout(
    url,
    {
      headers: {
        "User-Agent":
          "Mozilla/5.0 AI-Video-Factory/5.0"
      }
    },
    30000
  );

  const buffer = Buffer.from(
    await response.arrayBuffer()
  );

  if (buffer.length < 1000) {
    throw new Error("File ảnh tải về quá nhỏ.");
  }

  await fs.promises.writeFile(
    output,
    buffer
  );

  return buffer.length;
}

async function probe(file) {
  const result = await exec("ffprobe", [
    "-v",
    "error",
    "-show_format",
    "-show_streams",
    "-of",
    "json",
    file
  ]);

  return JSON.parse(result.stdout);
}

async function mediaDuration(file) {
  const meta = await probe(file);

  const duration = Number(
    meta?.format?.duration || 0
  );

  if (!duration || !Number.isFinite(duration)) {
    throw new Error(
      `Không đọc được thời lượng: ${path.basename(file)}`
    );
  }

  return duration;
}

async function validateImage(file) {
  const meta = await probe(file);

  const stream = (
    meta.streams || []
  ).find(
    x => x.codec_type === "video"
  );

  if (
    !stream ||
    !stream.width ||
    !stream.height
  ) {
    throw new Error(
      `Ảnh không hợp lệ: ${path.basename(file)}`
    );
  }

  return {
    width: Number(stream.width),
    height: Number(stream.height)
  };
}

async function wikipedia(topic) {
  const url =
    "https://vi.wikipedia.org/api/rest_v1/page/summary/" +
    encodeURIComponent(topic);

  try {
    const response =
      await fetchTimeout(
        url,
        {
          headers: {
            "User-Agent":
              "AI-Video-Factory/5.0"
          }
        },
        12000
      );

    const data =
      await response.json();

    return {
      title: text(data.title),
      extract: text(data.extract),
      image:
        data?.originalimage?.source ||
        data?.thumbnail?.source ||
        ""
    };
  } catch {
    return {
      title: "",
      extract: "",
      image: ""
    };
  }
}

function splitSentences(input) {
  return text(input)
    .replace(/\[[^\]]+\]/g, "")
    .split(/(?<=[.!?。！？])\s+/)
    .map(text)
    .filter(x => x.length > 20);
}

function topicWords(topic) {
  return text(topic)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(x => x.length >= 3);
}

function scoreImage(
  title,
  query,
  topic
) {
  const source =
    `${title} ${query}`
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "");

  const words = [
    ...topicWords(topic),
    ...topicWords(query)
  ];

  let score = 0;

  for (const word of words) {
    if (source.includes(word)) {
      score += 1;
    }
  }

  return score;
}

async function commonsSearch(
  query,
  topic
) {
  const url =
    new URL(
      "https://commons.wikimedia.org/w/api.php"
    );

  url.searchParams.set(
    "action",
    "query"
  );

  url.searchParams.set(
    "format",
    "json"
  );

  url.searchParams.set(
    "origin",
    "*"
  );

  url.searchParams.set(
    "generator",
    "search"
  );

  url.searchParams.set(
    "gsrsearch",
    `${query} filetype:bitmap`
  );

  url.searchParams.set(
    "gsrnamespace",
    "6"
  );

  url.searchParams.set(
    "gsrlimit",
    "20"
  );

  url.searchParams.set(
    "prop",
    "imageinfo"
  );

  url.searchParams.set(
    "iiprop",
    "url|mime|size"
  );

  url.searchParams.set(
    "iiurlwidth",
    "1000"
  );

  const data =
    await getJson(
      url,
      {
        headers: {
          "User-Agent":
            "AI-Video-Factory/5.0"
        }
      },
      15000
    );

  const pages =
    Object.values(
      data?.query?.pages || {}
    );

  return pages
    .map(page => {
      const info =
        page?.imageinfo?.[0];

      if (!info) {
        return null;
      }

      const imageUrl =
        info.thumburl ||
        info.url ||
        "";

      if (
        !imageUrl ||
        !/^https?:\/\//i.test(
          imageUrl
        )
      ) {
        return null;
      }

      if (
        !/^image\//.test(
          info.mime || ""
        )
      ) {
        return null;
      }

      const width =
        Number(info.width || 0);

      const height =
        Number(info.height || 0);

      if (
        width < 400 ||
        height < 400
      ) {
        return null;
      }

      const title =
        text(
          page.title
        );

      return {
        title,
        url: imageUrl,
        score:
          scoreImage(
            title,
            query,
            topic
          ),
        width,
        height
      };
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        b.score - a.score
    );
}

function escapeXml(v) {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function fallbackImage(
  output,
  title,
  subtitle
) {
  const svg =
    `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280">
<defs>
<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0%" stop-color="#101827"/>
<stop offset="100%" stop-color="#334155"/>
</linearGradient>
</defs>
<rect width="720" height="1280" fill="url(#g)"/>
<circle cx="600" cy="180" r="190" fill="white" opacity=".06"/>
<circle cx="100" cy="1080" r="250" fill="white" opacity=".04"/>
<text x="50" y="570"
fill="white"
font-family="DejaVu Sans"
font-size="42"
font-weight="bold">${escapeXml(title)}</text>
<text x="50" y="640"
fill="#cbd5e1"
font-family="DejaVu Sans"
font-size="25">${escapeXml(subtitle)}</text>
<text x="50" y="1190"
fill="#94a3b8"
font-family="DejaVu Sans"
font-size="22">AI VIDEO FACTORY</text>
</svg>`;

  const svgFile =
    output + ".svg";

  await fs.promises.writeFile(
    svgFile,
    svg,
    "utf8"
  );

  await exec("ffmpeg", [
    "-y",
    "-i",
    svgFile,
    "-frames:v",
    "1",
    output
  ]);

  await fs.promises.rm(
    svgFile,
    { force: true }
  );
}

async function findBestImage(
  topic,
  scene,
  sceneDir,
  wiki
) {
  const output =
    path.join(
      sceneDir,
      "source.jpg"
    );

  const candidates = [];

  if (
    scene.imageQuery
  ) {
    candidates.push(
      scene.imageQuery
    );
  }

  if (
    Array.isArray(
      scene.keywords
    )
  ) {
    for (
      const keyword of
      scene.keywords
    ) {
      if (keyword) {
        candidates.push(
          `${topic} ${keyword}`
        );
      }
    }
  }

  candidates.push(
    `${topic} ${scene.title}`
  );

  candidates.push(
    topic
  );

  if (
    scene.index === 1 &&
    wiki.image
  ) {
    try {
      await download(
        wiki.image,
        output
      );

      await validateImage(
        output
      );

      return {
        file: output,
        source: wiki.image,
        matched: true
      };
    } catch {
      await fs.promises.rm(
        output,
        { force: true }
      );
    }
  }

  let best = null;

  for (
    const query of
    [...new Set(candidates)]
  ) {
    try {
      const results =
        await commonsSearch(
          query,
          topic
        );

      for (
        const item of
        results.slice(0, 8)
      ) {
        if (
          !best ||
          item.score > best.score
        ) {
          best = item;
        }
      }

      if (
        best &&
        best.score >= 2
      ) {
        break;
      }
    } catch (error) {
      console.warn(
        "Image search:",
        error?.message || error
      );
    }
  }

  if (
    best &&
    best.score >= 1
  ) {
    try {
      await download(
        best.url,
        output
      );

      await validateImage(
        output
      );

      return {
        file: output,
        source: best.url,
        matched: true
      };
    } catch (error) {
      console.warn(
        "Image invalid:",
        error?.message || error
      );
    }
  }

  await fallbackImage(
    output,
    scene.title || topic,
    "Không tìm thấy ảnh đủ phù hợp."
  );

  return {
    file: output,
    source: "fallback",
    matched: false
  };
}

function fallbackScenes(
  topic,
  duration,
  style,
  wiki,
  videoNumber
) {
  const count =
    duration <= 15
      ? 4
      : duration <= 30
      ? 6
      : 8;

  const sentences =
    splitSentences(
      wiki.extract
    );

  const styles = {
    viral: {
      hook:
        `Bạn tưởng mình đã biết về ${topic}? Hãy xem 30 giây này trước khi lướt tiếp.`,
      end:
        `Nếu thấy thú vị, hãy bình luận chủ đề bạn muốn xem tiếp.`
    },

    knowledge: {
      hook:
        `Đây là những điều đáng biết về ${topic} mà nhiều người thường bỏ qua.`,
      end:
        `Bạn muốn tìm hiểu sâu hơn về chủ đề nào? Hãy để lại bình luận.`
    },

    story: {
      hook:
        `Hãy tưởng tượng bạn đang bước vào thế giới của ${topic}. Câu chuyện bắt đầu từ đây.`,
      end:
        `Nếu muốn nghe phần tiếp theo, hãy để lại một bình luận.`
    }
  };

  const styleData =
    styles[style] ||
    styles.viral;

  const scenes = [];

  scenes.push({
    title: "ĐỪNG LƯỚT",
    text: styleData.hook,
    keywords: [
      topic,
      "close up",
      "real photo"
    ],
    imageQuery:
      `${topic} real photo`,
    index: 1
  });

  if (sentences[0]) {
    scenes.push({
      title: "ĐIỀU ĐẦU TIÊN",
      text: sentences[0],
      keywords: [
        topic,
        "real",
        "detail"
      ],
      imageQuery:
        `${topic} real`,
      index: 2
    });
  } else {
    scenes.push({
      title: "NÓ LÀ GÌ?",
      text:
        `${topic} có nhiều đặc điểm đáng chú ý và là một chủ đề rất đáng để tìm hiểu.`,
      keywords: [
        topic,
        "real photo"
      ],
      imageQuery:
        `${topic} real photo`,
      index: 2
    });
  }

  if (sentences[1]) {
    scenes.push({
      title: "MỘT CHI TIẾT",
      text: sentences[1],
      keywords: [
        topic,
        "detail",
        "close up"
      ],
      imageQuery:
        `${topic} detail`,
      index: 3
    });
  } else {
    scenes.push({
      title: "ĐIỀU THÚ VỊ",
      text:
        `Điểm thú vị là khi tìm hiểu kỹ, ${topic} không đơn giản như chúng ta thường nghĩ.`,
      keywords: [
        topic,
        "interesting",
        "detail"
      ],
      imageQuery:
        `${topic} interesting`,
      index: 3
    });
  }

  if (sentences[2]) {
    scenes.push({
      title: "Ít NGƯỜI BIẾT",
      text: sentences[2],
      keywords: [
        topic,
        "behavior",
        "nature"
      ],
      imageQuery:
        `${topic} behavior`,
      index: 4
    });
  } else {
    scenes.push({
      title: "GÓC NHÌN KHÁC",
      text:
        `Điều khiến ${topic} đáng chú ý chính là những chi tiết thường không xuất hiện ngay từ cái nhìn đầu tiên.`,
      keywords: [
        topic,
        "nature",
        "real"
      ],
      imageQuery:
        `${topic} nature`,
      index: 4
    });
  }

  if (sentences[3]) {
    scenes.push({
      title: "VÌ SAO QUAN TRỌNG?",
      text: sentences[3],
      keywords: [
        topic,
        "environment",
        "context"
      ],
      imageQuery:
        `${topic} environment`,
      index: 5
    });
  } else {
    scenes.push({
      title: "ĐIỀU CẦN NHỚ",
      text:
        `Điều quan trọng cần nhớ là ${topic} còn rất nhiều khía cạnh để chúng ta khám phá.`,
      keywords: [
        topic,
        "context",
        "real"
      ],
      imageQuery:
        `${topic} context`,
      index: 5
    });
  }

  scenes.push({
    title: "CHỐT LẠI",
    text:
      `Nếu hôm nay bạn chỉ nhớ một điều về ${topic}, hãy nhớ rằng càng tìm hiểu kỹ càng có nhiều điều bất ngờ.`,
    keywords: [
      topic,
      "real photo",
      "overview"
    ],
    imageQuery:
      `${topic} overview real photo`,
    index: 6
  });

  if (count >= 8) {
    scenes.splice(
      5,
      0,
      {
        title: "BẠN CÓ BIẾT?",
        text:
          `Đây cũng là lý do ${topic} thường thu hút sự tò mò của rất nhiều người.`,
        keywords: [
          topic,
          "people",
          "real"
        ],
        imageQuery:
          `${topic} people`,
        index: 6
      }
    );
  }

  scenes.push({
    title: "CTA",
    text: styleData.end,
    keywords: [
      topic,
      "social media",
      "comment"
    ],
    imageQuery:
      `${topic} social media`,
    index: scenes.length + 1
  });

  return scenes
    .slice(0, count)
    .map(
      (scene, index) => ({
        ...scene,
        index:
          index + 1
      })
    );
}

async function aiScenes(
  topic,
  duration,
  style
) {
  const key =
    text(
      process.env.OPENAI_API_KEY
    );

  if (!key) {
    return null;
  }

  const count =
    duration <= 15
      ? 4
      : duration <= 30
      ? 6
      : 8;

  const model =
    text(
      process.env.OPENAI_SCRIPT_MODEL,
      "gpt-4o-mini"
    );

  const prompt = `
Bạn là chuyên gia làm Facebook Reels tiếng Việt.

Chủ đề: ${topic}
Phong cách: ${style}
Thời lượng: ${duration} giây
Số cảnh: ${count}

Nhiệm vụ:
1. Viết lời thoại chính xác theo chủ đề.
2. Mỗi cảnh chỉ có MỘT ý.
3. Cảnh 1 phải là hook.
4. Cảnh cuối phải là CTA.
5. Tuyệt đối không bịa số liệu.
6. Mỗi cảnh phải có truy vấn tìm ảnh CỤ THỂ.
7. imageQuery phải mô tả đúng vật/thứ/địa điểm đang được nói tới.
8. Không dùng từ khóa chung chung như "interesting", "detail", "overview" nếu không kèm đối tượng cụ thể.
9. Nếu nói về cá mập thì imageQuery phải tìm cá mập.
10. Nếu nói về Ai Cập cổ đại thì imageQuery phải tìm Ai Cập cổ đại.
11. Không được đưa ga tàu, xe lửa, thành phố hoặc vật không liên quan vào imageQuery.

Trả JSON thuần:

{
  "scenes": [
    {
      "title": "tiêu đề ngắn",
      "text": "lời thoại tiếng Việt",
      "imageQuery": "truy vấn ảnh tiếng Anh cực kỳ cụ thể",
      "keywords": ["keyword1","keyword2","keyword3"]
    }
  ]
}
`;

  const response =
    await fetchTimeout(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json",
          Authorization:
            `Bearer ${key}`
        },
        body: JSON.stringify({
          model,
          input: prompt,
          store: false
        })
      },
      45000
    );

  const data =
    await response.json();

  const output =
    text(
      data?.output_text
    );

  if (!output) {
    throw new Error(
      "AI không trả về kịch bản."
    );
  }

  let jsonText =
    output
      .replace(
        /^```json/i,
        ""
      )
      .replace(
        /```$/i,
        ""
      )
      .trim();

  const start =
    jsonText.indexOf("{");

  const end =
    jsonText.lastIndexOf("}");

  if (
    start >= 0 &&
    end > start
  ) {
    jsonText =
      jsonText.slice(
        start,
        end + 1
      );
  }

  const parsed =
    JSON.parse(
      jsonText
    );

  if (
    !Array.isArray(
      parsed.scenes
    )
  ) {
    throw new Error(
      "Kịch bản AI sai định dạng."
    );
  }

  return parsed.scenes
    .slice(0, count)
    .map(
      (scene, index) => ({
        index:
          index + 1,
        title:
          text(
            scene.title,
            `CẢNH ${index + 1}`
          ),
        text:
          text(
            scene.text
          ),
        imageQuery:
          text(
            scene.imageQuery
          ),
        keywords:
          Array.isArray(
            scene.keywords
          )
            ? scene.keywords
                .map(text)
                .filter(Boolean)
                .slice(0, 5)
            : []
      })
    )
    .filter(
      scene =>
        scene.text.length > 5
    );
}

async function tts(
  content,
  output
) {
  const key =
    text(
      process.env.OPENAI_API_KEY
    );

  if (key) {
    try {
      const model =
        text(
          process.env.OPENAI_TTS_MODEL,
          "gpt-4o-mini-tts"
        );

      const voice =
        text(
          process.env.OPENAI_TTS_VOICE,
          "alloy"
        );

      const response =
        await fetchTimeout(
          "https://api.openai.com/v1/audio/speech",
          {
            method: "POST",
            headers: {
              Authorization:
                `Bearer ${key}`,
              "Content-Type":
                "application/json"
            },
            body: JSON.stringify({
              model,
              voice,
              input: content,
              response_format:
                "mp3",
              speed: 1.03
            })
          },
          45000
        );

      const buffer =
        Buffer.from(
          await response.arrayBuffer()
        );

      if (
        buffer.length > 1000
      ) {
        await fs.promises.writeFile(
          output,
          buffer
        );

        await mediaDuration(
          output
        );

        return "openai";
      }
    } catch (error) {
      console.warn(
        "OpenAI TTS failed:",
        error?.message || error
      );
    }
  }

  try {
    const url =
      new URL(
        "https://translate.google.com/translate_tts"
      );

    url.searchParams.set(
      "ie",
      "UTF-8"
    );

    url.searchParams.set(
      "client",
      "tw-ob"
    );

    url.searchParams.set(
      "tl",
      "vi"
    );

    url.searchParams.set(
      "q",
      content.slice(0, 190)
    );

    const response =
      await fetchTimeout(
        url,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0"
          }
        },
        20000
      );

    const buffer =
      Buffer.from(
        await response.arrayBuffer()
      );

    if (
      buffer.length > 1000
    ) {
      await fs.promises.writeFile(
        output,
        buffer
      );

      await mediaDuration(
        output
      );

      return "google";
    }
  } catch (error) {
    console.warn(
      "Google TTS failed:",
      error?.message || error
    );
  }

  if (
    !(await existsCommand(
      "espeak-ng"
    ))
  ) {
    throw new Error(
      "Không có TTS khả dụng."
    );
  }

  const wav =
    output.replace(
      ".mp3",
      ".wav"
    );

  await exec(
    "espeak-ng",
    [
      "-v",
      "vi",
      "-s",
      "165",
      "-p",
      "48",
      "-a",
      "105",
      "-w",
      wav,
      content
    ]
  );

  await exec(
    "ffmpeg",
    [
      "-y",
      "-i",
      wav,
      "-ar",
      "44100",
      "-ac",
      "2",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "128k",
      output
    ]
  );

  await fs.promises.rm(
    wav,
    { force: true }
  );

  await mediaDuration(
    output
  );

  return "espeak";
}

async function normalizeImage(
  input,
  output
) {
  await exec(
    "ffmpeg",
    [
      "-y",
      "-i",
      input,
      "-vf",
      "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,setsar=1",
      "-frames:v",
      "1",
      "-q:v",
      "2",
      output
    ]
  );

  await validateImage(
    output
  );
}

async function normalizeAudio(
  input,
  output
) {
  await exec(
    "ffmpeg",
    [
      "-y",
      "-i",
      input,
      "-vn",
      "-ar",
      "44100",
      "-ac",
      "2",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      output
    ]
  );

  await mediaDuration(
    output
  );
}

function filterPath(file) {
  return file
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

async function renderScene(
  scene,
  dir
) {
  const image =
    path.join(
      dir,
      "image.jpg"
    );

  const audio =
    path.join(
      dir,
      "audio.m4a"
    );

  const caption =
    path.join(
      dir,
      "caption.txt"
    );

  const output =
    path.join(
      dir,
      "scene.mp4"
    );

  await normalizeImage(
    scene.imageFile,
    image
  );

  await normalizeAudio(
    scene.voiceFile,
    audio
  );

  const duration =
    clamp(
      await mediaDuration(
        audio
      ),
      1.5,
      8
    );

  await fs.promises.writeFile(
    caption,
    scene.title +
      "\n" +
      scene.text,
    "utf8"
  );

  const font =
    filterPath(
      "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
    );

  const captionFile =
    filterPath(
      caption
    );

  const vf =
    "scale=720:1280:force_original_aspect_ratio=decrease," +
    "pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=black," +
    "drawbox=x=25:y=35:w=670:h=165:color=black@0.48:t=fill," +
    `drawtext=fontfile='${font}':textfile='${captionFile}':reload=0:x=(w-text_w)/2:y=58:fontcolor=white:fontsize=31:line_spacing=8:borderw=2:bordercolor=black:shadowx=2:shadowy=2,` +
    "fade=t=in:st=0:d=0.15," +
    `fade=t=out:st=${Math.max(
      0.2,
      duration - 0.15
    )}:d=0.15`;

  const af =
    `afade=t=in:st=0:d=0.08,afade=t=out:st=${Math.max(
      0.15,
      duration - 0.10
    )}:d=0.10`;

  try {
    await exec(
      "ffmpeg",
      [
        "-y",

        "-loop",
        "1",

        "-framerate",
        "25",

        "-i",
        image,

        "-i",
        audio,

        "-t",
        String(duration),

        "-map",
        "0:v:0",

        "-map",
        "1:a:0",

        "-vf",
        vf,

        "-af",
        af,

        "-r",
        "25",

        "-c:v",
        "libx264",

        "-preset",
        "ultrafast",

        "-crf",
        "31",

        "-pix_fmt",
        "yuv420p",

        "-c:a",
        "aac",

        "-b:a",
        "128k",

        "-ar",
        "44100",

        "-shortest",

        "-movflags",
        "+faststart",

        output
      ]
    );
  } catch (error) {
    throw new Error(
      `FFmpeg cảnh ${scene.index}: ${
        error?.stderr ||
        error?.message ||
        String(error)
      }`
    );
  }

  const meta =
    await probe(output);

  const video =
    (meta.streams || [])
      .find(
        x =>
          x.codec_type ===
          "video"
      );

  const sound =
    (meta.streams || [])
      .find(
        x =>
          x.codec_type ===
          "audio"
      );

  if (
    !video ||
    !sound
  ) {
    throw new Error(
      `Cảnh ${scene.index} thiếu video hoặc âm thanh.`
    );
  }

  return {
    file: output,
    duration
  };
}

async function concat(
  files,
  output
) {
  const list =
    output + ".txt";

  const content =
    files
      .map(
        file =>
          "file '" +
          file.replace(
            /'/g,
            "'\\''"
          ) +
          "'"
      )
      .join("\n");

  await fs.promises.writeFile(
    list,
    content + "\n",
    "utf8"
  );

  try {
    await exec(
      "ffmpeg",
      [
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        list,
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        output
      ]
    );
  } finally {
    await fs.promises.rm(
      list,
      { force: true }
    );
  }

  const meta =
    await probe(output);

  const video =
    (meta.streams || [])
      .find(
        x =>
          x.codec_type ===
          "video"
      );

  const sound =
    (meta.streams || [])
      .find(
        x =>
          x.codec_type ===
          "audio"
      );

  if (
    !video ||
    !sound
  ) {
    throw new Error(
      "Video cuối bị thiếu hình hoặc tiếng."
    );
  }

  return Number(
    meta?.format?.duration || 0
  );
}

async function buildVideo(
  job,
  number
) {
  const dir =
    path.join(
      job.workDir,
      "video-" + number
    );

  await fs.promises.mkdir(
    dir,
    { recursive: true }
  );

  updateJob(job, {
    step:
      `Video ${number}/${job.count}: tìm hiểu chủ đề`,
    progress:
      Math.round(
        ((number - 1) /
          job.count) *
          10
      )
  });

  const wiki =
    await wikipedia(
      job.topic
    );

  let scenes;
  let mode = "template";

  if (
    process.env.OPENAI_API_KEY
  ) {
    try {
      scenes =
        await aiScenes(
          job.topic,
          job.duration,
          job.style
        );

      if (scenes?.length) {
        mode = "AI";
      }
    } catch (error) {
      console.warn(
        "AI fallback:",
        error?.message || error
      );
    }
  }

  if (!scenes?.length) {
    scenes =
      fallbackScenes(
        job.topic,
        job.duration,
        job.style,
        wiki,
        number
      );
  }

  const sceneFiles = [];
  let voiceEngine = "";

  for (
    let i = 0;
    i < scenes.length;
    i++
  ) {
    const scene =
      scenes[i];

    const sceneDir =
      path.join(
        dir,
        "scene-" +
          (i + 1)
      );

    await fs.promises.mkdir(
      sceneDir,
      { recursive: true }
    );

    scene.index =
      i + 1;

    updateJob(job, {
      step:
        `Video ${number}/${job.count}: cảnh ${scene.index}/${scenes.length} — tìm ảnh đúng nội dung`,
      progress:
        Math.round(
          (
            (
              number -
              1 +
              i /
                scenes.length
            ) /
            job.count
          ) *
            75
        )
    });

    const image =
      await findBestImage(
        job.topic,
        scene,
        sceneDir,
        wiki
      );

    scene.imageFile =
      image.file;

    scene.imageSource =
      image.source;

    scene.voiceFile =
      path.join(
        sceneDir,
        "voice.mp3"
      );

    voiceEngine =
      await tts(
        scene.text,
        scene.voiceFile
      );

    updateJob(job, {
      step:
        `Video ${number}/${job.count}: dựng cảnh ${scene.index}/${scenes.length}`,
      progress:
        Math.round(
          (
            (
              number -
              1 +
              (
                i +
                0.5
              ) /
                scenes.length
            ) /
            job.count
          ) *
            90
        )
    });

    const rendered =
      await renderScene(
        scene,
        sceneDir
      );

    sceneFiles.push(
      rendered.file
    );
  }

  updateJob(job, {
    step:
      `Video ${number}/${job.count}: ghép các cảnh`,
    progress:
      Math.round(
        (
          number /
          job.count
        ) *
          95
      )
  });

  const name =
    `facebook-${fileSafe(
      job.topic
    )}-${job.id}-${number}.mp4`;

  const final =
    path.join(
      OUTPUT_DIR,
      name
    );

  const duration =
    await concat(
      sceneFiles,
      final
    );

  return {
    index: number,
    file: name,
    url:
      "/output/" +
      encodeURIComponent(
        name
      ),
    duration:
      Number(
        duration.toFixed(1)
      ),
    scenes:
      sceneFiles.length,
    mode,
    voice:
      voiceEngine
  };
}

async function runJob(job) {
  updateJob(job, {
    status:
      "processing",
    step:
      "Đang bắt đầu...",
    progress: 1
  });

  for (
    let number = 1;
    number <= job.count;
    number++
  ) {
    const result =
      await buildVideo(
        job,
        number
      );

    job.outputs.push(
      result
    );
  }

  updateJob(job, {
    status:
      "done",
    step:
      "🎉 Hoàn tất tất cả video",
    progress: 100
  });
}

async function pump() {
  if (processing) {
    return;
  }

  processing = true;

  try {
    while (queue.length) {
      const id =
        queue.shift();

      const job =
        jobs.get(id);

      if (!job) {
        continue;
      }

      try {
        await runJob(job);
      } catch (error) {
        console.error(
          "VIDEO ERROR:",
          error
        );

        updateJob(job, {
          status:
            "failed",
          step:
            "❌ VIDEO LỖI",
          progress: 100,
          error:
            error?.message ||
            String(error)
        });
      }
    }
  } finally {
    processing = false;
  }
}

app.get(
  "/api/health",
  async (_req, res) => {
    res.json({
      ok: true,
      service:
        "AI VIDEO FACTORY V5",
      ffmpeg:
        await existsCommand(
          "ffmpeg"
        ),
      ffprobe:
        await existsCommand(
          "ffprobe"
        ),
      espeak:
        await existsCommand(
          "espeak-ng"
        ),
      ai:
        Boolean(
          process.env.OPENAI_API_KEY
        ),
      queue:
        queue.length,
      processing
    });
  }
);

app.post(
  "/api/generate",
  (req, res) => {
    const topic =
      text(
        req.body?.topic
      );

    const count =
      clamp(
        Number(
          req.body?.count || 1
        ),
        1,
        3
      );

    const duration =
      [15, 30, 60].includes(
        Number(
          req.body?.duration
        )
      )
        ? Number(
            req.body.duration
          )
        : 30;

    const style =
      [
        "viral",
        "knowledge",
        "story"
      ].includes(
        req.body?.style
      )
        ? req.body.style
        : "viral";

    if (!topic) {
      return res
        .status(400)
        .json({
          error:
            "Hãy nhập chủ đề."
        });
    }

    const id =
      crypto
        .randomBytes(8)
        .toString("hex");

    const work =
      path.join(
        WORK_DIR,
        id
      );

    fs.mkdirSync(
      work,
      { recursive: true }
    );

    const job = {
      id,
      topic,
      count,
      duration,
      style,
      status:
        "queued",
      step:
        "Đang xếp hàng...",
      progress: 0,
      outputs: [],
      error: null,
      mode:
        process.env.OPENAI_API_KEY
          ? "AI"
          : "template",
      workDir: work,
      createdAt:
        new Date().toISOString(),
      updatedAt:
        new Date().toISOString()
    };

    jobs.set(
      id,
      job
    );

    queue.push(
      id
    );

    pump();

    res.json({
      id,
      job:
        publicJob(job)
    });
  }
);

app.get(
  "/api/status/:id",
  (req, res) => {
    const job =
      jobs.get(
        req.params.id
      );

    if (!job) {
      return res
        .status(404)
        .json({
          error:
            "Không tìm thấy video."
        });
    }

    res.json(
      publicJob(job)
    );
  }
);

app.get(
  "/api/download/:id/:index",
  (req, res) => {
    const job =
      jobs.get(
        req.params.id
      );

    if (!job) {
      return res
        .status(404)
        .send(
          "Job không tồn tại."
        );
    }

    const index =
      Number(
        req.params.index
      );

    const output =
      (job.outputs || [])
        .find(
          x =>
            Number(
              x.index
            ) === index
        );

    if (!output) {
      return res
        .status(404)
        .send(
          "Video chưa sẵn sàng."
        );
    }

    const file =
      path.join(
        OUTPUT_DIR,
        output.file
      );

    if (
      !fs.existsSync(file)
    ) {
      return res
        .status(404)
        .send(
          "File video không còn trên Render."
        );
    }

    res.download(
      file,
      output.file
    );
  }
);

app.get(
  "/",
  (_req, res) => {
    res.type("html").send(`
<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport"
content="width=device-width,initial-scale=1">
<title>AI VIDEO FACTORY V5</title>

<style>
*{
box-sizing:border-box
}

body{
margin:0;
background:#0b1020;
color:#fff;
font-family:Arial,sans-serif
}

main{
max-width:760px;
margin:auto;
padding:20px
}

.card{
background:#121a2d;
border:1px solid #293754;
border-radius:18px;
padding:18px;
margin-bottom:16px
}

h1{
margin:0 0 8px;
font-size:25px
}

.sub{
color:#aab6cd;
line-height:1.5;
margin-bottom:18px
}

label{
display:block;
font-weight:bold;
margin:14px 0 7px
}

input,
select,
button{
width:100%;
padding:14px;
border-radius:12px;
font-size:17px
}

input,
select{
background:#081121;
color:white;
border:1px solid #34435f
}

button{
border:0;
background:#22c55e;
color:#04120a;
font-weight:bold;
margin-top:18px
}

button:disabled{
opacity:.5
}

.grid{
display:grid;
grid-template-columns:1fr 1fr;
gap:12px
}

.status{
background:#081121;
padding:14px;
border-radius:12px;
margin-top:15px
}

.bar{
height:10px;
background:#263248;
border-radius:20px;
overflow:hidden;
margin-top:10px
}

#fill{
height:100%;
width:0;
background:#38bdf8;
transition:.3s
}

#error{
display:none;
white-space:pre-wrap;
word-break:break-word;
background:#43151b;
color:#fecaca;
padding:12px;
border-radius:10px;
margin-top:12px;
font-size:13px
}

.downloads{
display:grid;
gap:10px;
margin-top:14px
}

.download{
display:block;
text-decoration:none;
background:#2563eb;
color:white;
padding:14px;
border-radius:12px;
text-align:center;
font-weight:bold
}

.note{
font-size:13px;
color:#91a2c0;
line-height:1.5;
margin-top:10px
}

@media(max-width:550px){
.grid{
grid-template-columns:1fr
}
}
</style>
</head>

<body>

<main>

<div class="card">

<h1>
🎬 AI VIDEO FACTORY V5
</h1>

<div class="sub">
Tạo video Facebook 9:16 với
nhiều cảnh, ảnh riêng,
lời thoại riêng, giọng đọc
và phụ đề.
</div>

<label>
Chủ đề
</label>

<input
id="topic"
value="Cá mập"
maxlength="160"
placeholder="Ví dụ: Cá mập, Khủng long, Ai Cập cổ đại..."
>

<div class="grid">

<div>

<label>
Số video
</label>

<select id="count">

<option value="1">
1 video
</option>

<option value="2">
2 video
</option>

<option value="3">
3 video
</option>

</select>

</div>

<div>

<label>
Thời lượng
</label>

<select id="duration">

<option value="15">
15 giây
</option>

<option value="30" selected>
30 giây
</option>

<option value="60">
60 giây
</option>

</select>

</div>

</div>

<label>
Phong cách
</label>

<select id="style">

<option value="viral">
🔥 Viral, cuốn hút
</option>

<option value="knowledge">
🧠 Kiến thức
</option>

<option value="story">
🎭 Kể chuyện
</option>

</select>

<button id="create">
🎥 TẠO VIDEO
</button>

<div class="note">
Quan trọng: hệ thống chỉ lấy ảnh
khi ảnh có liên quan tới chủ đề.
Nếu không tìm được ảnh phù hợp,
hệ thống dùng nền dự phòng thay vì
lấy đại ảnh sai nội dung.
</div>

</div>

<div
class="card"
id="result"
style="display:none"
>

<div id="status">
Đang chuẩn bị...
</div>

<div class="bar">
<div id="fill"></div>
</div>

<div id="error"></div>

<div
class="downloads"
id="downloads"
></div>

</div>

</main>

<script>
(function(){

var create =
document.getElementById("create");

var result =
document.getElementById("result");

var status =
document.getElementById("status");

var fill =
document.getElementById("fill");

var error =
document.getElementById("error");

var downloads =
document.getElementById("downloads");

var timer = null;

function poll(id){

fetch(
"/api/status/" +
encodeURIComponent(id)
)
.then(function(r){
return r.json();
})
.then(function(job){

status.textContent =
(job.step || job.status) +
" • " +
(job.progress || 0) +
"%";

fill.style.width =
(job.progress || 0) +
"%";

if(job.error){

error.style.display =
"block";

error.textContent =
job.error;

}

if(
job.outputs &&
job.outputs.length
){

downloads.innerHTML =
job.outputs.map(
function(v){

return (
'<a class="download" href="' +
v.url +
'">⬇️ TẢI VIDEO ' +
v.index +
' • ' +
v.duration +
' giây</a>'
);

}
).join("");

}

if(
job.status === "done" ||
job.status === "failed"
){

create.disabled =
false;

if(timer){
clearTimeout(timer);
timer = null;
}

return;

}

timer =
setTimeout(
function(){
poll(id);
},
1800
);

})
.catch(function(){

status.textContent =
"Mất kết nối tạm thời... đang thử lại.";

timer =
setTimeout(
function(){
poll(id);
},
2500
);

});

}

create.onclick =
function(){

var topic =
document
.getElementById("topic")
.value
.trim();

var count =
Number(
document
.getElementById("count")
.value
);

var duration =
Number(
document
.getElementById("duration")
.value
);

var style =
document
.getElementById("style")
.value;

if(!topic){

alert(
"Hãy nhập chủ đề."
);

return;

}

create.disabled =
true;

result.style.display =
"block";

status.textContent =
"Đang đưa video vào hàng đợi...";

fill.style.width =
"1%";

error.style.display =
"none";

error.textContent =
"";

downloads.innerHTML =
"";

fetch(
"/api/generate",
{
method:"POST",
headers:{
"Content-Type":
"application/json"
},
body:JSON.stringify({
topic:topic,
count:count,
duration:duration,
style:style
})
}
)
.then(function(r){
return r.json()
.then(function(data){
if(!r.ok){
throw new Error(
data.error ||
"Không tạo được video."
);
}
return data;
});
})
.then(function(data){

poll(data.id);

})
.catch(function(e){

create.disabled =
false;

status.textContent =
"Không thể tạo video.";

error.style.display =
"block";

error.textContent =
e.message ||
String(e);

});

};

})();
</script>

</body>
</html>
`);
  }
);

setInterval(
  function() {
    const limit =
      Date.now() -
      6 * 60 * 60 * 1000;

    for (
      const [id, job]
      of jobs
    ) {
      if (
        new Date(
          job.updatedAt
        ).getTime() <
        limit
      ) {
        jobs.delete(id);

        fs.rm(
          job.workDir,
          {
            recursive: true,
            force: true
          }
        ).catch(
          () => {}
        );
      }
    }
  },
  30 * 60 * 1000
);

app.listen(
  PORT,
  HOST,
  function() {

    console.log(
      "================================"
    );

    console.log(
      "AI VIDEO FACTORY V5"
    );

    console.log(
      "Server: http://" +
      HOST +
      ":" +
      PORT
    );

    console.log(
      "OpenAI: " +
      (
        process.env.OPENAI_API_KEY
          ? "ON"
          : "OFF"
      )
    );

    console.log(
      "Ready."
    );

    console.log(
      "================================"
    );
  }
);
