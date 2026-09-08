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

const MAX_JOBS = 6;

fs.mkdirSync(WORK_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

app.use(express.json({ limit: "1mb" }));
app.use("/output", express.static(OUTPUT_DIR, { maxAge: "1h" }));

const jobs = new Map();
const queue = [];
let processing = false;

const FONT_BOLD =
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

function nowIso() {
  return new Date().toISOString();
}

function safeText(value, fallback = "") {
  return String(value ?? fallback)
    .replace(/\s+/g, " ")
    .trim();
}

function cleanFileName(value) {
  return (
    safeText(value, "file")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "file"
  );
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function updateJob(job, patch) {
  Object.assign(job, patch, {
    updatedAt: nowIso(),
  });
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    step: job.step,
    progress: job.progress,
    topic: job.topic,
    count: job.count,
    duration: job.duration,
    mode: job.mode,
    outputs: job.outputs || [],
    error: job.error || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

async function runCommand(file, args, options = {}) {
  return execFileAsync(file, args, {
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
    ...options,
  });
}

async function commandExists(file) {
  try {
    await runCommand("which", [file]);
    return true;
  } catch {
    return false;
  }
}

async function ffprobeJson(file) {
  const { stdout } = await runCommand("ffprobe", [
    "-v",
    "error",
    "-show_format",
    "-show_streams",
    "-of",
    "json",
    file,
  ]);

  return JSON.parse(stdout);
}

async function mediaDuration(file) {
  const meta = await ffprobeJson(file);
  const duration = Number(meta?.format?.duration || 0);

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(
      `Không đọc được thời lượng media: ${path.basename(file)}`
    );
  }

  return duration;
}

async function assertValidImage(file) {
  const meta = await ffprobeJson(file);

  const stream = (meta.streams || []).find(
    (s) => s.codec_type === "video"
  );

  if (!stream || !stream.width || !stream.height) {
    throw new Error(
      `Ảnh không hợp lệ: ${path.basename(file)}`
    );
  }

  return {
    width: Number(stream.width),
    height: Number(stream.height),
  };
}

async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = 20000
) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} khi tải ${url}`);
    }

    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(
  url,
  options = {},
  timeoutMs = 20000
) {
  const response = await fetchWithTimeout(
    url,
    options,
    timeoutMs
  );

  return response.json();
}

async function downloadToFile(url, file, headers = {}) {
  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        "User-Agent":
          "AI-Video-Factory/4.0 (Node.js)",
        ...headers,
      },
    },
    30000
  );

  const buffer = Buffer.from(
    await response.arrayBuffer()
  );

  if (buffer.length < 500) {
    throw new Error(
      `Nội dung tải về quá nhỏ: ${url}`
    );
  }

  await fs.promises.writeFile(file, buffer);

  return buffer.length;
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function makeFallbackImage(
  file,
  title,
  subtitle = ""
) {
  const safeTitle = xmlEscape(
    String(title).slice(0, 70)
  );

  const safeSubtitle = xmlEscape(
    String(subtitle).slice(0, 100)
  );

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#111827"/>
      <stop offset="100%" stop-color="#334155"/>
    </linearGradient>
  </defs>

  <rect width="720" height="1280" fill="url(#g)"/>

  <circle
    cx="580"
    cy="180"
    r="150"
    fill="#ffffff"
    opacity="0.08"
  />

  <circle
    cx="140"
    cy="1030"
    r="220"
    fill="#ffffff"
    opacity="0.05"
  />

  <text
    x="60"
    y="560"
    fill="white"
    font-family="DejaVu Sans"
    font-size="48"
    font-weight="700"
  >${safeTitle}</text>

  <text
    x="60"
    y="635"
    fill="#cbd5e1"
    font-family="DejaVu Sans"
    font-size="28"
  >${safeSubtitle}</text>

  <text
    x="60"
    y="1190"
    fill="#94a3b8"
    font-family="DejaVu Sans"
    font-size="24"
  >AI VIDEO FACTORY</text>
</svg>`;

  const svgFile = `${file}.svg`;

  await fs.promises.writeFile(
    svgFile,
    svg,
    "utf8"
  );

  await runCommand("ffmpeg", [
    "-y",
    "-i",
    svgFile,
    "-frames:v",
    "1",
    "-vf",
    "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,setsar=1",
    file,
  ]);

  await fs.promises.rm(svgFile, {
    force: true,
  });
}

async function getWikipedia(topic) {
  const lang = "vi";

  const url = new URL(
    `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
      topic
    )}`
  );

  try {
    const response = await fetchWithTimeout(
      url,
      {
        headers: {
          "User-Agent":
            "AI-Video-Factory/4.0",
        },
      },
      12000
    );

    const data = await response.json();

    return {
      title: safeText(data?.title),
      extract: safeText(data?.extract),
      image:
        data?.originalimage?.source ||
        data?.thumbnail?.source ||
        "",
    };
  } catch {
    return {
      title: "",
      extract: "",
      image: "",
    };
  }
}

async function searchCommonsImage(query) {
  const url = new URL(
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
    "8"
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
    "1200"
  );

  const data = await fetchJson(
    url,
    {
      headers: {
        "User-Agent":
          "AI-Video-Factory/4.0",
      },
    },
    15000
  );

  const pages = Object.values(
    data?.query?.pages || {}
  );

  const candidates = pages
    .map((p) => p.imageinfo?.[0])
    .filter(
      (x) =>
        x &&
        x.thumburl &&
        /^image\//.test(x.mime || "")
    )
    .filter(
      (x) =>
        Number(x.width || 0) >= 400 &&
        Number(x.height || 0) >= 400
    )
    .slice(0, 5);

  return candidates.map((x) => ({
    url: x.thumburl || x.url,
    width: Number(x.width || 0),
    height: Number(x.height || 0),
  }));
}

function sceneQueries(
  topic,
  sceneTitle,
  keywords = []
) {
  const queries = [];

  const base = safeText(topic);
  const title = safeText(sceneTitle);

  if (title) {
    queries.push(`${base} ${title}`);
  }

  for (const keyword of keywords.slice(0, 3)) {
    queries.push(
      `${base} ${safeText(keyword)}`
    );
  }

  queries.push(base);

  return [...new Set(queries)].filter(
    Boolean
  );
}

async function acquireImage(
  topic,
  scene,
  sceneDir,
  wikipedia
) {
  const file = path.join(
    sceneDir,
    "source.jpg"
  );

  const candidates = [];

  if (
    scene.imageUrl &&
    /^https?:\/\//i.test(
      scene.imageUrl
    )
  ) {
    candidates.push(
      scene.imageUrl
    );
  }

  if (
    scene.index === 1 &&
    wikipedia.image
  ) {
    candidates.push(
      wikipedia.image
    );
  }

  const extraQueries = [];

  if (safeText(scene.imageQuery)) {
    extraQueries.push(
      safeText(scene.imageQuery)
    );
  }

  for (const query of [
    ...extraQueries,
    ...sceneQueries(
      topic,
      scene.title,
      scene.keywords
    ),
  ]) {
    try {
      const items =
        await searchCommonsImage(
          query
        );

      for (const item of items) {
        candidates.push(
          item.url
        );
      }
    } catch (error) {
      console.warn(
        "Commons search failed:",
        error?.message || error
      );
    }
  }

  const unique = [
    ...new Set(
      candidates.filter(Boolean)
    ),
  ];

  for (const url of unique.slice(0, 10)) {
    try {
      await downloadToFile(
        url,
        file
      );

      await assertValidImage(
        file
      );

      return {
        file,
        source: url,
      };
    } catch (error) {
      console.warn(
        "Image rejected:",
        error?.message || error
      );

      await fs.promises.rm(
        file,
        { force: true }
      );
    }
  }

  await makeFallbackImage(
    file,
    scene.title || topic,
    "Không tìm thấy ảnh phù hợp — dùng ảnh nền dự phòng."
  );

  await assertValidImage(
    file
  );

  return {
    file,
    source: "fallback",
  };
}

function compactVietnamese(
  text,
  maxChars = 220
) {
  let s = safeText(text)
    .replace(/\([^)]*\)/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(
      /https?:\/\/\S+/g,
      ""
    )
    .trim();

  if (s.length <= maxChars) {
    return s;
  }

  const cut = s.slice(
    0,
    maxChars
  );

  const last = Math.max(
    cut.lastIndexOf("."),
    cut.lastIndexOf("!"),
    cut.lastIndexOf("?")
  );

  return (
    last > 80
      ? cut.slice(
          0,
          last + 1
        )
      : cut
  ).trim();
}

function defaultScenes(
  topic,
  duration,
  style,
  wikipedia,
  seed
) {
  const totalSeconds =
    Number(duration);

  const count =
    totalSeconds <= 15
      ? 4
      : totalSeconds <= 30
      ? 6
      : 10;

  const extract =
    compactVietnamese(
      wikipedia.extract,
      700
    );

  const snippets = [];

  if (extract) {
    const sentences =
      extract
        .split(
          /(?<=[.!?])\s+/
        )
        .filter(Boolean);

    for (
      const sentence of sentences
    ) {
      if (
        snippets.length >= 4
      ) {
        break;
      }

      if (
        sentence.length >= 45
      ) {
        snippets.push(
          sentence
        );
      }
    }
  }

  const hook =
    style === "story"
      ? `Hãy tưởng tượng bạn đang bước vào thế giới của ${topic}. Có một điều rất dễ bị bỏ qua...`
      : `Bạn nghĩ mình biết về ${topic}? Có thể bạn sẽ bất ngờ ở điều đầu tiên này.`;

  const base = [
    {
      title: "HOOK",
      text: hook,
      keywords: [
        "overview",
        "close up",
      ],
    },
    {
      title: "ĐIỀU CỐT LÕI",
      text: `Điều quan trọng nhất: ${topic} có những đặc điểm khiến nó trở nên đáng chú ý.`,
      keywords: [
        "characteristic",
        "detail",
      ],
    },
    {
      title:
        "MỘT CHI TIẾT ĐÁNG NHỚ",
      text:
        snippets[0] ||
        `Một chi tiết thú vị về ${topic} là cách nó xuất hiện và được con người quan sát trong thực tế.`,
      keywords: [
        "detail",
        "behavior",
      ],
    },
    {
      title:
        "VÌ SAO ĐÁNG QUAN TÂM?",
      text:
        snippets[1] ||
        `${topic} không chỉ thú vị mà còn gợi ra nhiều câu hỏi về tự nhiên, lịch sử hoặc đời sống.`,
      keywords: [
        "context",
        "environment",
      ],
    },
    {
      title:
        "GÓC NHÌN BẤT NGỜ",
      text:
        snippets[2] ||
        `Điều dễ gây bất ngờ là những gì chúng ta nhìn thấy về ${topic} thường chỉ là một phần rất nhỏ của câu chuyện.`,
      keywords: [
        "surprise",
        "interesting",
      ],
    },
    {
      title: "CHỐT LẠI",
      text: `Nếu hôm nay bạn chỉ nhớ một điều về ${topic}, hãy nhớ rằng: càng tìm hiểu, càng có thêm điều đáng khám phá.`,
      keywords: [
        "summary",
        "final",
      ],
    },
    {
      title: "CTA",
      text: "Bạn muốn tôi làm video tiếp theo về chủ đề nào? Hãy để lại một bình luận.",
      keywords: [
        "social media",
        "comment",
      ],
    },
  ];

  const picked = [];

  if (count === 4) {
    picked.push(
      base[0],
      base[2],
      base[4],
      base[6]
    );
  } else if (count === 6) {
    picked.push(
      base[0],
      base[1],
      base[2],
      base[3],
      base[5],
      base[6]
    );
  } else {
    picked.push(
      base[0],
      base[1],
      base[2],
      base[3],
      base[4],
      base[2],
      base[1],
      base[3],
      base[5],
      base[6]
    );
  }

  return picked.map(
    (scene, i) => ({
      index: i + 1,
      title: scene.title,
      text: compactVietnamese(
        scene.text,
        220
      ),
      keywords:
        scene.keywords,
      imageUrl: "",
      seed,
    })
  );
}

function parseModelJson(text) {
  let s = safeText(text);

  s = s
    .replace(
      /^```(?:json)?/i,
      ""
    )
    .replace(
      /```$/i,
      ""
    )
    .trim();

  const start =
    s.indexOf("{");

  const end =
    s.lastIndexOf("}");

  if (
    start >= 0 &&
    end > start
  ) {
    s = s.slice(
      start,
      end + 1
    );
  }

  return JSON.parse(s);
}

async function aiScenes(
  topic,
  duration,
  style
) {
  const apiKey =
    safeText(
      process.env.OPENAI_API_KEY
    );

  if (!apiKey) {
    return null;
  }

  const sceneCount =
    duration <= 15
      ? 4
      : duration <= 30
      ? 6
      : 10;

  const model = safeText(
    process.env.OPENAI_SCRIPT_MODEL,
    "gpt-5.6-luna"
  );

  const prompt = `
Bạn là biên kịch video Facebook Reels bằng tiếng Việt.

Chủ đề: ${topic}
Phong cách: ${style}
Thời lượng mục tiêu: ${duration} giây
Số cảnh: ${sceneCount}

Tạo nội dung ngắn, dễ nói, có hook mạnh ở cảnh 1, mỗi cảnh 1 ý chính và cảnh cuối có CTA.

Không bịa số liệu hoặc khẳng định sự kiện cụ thể nếu không chắc chắn.

Mỗi cảnh có lời thoại ngắn, tự nhiên.
Mỗi cảnh cần title ngắn.
Mỗi cảnh cần 2-4 từ khóa tiếng Anh giúp tìm ảnh trên Wikimedia Commons.

Trả về JSON thuần theo mẫu:

{
  "scenes": [
    {
      "title": "...",
      "text": "...",
      "keywords": ["...", "..."],
      "imageQuery": "..."
    }
  ]
}
`;

  const response =
    await fetchWithTimeout(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json",
          Authorization:
            `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: prompt,
          store: false,
        }),
      },
      45000
    );

  const data =
    await response.json();

  const outputText =
    safeText(
      data?.output_text
    );

  if (!outputText) {
    throw new Error(
      "OpenAI không trả về nội dung kịch bản."
    );
  }

  const parsed =
    parseModelJson(
      outputText
    );

  if (
    !Array.isArray(
      parsed.scenes
    ) ||
    !parsed.scenes.length
  ) {
    throw new Error(
      "Kịch bản AI không đúng cấu trúc."
    );
  }

  return parsed.scenes
    .slice(0, sceneCount)
    .map(
      (
        scene,
        index
      ) => ({
        index:
          index + 1,
        title: safeText(
          scene.title,
          `CẢNH ${index + 1}`
        ),
        text:
          compactVietnamese(
            scene.text,
            260
          ),
        keywords:
          Array.isArray(
            scene.keywords
          )
            ? scene.keywords
                .map(
                  safeText
                )
                .filter(Boolean)
                .slice(0, 4)
            : [],
        imageQuery:
          safeText(
            scene.imageQuery
          ),
      })
    );
}

async function generateTTS(
  text,
  outFile,
  voice
) {
  const apiKey =
    safeText(
      process.env.OPENAI_API_KEY
    );

  if (apiKey) {
    try {
      const model =
        safeText(
          process.env.OPENAI_TTS_MODEL,
          "gpt-4o-mini-tts"
        );

      const response =
        await fetchWithTimeout(
          "https://api.openai.com/v1/audio/speech",
          {
            method: "POST",
            headers: {
              Authorization:
                `Bearer ${apiKey}`,
              "Content-Type":
                "application/json",
            },
            body: JSON.stringify({
              model,
              voice: safeText(
                process.env.OPENAI_TTS_VOICE,
                voice || "alloy"
              ),
              input: text,
              response_format:
                "mp3",
              speed: 1.03,
              instructions:
                "Nói tiếng Việt tự nhiên, rõ chữ, giọng kể ngắn gọn, năng lượng vừa phải như video Facebook/Reels.",
            }),
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
          outFile,
          buffer
        );

        await mediaDuration(
          outFile
        );

        return "openai";
      }
    } catch (error) {
      console.warn(
        "OpenAI TTS failed, fallback:",
        error?.message ||
          error
      );
    }
  }

  try {
    const url = new URL(
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
      text.slice(0, 190)
    );

    const response =
      await fetchWithTimeout(
        url,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0",
            Accept:
              "audio/mpeg,audio/*;q=0.9,*/*;q=0.8",
          },
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
        outFile,
        buffer
      );

      await mediaDuration(
        outFile
      );

      return "google";
    }
  } catch (error) {
    console.warn(
      "Google TTS failed, fallback:",
      error?.message ||
        error
    );
  }

  const espeak =
    await commandExists(
      "espeak-ng"
    );

  if (!espeak) {
    throw new Error(
      "Không có espeak-ng và TTS online đều thất bại."
    );
  }

  const wavFile =
    outFile.replace(
      /\.mp3$/i,
      ".wav"
    );

  await runCommand(
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
      wavFile,
      text,
    ]
  );

  await runCommand(
    "ffmpeg",
    [
      "-y",
      "-i",
      wavFile,
      "-ar",
      "44100",
      "-ac",
      "2",
      "-codec:a",
      "libmp3lame",
      "-b:a",
      "128k",
      outFile,
    ]
  );

  await fs.promises.rm(
    wavFile,
    { force: true }
  );

  await mediaDuration(
    outFile
  );

  return "espeak";
}

function captionFileText(
  scene
) {
  const title =
    safeText(scene.title);

  const words =
    safeText(scene.text);

  return title
    ? `${title}\n${words}`
    : words;
}

function escapeFilterPath(
  file
) {
  return file
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

async function normalizeImage(
  source,
  output
) {
  await runCommand(
    "ffmpeg",
    [
      "-y",
      "-i",
      source,
      "-vf",
      "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,setsar=1",
      "-frames:v",
      "1",
      "-q:v",
      "2",
      output,
    ]
  );

  await assertValidImage(
    output
  );
}

async function normalizeAudio(
  source,
  output
) {
  await runCommand(
    "ffmpeg",
    [
      "-y",
      "-i",
      source,
      "-vn",
      "-ar",
      "44100",
      "-ac",
      "2",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      output,
    ]
  );

  await mediaDuration(
    output
  );
}

async function renderScene(
  scene,
  sceneDir
) {
  const normalizedImage =
    path.join(
      sceneDir,
      "image.jpg"
    );

  const normalizedAudio =
    path.join(
      sceneDir,
      "audio.m4a"
    );

  const captionPath =
    path.join(
      sceneDir,
      "caption.txt"
    );

  const sceneMp4 =
    path.join(
      sceneDir,
      "scene.mp4"
    );

  await normalizeImage(
    scene.imageFile,
    normalizedImage
  );

  await normalizeAudio(
    scene.voiceFile,
    normalizedAudio
  );

  const audioDuration =
    await mediaDuration(
      normalizedAudio
    );

  const duration =
    clamp(
      audioDuration,
      1.7,
      8.0
    );

  await fs.promises.writeFile(
    captionPath,
    captionFileText(scene),
    "utf8"
  );

  const caption =
    escapeFilterPath(
      captionPath
    );

  const font =
    escapeFilterPath(
      FONT_BOLD
    );

  const filter = [
    "scale=720:1280:force_original_aspect_ratio=decrease",

    "pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=black",

    "drawbox=x=28:y=38:w=664:h=150:color=black@0.40:t=fill",

    `drawtext=fontfile='${font}':textfile='${caption}':reload=0:x=(w-text_w)/2:y=60:fontcolor=white:fontsize=33:line_spacing=7:borderw=2:bordercolor=black@0.70:shadowx=2:shadowy=2:fix_bounds=true`,

    "fade=t=in:st=0:d=0.18",

    `fade=t=out:st=${Math.max(
      0.2,
      duration - 0.18
    )}:d=0.18`,
  ].join(",");

  const audioFilter =
    `afade=t=in:st=0:d=0.08,afade=t=out:st=${Math.max(
      0.1,
      duration - 0.10
    )}:d=0.10`;

  await runCommand(
    "ffmpeg",
    [
      "-y",

      "-loop",
      "1",

      "-framerate",
      "25",

      "-i",
      normalizedImage,

      "-i",
      normalizedAudio,

      "-t",
      String(duration),

      "-vf",
      filter,

      "-af",
      audioFilter,

      "-map",
      "0:v:0",

      "-map",
      "1:a:0",

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

      "-movflags",
      "+faststart",

      "-shortest",

      sceneMp4,
    ]
  );

  const outMeta =
    await ffprobeJson(
      sceneMp4
    );

  const outVideo =
    (outMeta.streams || []).find(
      (s) =>
        s.codec_type === "video"
    );

  const outAudio =
    (outMeta.streams || []).find(
      (s) =>
        s.codec_type === "audio"
    );

  if (!outVideo || !outAudio) {
    throw new Error(
      `Scene ${scene.index} không có đủ video/audio.`
    );
  }

  return {
    file: sceneMp4,
    duration,
  };
}

async function concatScenes(
  sceneFiles,
  outputFile
) {
  const listFile =
    `${outputFile}.txt`;

  const lines =
    sceneFiles
      .map(
        (file) =>
          `file '${file.replace(
            /'/g,
            "'\\''"
          )}'`
      )
      .join("\n");

  await fs.promises.writeFile(
    listFile,
    `${lines}\n`,
    "utf8"
  );

  try {
    await runCommand(
      "ffmpeg",
      [
        "-y",

        "-f",
        "concat",

        "-safe",
        "0",

        "-i",
        listFile,

        "-c",
        "copy",

        "-movflags",
        "+faststart",

        outputFile,
      ]
    );
  } finally {
    await fs.promises.rm(
      listFile,
      { force: true }
    );
  }

  const meta =
    await ffprobeJson(
      outputFile
    );

  const video =
    (meta.streams || []).find(
      (s) =>
        s.codec_type === "video"
    );

  const audio =
    (meta.streams || []).find(
      (s) =>
        s.codec_type === "audio"
    );

  if (!video || !audio) {
    throw new Error(
      "Video ghép cuối không có đủ video/audio."
    );
  }

  return Number(
    meta?.format?.duration ||
      0
  );
}

async function processVideo(
  job,
  videoIndex
) {
  const videoDir =
    path.join(
      job.workDir,
      `video-${videoIndex}`
    );

  await fs.promises.mkdir(
    videoDir,
    { recursive: true }
  );

  const wikipedia =
    await getWikipedia(
      job.topic
    );

  updateJob(job, {
    step:
      `Đang tạo kịch bản video ${videoIndex}/${job.count}`,
    progress:
      Math.round(
        ((videoIndex - 1) /
          job.count) *
          100
      ),
  });

  let scenes = null;
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

      if (scenes) {
        mode = "ai";
      }
    } catch (error) {
      console.warn(
        "AI script failed, fallback template:",
        error?.message ||
          error
      );
    }
  }

  if (!scenes) {
    scenes =
      defaultScenes(
        job.topic,
        job.duration,
        job.style,
        wikipedia,
        `${job.id}-${videoIndex}`
      );
  }

  job.mode = mode;
  job.sceneCount =
    scenes.length;

  const sceneFiles = [];
  let ttsEngine = "";

  for (
    let i = 0;
    i < scenes.length;
    i += 1
  ) {
    const scene =
      scenes[i];

    scene.index =
      i + 1;

    if (
      !/^https?:\/\//i.test(
        safeText(
          scene.imageUrl
        )
      )
    ) {
      scene.imageUrl = "";
    }

    const sceneDir =
      path.join(
        videoDir,
        `scene-${scene.index}`
      );

    await fs.promises.mkdir(
      sceneDir,
      { recursive: true }
    );

    const globalDone =
      ((videoIndex - 1) +
        i / scenes.length) /
      job.count;

    updateJob(job, {
      step:
        `Video ${videoIndex}/${job.count} • cảnh ${scene.index}/${scenes.length}: ảnh + giọng + phụ đề`,
      progress:
        Math.round(
          globalDone * 100
        ),
    });

    const acquired =
      await acquireImage(
        job.topic,
        scene,
        sceneDir,
        wikipedia
      );

    scene.imageFile =
      acquired.file;

    scene.imageSource =
      acquired.source;

    scene.voiceFile =
      path.join(
        sceneDir,
        "voice.mp3"
      );

    ttsEngine =
      await generateTTS(
        scene.text,
        scene.voiceFile,
        process.env
          .OPENAI_TTS_VOICE ||
          "alloy"
      );

    try {
      const rendered =
        await renderScene(
          scene,
          sceneDir
        );

      sceneFiles.push(
        rendered.file
      );
    } catch (error) {
      const message =
        error?.stderr ||
        error?.message ||
        String(error);

      throw new Error(
        `Lỗi FFmpeg tại video ${videoIndex}, cảnh ${scene.index}: ${message.slice(
          -1200
        )}`
      );
    }
  }

  updateJob(job, {
    step:
      `Đang ghép ${sceneFiles.length} cảnh của video ${videoIndex}/${job.count}`,
    progress:
      Math.round(
        (videoIndex /
          job.count) *
          92
      ),
  });

  const outputName =
    `facebook-${cleanFileName(
      job.topic
    )}-${job.id}-v${videoIndex}.mp4`;

  const outputFile =
    path.join(
      OUTPUT_DIR,
      outputName
    );

  const finalDuration =
    await concatScenes(
      sceneFiles,
      outputFile
    );

  return {
    index: videoIndex,
    url:
      `/output/${encodeURIComponent(
        outputName
      )}`,
    file: outputName,
    duration: Number(
      finalDuration.toFixed(2)
    ),
    scenes:
      scenes.length,
    mode,
    tts: ttsEngine,
  };
}

async function processJob(
  job
) {
  updateJob(job, {
    status: "processing",
    step: "Bắt đầu",
    progress: 1,
  });

  for (
    let i = 1;
    i <= job.count;
    i += 1
  ) {
    const result =
      await processVideo(
        job,
        i
      );

    job.outputs.push(
      result
    );
  }

  updateJob(job, {
    status: "done",
    step: "Hoàn tất",
    progress: 100,
  });
}

async function pumpQueue() {
  if (processing) {
    return;
  }

  processing = true;

  try {
    while (queue.length) {
      const jobId =
        queue.shift();

      const job =
        jobs.get(jobId);

      if (!job) {
        continue;
      }

      try {
        await processJob(
          job
        );
      } catch (error) {
        console.error(
          "VIDEO ERROR:",
          error
        );

        updateJob(job, {
          status:
            "failed",
          step:
            "Video lỗi",
          progress: 100,
          error:
            error?.stderr ||
            error?.message ||
            String(error),
        });
      }
    }
  } finally {
    processing = false;
  }
}

app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta
  name="viewport"
  content="width=device-width, initial-scale=1"
>
<title>AI VIDEO FACTORY V4</title>

<style>
*{
  box-sizing:border-box
}

body{
  margin:0;
  background:#0b1020;
  color:#f8fafc;
  font-family:
    Arial,
    Helvetica,
    sans-serif
}

main{
  max-width:760px;
  margin:0 auto;
  padding:20px
}

.card{
  background:#121a2d;
  border:1px solid #26324a;
  border-radius:18px;
  padding:18px;
  margin-bottom:16px;
  box-shadow:
    0 12px 35px
    rgba(0,0,0,.2)
}

h1{
  font-size:26px;
  margin:0 0 8px
}

.sub{
  color:#aab6cd;
  line-height:1.5;
  margin-bottom:18px
}

.label{
  display:block;
  font-weight:700;
  margin:14px 0 7px
}

input,
select,
button{
  width:100%;
  border:0;
  border-radius:12px;
  font-size:17px;
  padding:14px
}

input,
select{
  background:#0a1222;
  color:#fff;
  border:1px solid #32415d
}

button{
  background:#22c55e;
  color:#07120b;
  font-weight:800;
  margin-top:18px;
  cursor:pointer
}

button:disabled{
  opacity:.55;
  cursor:not-allowed
}

.grid{
  display:grid;
  grid-template-columns:
    1fr 1fr;
  gap:12px
}

.status{
  margin-top:18px;
  padding:14px;
  border-radius:12px;
  background:#0a1222;
  border:1px solid #293754
}

.bar{
  height:10px;
  background:#1f2a40;
  border-radius:99px;
  overflow:hidden;
  margin-top:10px
}

.bar>div{
  height:100%;
  width:0;
  background:#60a5fa;
  transition:
    width .3s
}

.error{
  white-space:pre-wrap;
  color:#fecaca;
  background:#3a1418;
  border:1px solid #7f1d1d;
  padding:12px;
  border-radius:10px;
  margin-top:12px;
  font-size:13px;
  word-break:break-word
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
  color:#fff;
  padding:14px;
  border-radius:12px;
  text-align:center;
  font-weight:800
}

.hint{
  font-size:13px;
  color:#93a4c5;
  margin-top:10px;
  line-height:1.45
}

@media(max-width:560px){
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
      🎬 AI VIDEO FACTORY V4
    </h1>

    <div class="sub">
      Tạo video Facebook 9:16:
      chia cảnh, ảnh, giọng đọc
      và phụ đề.
      Bản này ưu tiên chạy
      ổn định trên Render.
    </div>

    <label
      class="label"
      for="topic"
    >
      Chủ đề
    </label>

    <input
      id="topic"
      maxlength="160"
      value="Cá mập"
      placeholder="Ví dụ: Cá mập, Khủng long, Bí ẩn Ai Cập..."
    >

    <div class="grid">

      <div>

        <label
          class="label"
          for="count"
        >
          Số video
        </label>

        <select id="count">
          <option value="1">
            1
          </option>
          <option value="2">
            2
          </option>
          <option value="3">
            3
          </option>
        </select>

      </div>

      <div>

        <label
          class="label"
          for="duration"
        >
          Thời lượng
        </label>

        <select id="duration">

          <option value="15">
            15 giây
          </option>

          <option
            value="30"
            selected
          >
            30 giây
          </option>

          <option value="60">
            60 giây
          </option>

        </select>

      </div>

    </div>

    <label
      class="label"
      for="style"
    >
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

    <div class="hint">
      Có OPENAI_API_KEY:
      kịch bản + giọng tự nhiên hơn.
      Không có key:
      vẫn chạy bằng Wikimedia
      + TTS dự phòng.
    </div>

  </div>

  <div
    class="card"
    id="resultCard"
    style="display:none"
  >

    <div id="statusText">
      Đang chuẩn bị...
    </div>

    <div class="bar">
      <div id="barFill"></div>
    </div>

    <div
      id="error"
      class="error"
      style="display:none"
    ></div>

    <div
      id="downloads"
      class="downloads"
    ></div>

  </div>

</main>

<script>
(function(){

  var create =
    document.getElementById(
      'create'
    );

  var resultCard =
    document.getElementById(
      'resultCard'
    );

  var statusText =
    document.getElementById(
      'statusText'
    );

  var barFill =
    document.getElementById(
      'barFill'
    );

  var errorEl =
    document.getElementById(
      'error'
    );

  var downloads =
    document.getElementById(
      'downloads'
    );

  var timer = null;

  function escapeHtml(s){

    return String(
      s || ''
    ).replace(
      /[&<>\\"]/g,
      function(c){

        return {
          '&':'&amp;',
          '<':'&lt;',
          '>':'&gt;',
          '"':'&quot;'
        }[c];

      }
    );

  }

  async function poll(
    jobId
  ){

    try{

      var res =
        await fetch(
          '/api/status/' +
          encodeURIComponent(
            jobId
          )
        );

      var job =
        await res.json();

      statusText.textContent =
        (
          job.step ||
          job.status ||
          ''
        ) +
        ' • ' +
        (
          job.progress ||
          0
        ) +
        '%';

      barFill.style.width =
        String(
          job.progress ||
          0
        ) +
        '%';

      if(job.error){

        errorEl.style.display =
          'block';

        errorEl.textContent =
          job.error;

      }

      if(
        job.outputs &&
        job.outputs.length
      ){

        downloads.innerHTML =
          job.outputs
            .map(
              function(video){

                return (
                  '<a class="download" href="' +
                  video.url +
                  '">⬇️ TẢI VIDEO ' +
                  video.index +
                  ' • ' +
                  escapeHtml(
                    video.duration
                  ) +
                  's</a>'
                );

              }
            )
            .join('');

      }

      if(
        job.status === 'done' ||
        job.status === 'failed'
      ){

        create.disabled =
          false;

        if(timer){

          clearTimeout(
            timer
          );

          timer = null;

        }

        return;

      }

      timer =
        setTimeout(
          function(){

            poll(jobId);

          },
          1800
        );

    }catch(e){

      statusText.textContent =
        'Mất kết nối tạm thời, đang thử lại...';

      timer =
        setTimeout(
          function(){

            poll(jobId);

          },
          2500
        );

    }

  }

  create.addEventListener(
    'click',
    async function(){

      var topic =
        document
          .getElementById(
            'topic'
          )
          .value
          .trim();

      var count =
        Number(
          document
            .getElementById(
              'count'
            )
            .value
        );

      var duration =
        Number(
          document
            .getElementById(
              'duration'
            )
            .value
        );

      var style =
        document
          .getElementById(
            'style'
          )
          .value;

      if(!topic){

        alert(
          'Hãy nhập chủ đề.'
        );

        return;

      }

      create.disabled =
        true;

      resultCard.style.display =
        'block';

      statusText.textContent =
        'Đang đưa video vào hàng đợi...';

      barFill.style.width =
        '1%';

      errorEl.style.display =
        'none';

      errorEl.textContent =
        '';

      downloads.innerHTML =
        '';

      try{

        var res =
          await fetch(
            '/api/generate',
            {
              method:
                'POST',

              headers:{
                'Content-Type':
                  'application/json'
              },

              body:
                JSON.stringify({
                  topic:topic,
                  count:count,
                  duration:duration,
                  style:style
                })
            }
          );

        var data =
          await res.json();

        if(!res.ok){

          throw new Error(
            data.error ||
            'Không tạo được job.'
          );

        }

        poll(data.id);

      }catch(e){

        create.disabled =
          false;

        statusText.textContent =
          'Không thể tạo video';

        errorEl.style.display =
          'block';

        errorEl.textContent =
          e.message ||
          String(e);

      }

    }
  );

})();
</script>

</body>
</html>`);
});

app.get(
  "/api/health",
  async (_req, res) => {

    let ffmpeg = false;
    let ffprobe = false;
    let espeak = false;

    try {
      ffmpeg =
        await commandExists(
          "ffmpeg"
        );
    } catch {}

    try {
      ffprobe =
        await commandExists(
          "ffprobe"
        );
    } catch {}

    try {
      espeak =
        await commandExists(
          "espeak-ng"
        );
    } catch {}

    res.json({
      ok: true,
      service:
        "ai-video-factory-v4",
      time: nowIso(),
      ffmpeg,
      ffprobe,
      espeak,
      openai:
        Boolean(
          process.env
            .OPENAI_API_KEY
        ),
      queue:
        queue.length,
      processing,
    });
  }
);

app.post(
  "/api/generate",
  (req, res) => {

    if (
      jobs.size >=
      MAX_JOBS
    ) {

      return res
        .status(429)
        .json({
          error:
            "Máy đang có quá nhiều job. Chờ job hiện tại hoàn tất rồi thử lại.",
        });

    }

    const topic =
      safeText(
        req.body?.topic
      );

    const count =
      clamp(
        Number(
          req.body?.count ||
            1
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
        "story",
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
            "Chưa nhập chủ đề.",
        });
    }

    const id =
      crypto.randomBytes(
        8
      ).toString("hex");

    const jobWorkDir =
      path.join(
        WORK_DIR,
        id
      );

    fs.mkdirSync(
      jobWorkDir,
      {
        recursive: true,
      }
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
        "Đang chờ...",

      progress: 0,

      outputs: [],

      error: null,

      mode:
        process.env
          .OPENAI_API_KEY
          ? "ai"
          : "template",

      workDir:
        jobWorkDir,

      createdAt:
        nowIso(),

      updatedAt:
        nowIso(),
    };

    jobs.set(
      id,
      job
    );

    queue.push(id);

    pumpQueue();

    return res.json({
      id,
      job:
        publicJob(
          job
        ),
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
            "Không tìm thấy job.",
        });
    }

    res.json(
      publicJob(
        job
      )
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
      (
        job.outputs ||
        []
      ).find(
        (x) =>
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
      !fs.existsSync(
        file
      )
    ) {
      return res
        .status(404)
        .send(
          "File video không còn trên máy chủ."
        );
    }

    res.download(
      file,
      output.file
    );
  }
);

setInterval(
  () => {

    const cutoff =
      Date.now() -
      6 *
        60 *
        60 *
        1000;

    for (
      const [id, job] of
      jobs
    ) {

      if (
        new Date(
          job.updatedAt
        ).getTime() <
        cutoff
      ) {

        jobs.delete(
          id
        );

        fs.rm(
          job.workDir,
          {
            recursive:true,
            force:true
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
  () => {

    console.log(
      "================================"
    );

    console.log(
      " AI VIDEO FACTORY V4"
    );

    console.log(
      "================================"
    );

    console.log(
      "Server: http://" +
      HOST +
      ":" +
      PORT
    );

    console.log(
      "AI script: " +
      (
        process.env
          .OPENAI_API_KEY
          ? "ON"
          : "OFF"
      )
    );

    console.log(
      "AI TTS: " +
      (
        process.env
          .OPENAI_API_KEY
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
