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

/* =========================================================
   BLOCK DANH SÁCH TỪ KHÓA KHÔNG MONG MUỐN
   ========================================================= */

const BAD_IMAGE_WORDS = [
  "train",
  "railway",
  "railroad",
  "station",
  "subway",
  "metro",
  "tram",
  "building",
  "school",
  "hospital",
  "museum",
  "church",
  "cathedral",
  "map",
  "atlas",
  "bridge",
  "road",
  "highway",
  "airport",
  "airplane",
  "bus",
  "car",
  "ship",
  "boat",
  "harbor",
  "port",
  "factory",
  "house",
  "castle"
];

/* =========================================================
   TIỆN ÍCH
   ========================================================= */

function clean(value, fallback = "") {
  return String(value ?? fallback)
    .replace(/\s+/g, " ")
    .trim();
}

function clamp(value, min, max) {
  return Math.max(
    min,
    Math.min(max, value)
  );
}

function safeFileName(value) {
  return (
    clean(value, "video")
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

async function commandExists(command) {
  try {
    await exec("which", [command]);
    return true;
  } catch {
    return false;
  }
}

/* =========================================================
   HTTP
   ========================================================= */

async function http(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(
      url,
      {
        ...options,
        signal: controller.signal
      }
    );

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function httpJson(
  url,
  options = {},
  timeoutMs = 20000
) {
  const response = await http(
    url,
    options,
    timeoutMs
  );

  return response.json();
}

async function downloadFile(
  url,
  output
) {
  const response = await http(
    url,
    {
      headers: {
        "User-Agent":
          "Mozilla/5.0 AI-Video-Factory/6.0"
      }
    },
    30000
  );

  const buffer =
    Buffer.from(
      await response.arrayBuffer()
    );

  if (buffer.length < 1000) {
    throw new Error(
      "File ảnh tải về quá nhỏ."
    );
  }

  await fs.promises.writeFile(
    output,
    buffer
  );
}

/* =========================================================
   FFMPEG / FFPROBE
   ========================================================= */

async function probe(file) {
  const { stdout } =
    await exec(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_format",
        "-show_streams",
        "-of",
        "json",
        file
      ]
    );

  return JSON.parse(stdout);
}

async function mediaDuration(file) {
  const meta =
    await probe(file);

  const duration =
    Number(
      meta?.format?.duration || 0
    );

  if (
    !Number.isFinite(duration) ||
    duration <= 0
  ) {
    throw new Error(
      `Không đọc được thời lượng: ${path.basename(file)}`
    );
  }

  return duration;
}

async function validateImage(file) {
  const meta =
    await probe(file);

  const stream =
    (meta.streams || []).find(
      item =>
        item.codec_type === "video"
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

/* =========================================================
   WIKIPEDIA
   ========================================================= */

async function wikiSearch(
  topic,
  language
) {
  const api =
    `https://${language}.wikipedia.org/w/api.php`;

  const url =
    new URL(api);

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
    "list",
    "search"
  );

  url.searchParams.set(
    "srsearch",
    topic
  );

  url.searchParams.set(
    "srlimit",
    "1"
  );

  try {
    const data =
      await httpJson(
        url,
        {
          headers: {
            "User-Agent":
              "AI-Video-Factory/6.0"
          }
        },
        12000
      );

    return (
      data?.query?.search?.[0]
        ?.title || ""
    );
  } catch {
    return "";
  }
}

async function wikiSummary(
  title,
  language
) {
  if (!title) {
    return {
      title: "",
      extract: "",
      image: ""
    };
  }

  const url =
    `https://${language}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
      title
    )}`;

  try {
    const data =
      await httpJson(
        url,
        {
          headers: {
            "User-Agent":
              "AI-Video-Factory/6.0"
          }
        },
        15000
      );

    return {
      title:
        clean(data?.title),
      extract:
        clean(data?.extract),
      image:
        data?.originalimage
          ?.source ||
        data?.thumbnail
          ?.source ||
        ""
    };
  } catch {
    return {
      title: clean(title),
      extract: "",
      image: ""
    };
  }
}

async function getTopicKnowledge(
  topic
) {
  const viTitle =
    await wikiSearch(
      topic,
      "vi"
    );

  const vi =
    await wikiSummary(
      viTitle || topic,
      "vi"
    );

  const enTitle =
    await wikiSearch(
      topic,
      "en"
    );

  const en =
    await wikiSummary(
      enTitle,
      "en"
    );

  return {
    viTitle:
      vi.title ||
      viTitle,

    enTitle:
      en.title ||
      enTitle ||
      topic,

    extract:
      vi.extract ||
      en.extract ||
      "",

    image:
      vi.image ||
      en.image ||
      ""
  };
}

/* =========================================================
   TÁCH CÂU
   ========================================================= */

function splitSentences(value) {
  return clean(value)
    .replace(
      /\[[^\]]+\]/g,
      ""
    )
    .split(
      /(?<=[.!?。！？])\s+/
    )
    .map(clean)
    .filter(
      item =>
        item.length >= 35
    );
}

function shortenText(
  value,
  maxChars = 150
) {
  const valueClean =
    clean(value);

  if (
    valueClean.length <=
    maxChars
  ) {
    return valueClean;
  }

  const cut =
    valueClean.slice(
      0,
      maxChars
    );

  const position =
    Math.max(
      cut.lastIndexOf("."),
      cut.lastIndexOf(","),
      cut.lastIndexOf(" ")
    );

  if (position > 70) {
    return (
      cut
        .slice(
          0,
          position
        )
        .trim() +
      "."
    );
  }

  return cut.trim() + ".";
}

/* =========================================================
   XÁC ĐỊNH LOẠI CHỦ ĐỀ
   ========================================================= */

function domainTerms(
  topic,
  englishTitle
) {
  const value =
    `${topic} ${englishTitle}`
      .toLowerCase();

  if (
    /shark|cá mập/.test(value)
  ) {
    return [
      "shark",
      "ocean"
    ];
  }

  if (
    /dinosaur|khủng long/.test(
      value
    )
  ) {
    return [
      "dinosaur",
      "fossil"
    ];
  }

  if (
    /whale|cá voi/.test(value)
  ) {
    return [
      "whale",
      "ocean"
    ];
  }

  if (
    /elephant|con voi|voi/.test(
      value
    )
  ) {
    return [
      "elephant",
      "wildlife"
    ];
  }

  if (
    /tiger|hổ/.test(value)
  ) {
    return [
      "tiger",
      "wildlife"
    ];
  }

  if (
    /lion|sư tử/.test(value)
  ) {
    return [
      "lion",
      "wildlife"
    ];
  }

  if (
    /snake|rắn/.test(value)
  ) {
    return [
      "snake",
      "wildlife"
    ];
  }

  if (
    /eagle|đại bàng/.test(
      value
    )
  ) {
    return [
      "eagle",
      "bird"
    ];
  }

  if (
    /egypt|ai cập/.test(
      value
    )
  ) {
    return [
      "egypt",
      "ancient egypt"
    ];
  }

  if (
    /vietnam|việt nam/.test(
      value
    )
  ) {
    return [
      "vietnam",
      "vietnam landscape"
    ];
  }

  if (
    /tree|cây/.test(value)
  ) {
    return [
      "tree",
      "plant"
    ];
  }

  if (
    /rice|lúa|gạo/.test(value)
  ) {
    return [
      "rice",
      "rice field"
    ];
  }

  const words =
    clean(
      englishTitle ||
      topic
    )
      .split(
        /[^a-zA-Z0-9]+/
      )
      .filter(
        x =>
          x.length > 2
      )
      .slice(0, 5);

  return words;
}

/* =========================================================
   XÁC ĐỊNH TỪ KHÓA ẢNH THEO NỘI DUNG CẢNH
   ========================================================= */

function sceneModifier(
  scene,
  topic,
  englishTitle
) {
  const sceneText =
    `${scene.title} ${scene.text}`
      .toLowerCase();

  const topicText =
    `${topic} ${englishTitle}`
      .toLowerCase();

  if (
    /răng|tooth|teeth/.test(
      sceneText
    )
  ) {
    return "teeth close up";
  }

  if (
    /mắt|eye/.test(
      sceneText
    )
  ) {
    return "eye close up";
  }

  if (
    /da|skin/.test(
      sceneText
    )
  ) {
    return "skin close up";
  }

  if (
    /xương|bone/.test(
      sceneText
    )
  ) {
    return "skeleton";
  }

  if (
    /hóa thạch|fossil/.test(
      sceneText
    )
  ) {
    return "fossil";
  }

  if (
    /săn|con mồi|hunt|prey/.test(
      sceneText
    )
  ) {
    return "hunting";
  }

  if (
    /ăn|ăn thịt|feeding|eat/.test(
      sceneText
    )
  ) {
    return "feeding";
  }

  if (
    /sống|môi trường|habitat|environment/.test(
      sceneText
    )
  ) {
    return "habitat";
  }

  if (
    /lịch sử|history|ancient|cổ đại/.test(
      sceneText
    )
  ) {
    return "historical";
  }

  if (
    /việt nam|vietnam/.test(
      topicText
    )
  ) {
    return "vietnam landscape";
  }

  if (
    /ai cập|egypt/.test(
      topicText
    )
  ) {
    return "ancient egypt";
  }

  if (
    /cá mập|shark/.test(
      topicText
    )
  ) {
    return "shark underwater";
  }

  return "real photo";
}

/* =========================================================
   WIKIMEDIA COMMONS
   ========================================================= */

async function commonsSearch(
  query
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
    "1200"
  );

  const data =
    await httpJson(
      url,
      {
        headers: {
          "User-Agent":
            "AI-Video-Factory/6.0"
        }
      },
      15000
    );

  return Object.values(
    data?.query?.pages || {}
  )
    .map(page => {
      const info =
        page?.imageinfo?.[0];

      if (!info) {
        return null;
      }

      if (
        !info.thumburl
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

      if (
        Number(info.width || 0) <
          400 ||
        Number(info.height || 0) <
          400
      ) {
        return null;
      }

      return {
        title:
          clean(page.title),
        url:
          info.thumburl
      };
    })
    .filter(Boolean);
}

/* =========================================================
   CHẤM ĐIỂM ẢNH
   ========================================================= */

function containsBadImageWord(
  title
) {
  const value =
    title.toLowerCase();

  return BAD_IMAGE_WORDS.some(
    word =>
      value.includes(
        word
      )
  );
}

function scoreCandidate(
  title,
  topic,
  englishTitle,
  scene
) {
  const lower =
    title.toLowerCase();

  if (
    containsBadImageWord(
      title
    )
  ) {
    return -100;
  }

  const terms =
    domainTerms(
      topic,
      englishTitle
    );

  let score = 0;

  for (
    const term of terms
  ) {
    if (
      lower.includes(
        term.toLowerCase()
      )
    ) {
      score += 5;
    }
  }

  const modifier =
    sceneModifier(
      scene,
      topic,
      englishTitle
    );

  for (
    const word of modifier
      .toLowerCase()
      .split(/\s+/)
  ) {
    if (
      word.length > 3 &&
      lower.includes(word)
    ) {
      score += 2;
    }
  }

  return score;
}

/* =========================================================
   ẢNH DỰ PHÒNG
   ========================================================= */

function escapeXml(value) {
  return String(value)
    .replace(
      /&/g,
      "&amp;"
    )
    .replace(
      /</g,
      "&lt;"
    )
    .replace(
      />/g,
      "&gt;"
    )
    .replace(
      /"/g,
      "&quot;"
    )
    .replace(
      /'/g,
      "&apos;"
    );
}

async function makeFallbackImage(
  output,
  title,
  subtitle
) {
  const svgContent =
    `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     width="720"
     height="1280">
  <defs>
    <linearGradient id="bg"
                    x1="0"
                    y1="0"
                    x2="1"
                    y2="1">
      <stop offset="0%"
            stop-color="#07111f"/>
      <stop offset="100%"
            stop-color="#23456b"/>
    </linearGradient>
  </defs>

  <rect width="720"
        height="1280"
        fill="url(#bg)"/>

  <circle
    cx="610"
    cy="170"
    r="180"
    fill="white"
    opacity=".06"/>

  <circle
    cx="100"
    cy="1090"
    r="240"
    fill="white"
    opacity=".04"/>

  <text
    x="50"
    y="530"
    fill="white"
    font-family="DejaVu Sans"
    font-size="44"
    font-weight="bold">${escapeXml(
      title
    )}</text>

  <text
    x="50"
    y="615"
    fill="#dbeafe"
    font-family="DejaVu Sans"
    font-size="25">${escapeXml(
      subtitle
    )}</text>

  <text
    x="50"
    y="1190"
    fill="#93c5fd"
    font-family="DejaVu Sans"
    font-size="22">AI VIDEO FACTORY</text>
</svg>`;

  const svgFile =
    output + ".svg";

  await fs.promises.writeFile(
    svgFile,
    svgContent,
    "utf8"
  );

  await exec(
    "ffmpeg",
    [
      "-y",
      "-i",
      svgFile,
      "-frames:v",
      "1",
      output
    ]
  );

  await fs.promises.rm(
    svgFile,
    {
      force: true
    }
  );
}

/* =========================================================
   LẤY ẢNH ĐÚNG CẢNH
   ========================================================= */

async function acquireSceneImage(
  topic,
  knowledge,
  scene,
  sceneDir
) {
  const output =
    path.join(
      sceneDir,
      "source.jpg"
    );

  /*
   CẢNH 1:
   Ưu tiên ảnh chính Wikipedia vì chắc chắn đúng chủ đề.
  */

  if (
    scene.index === 1 &&
    knowledge.image
  ) {
    try {
      await downloadFile(
        knowledge.image,
        output
      );

      await validateImage(
        output
      );

      return {
        file: output,
        source:
          knowledge.image,
        matched: true
      };
    } catch {
      await fs.promises.rm(
        output,
        { force: true }
      );
    }
  }

  const englishTitle =
    knowledge.enTitle ||
    topic;

  const modifier =
    sceneModifier(
      scene,
      topic,
      englishTitle
    );

  const queries = [
    `${englishTitle} ${modifier}`,
    `${englishTitle} real photo`,
    `${englishTitle}`
  ];

  let best = null;

  for (
    const query of
    [...new Set(queries)]
  ) {
    try {
      const results =
        await commonsSearch(
          query
        );

      for (
        const candidate of
        results
      ) {
        const score =
          scoreCandidate(
            candidate.title,
            topic,
            englishTitle,
            scene
          );

        if (
          score < 1
        ) {
          continue;
        }

        if (
          !best ||
          score >
            best.score
        ) {
          best = {
            ...candidate,
            score
          };
        }
      }

      /*
       Nếu đã có ảnh điểm cao,
       không cần tìm linh tinh nữa.
      */

      if (
        best &&
        best.score >= 7
      ) {
        break;
      }
    } catch (error) {
      console.warn(
        "Commons search:",
        error?.message ||
          error
      );
    }
  }

  /*
   Nếu ảnh được xác định đủ tốt -> dùng.
  */

  if (best) {
    try {
      await downloadFile(
        best.url,
        output
      );

      await validateImage(
        output
      );

      return {
        file: output,
        source:
          best.url,
        matched: true
      };
    } catch {
      await fs.promises.rm(
        output,
        {
          force: true
        }
      );
    }
  }

  /*
   Không chắc -> KHÔNG lấy ảnh bừa.
   Dùng lại ảnh chính của chủ đề.
  */

  if (
    knowledge.image
  ) {
    try {
      await downloadFile(
        knowledge.image,
        output
      );

      await validateImage(
        output
      );

      return {
        file: output,
        source:
          knowledge.image,
        matched: false
      };
    } catch {
      await fs.promises.rm(
        output,
        {
          force: true
        }
      );
    }
  }

  /*
   Không còn ảnh nào -> nền dự phòng.
  */

  await makeFallbackImage(
    output,
    scene.title ||
      topic,
    "Ảnh dự phòng đúng chủ đề"
  );

  await validateImage(
    output
  );

  return {
    file: output,
    source:
      "fallback",
    matched: false
  };
}

/* =========================================================
   LẬP KỊCH BẢN AN TOÀN
   ========================================================= */

function buildScenes(
  topic,
  duration,
  style,
  knowledge
) {
  const sceneCount =
    duration <= 15
      ? 4
      : duration <= 30
      ? 6
      : 8;

  const facts =
    splitSentences(
      knowledge.extract
    ).map(
      sentence =>
        shortenText(
          sentence,
          145
        )
    );

  let hook = "";

  if (
    style === "knowledge"
  ) {
    hook =
      `Có một số điều rất đáng biết về ${topic} mà không phải ai cũng rõ.`;
  } else if (
    style === "story"
  ) {
    hook =
      `Hãy cùng khám phá ${topic} qua những chi tiết thú vị nhất.`;
  } else {
    hook =
      `Bạn tưởng mình đã biết về ${topic}? Đây là điều nhiều người dễ bỏ qua.`;
  }

  const scenes = [];

  scenes.push({
    index: 1,
    title: "HOOK",
    text: shortenText(
      hook,
      145
    )
  });

  for (
    const fact of facts
  ) {
    if (
      scenes.length >=
      sceneCount - 1
    ) {
      break;
    }

    scenes.push({
      index:
        scenes.length + 1,
      title:
        `ĐIỀU ${scenes.length}`,
      text:
        fact
    });
  }

  /*
   Nếu Wikipedia ít dữ liệu,
   dùng câu trung tính thay vì bịa facts.
  */

  while (
    scenes.length <
    sceneCount - 1
  ) {
    scenes.push({
      index:
        scenes.length + 1,
      title:
        "ĐIỀU ĐÁNG NHỚ",
      text:
        `Chủ đề ${topic} còn nhiều khía cạnh đáng khám phá. Với những thông tin cụ thể, nên kiểm tra nguồn trước khi tin.`
    });
  }

  scenes.push({
    index:
      scenes.length + 1,
    title:
      "CTA",
    text:
      "Bạn muốn xem video tiếp theo về chủ đề nào? Hãy bình luận ngay bên dưới."
  });

  return scenes;
}

/* =========================================================
   TTS
   ========================================================= */

async function generateTTS(
  content,
  output
) {
  /*
   Thử Google TTS trước.
  */

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
      content.slice(
        0,
        190
      )
    );

    const response =
      await http(
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
  } catch (
    error
  ) {
    console.warn(
      "Google TTS:",
      error?.message ||
        error
    );
  }

  /*
   Fallback eSpeak.
  */

  if (
    !(await commandExists(
      "espeak-ng"
    ))
  ) {
    throw new Error(
      "Không có TTS khả dụng."
    );
  }

  const wavFile =
    output.replace(
      /\.mp3$/i,
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
      wavFile,
      content
    ]
  );

  await exec(
    "ffmpeg",
    [
      "-y",
      "-i",
      wavFile,
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
    wavFile,
    {
      force: true
    }
  );

  await mediaDuration(
    output
  );

  return "espeak";
}

/* =========================================================
   CHUẨN HÓA ẢNH
   ========================================================= */

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

/* =========================================================
   CHUẨN HÓA AUDIO
   ========================================================= */

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

/* =========================================================
   ESCAPE FILTER PATH
   ========================================================= */

function escapeFilterPath(
  file
) {
  return file
    .replace(
      /\\/g,
      "\\\\"
    )
    .replace(
      /:/g,
      "\\:"
    )
    .replace(
      /'/g,
      "\\'"
    );
}

/* =========================================================
   CHIA DÒNG PHỤ ĐỀ
   ========================================================= */

function wrapCaption(
  value,
  maxChars = 30,
  maxLines = 3
) {
  const words =
    clean(value)
      .split(/\s+/);

  const lines = [];
  let line = "";

  for (
    const word of words
  ) {
    const candidate =
      line
        ? `${line} ${word}`
        : word;

    if (
      candidate.length <=
      maxChars
    ) {
      line =
        candidate;
      continue;
    }

    if (line) {
      lines.push(
        line
      );
    }

    line =
      word;

    if (
      lines.length >=
      maxLines - 1
    ) {
      break;
    }
  }

  if (
    line &&
    lines.length <
      maxLines
  ) {
    lines.push(
      line
    );
  }

  return lines.join(
    "\n"
  );
}

/* =========================================================
   DỰNG TỪNG CẢNH
   ========================================================= */

async function renderScene(
  scene,
  sceneDir
) {
  const imageFile =
    path.join(
      sceneDir,
      "image.jpg"
    );

  const audioFile =
    path.join(
      sceneDir,
      "audio.m4a"
    );

  const captionFile =
    path.join(
      sceneDir,
      "caption.txt"
    );

  const outputFile =
    path.join(
      sceneDir,
      "scene.mp4"
    );

  await normalizeImage(
    scene.imageFile,
    imageFile
  );

  await normalizeAudio(
    scene.voiceFile,
    audioFile
  );

  const audioDuration =
    await mediaDuration(
      audioFile
    );

  const duration =
    clamp(
      audioDuration,
      1.5,
      8
    );

  const caption =
    wrapCaption(
      `${scene.title}\n${scene.text}`,
      31,
      4
    );

  await fs.promises.writeFile(
    captionFile,
    caption,
    "utf8"
  );

  const font =
    escapeFilterPath(
      "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
    );

  const captionPath =
    escapeFilterPath(
      captionFile
    );

  const videoFilter =
    [
      "scale=720:1280:force_original_aspect_ratio=decrease",
      "pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=black",

      "drawbox=x=18:y=25:w=684:h=275:color=black@0.48:t=fill",

      `drawtext=fontfile='${font}':textfile='${captionPath}':reload=0:x=(w-text_w)/2:y=52:fontcolor=white:fontsize=30:line_spacing=8:borderw=2:bordercolor=black:shadowx=2:shadowy=2`,

      "fade=t=in:st=0:d=0.12",

      `fade=t=out:st=${Math.max(
        0.2,
        duration - 0.12
      )}:d=0.12`
    ].join(",");

  const audioFilter =
    `afade=t=in:st=0:d=0.06,afade=t=out:st=${Math.max(
      0.12,
      duration - 0.08
    )}:d=0.08`;

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
        imageFile,

        "-i",
        audioFile,

        "-t",
        String(duration),

        "-map",
        "0:v:0",

        "-map",
        "1:a:0",

        "-vf",
        videoFilter,

        "-af",
        audioFilter,

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

        outputFile
      ]
    );
  } catch (
    error
  ) {
    throw new Error(
      `FFmpeg cảnh ${scene.index}: ${
        error?.stderr ||
        error?.message ||
        String(error)
      }`
    );
  }

  const meta =
    await probe(
      outputFile
    );

  const video =
    (meta.streams || [])
      .find(
        item =>
          item.codec_type ===
          "video"
      );

  const audio =
    (meta.streams || [])
      .find(
        item =>
          item.codec_type ===
          "audio"
      );

  if (
    !video ||
    !audio
  ) {
    throw new Error(
      `Cảnh ${scene.index} thiếu hình hoặc tiếng.`
    );
  }

  return {
    file: outputFile,
    duration
  };
}

/* =========================================================
   GHÉP CÁC CẢNH
   ========================================================= */

async function concatScenes(
  files,
  output
) {
  const listFile =
    output +
    ".txt";

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
      .join("\n") +
    "\n";

  await fs.promises.writeFile(
    listFile,
    content,
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
        listFile,
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        output
      ]
    );
  } finally {
    await fs.promises.rm(
      listFile,
      {
        force: true
      }
    );
  }

  const meta =
    await probe(
      output
    );

  const video =
    (meta.streams || [])
      .find(
        item =>
          item.codec_type ===
          "video"
      );

  const audio =
    (meta.streams || [])
      .find(
        item =>
          item.codec_type ===
          "audio"
      );

  if (
    !video ||
    !audio
  ) {
    throw new Error(
      "Video cuối thiếu hình hoặc tiếng."
    );
  }

  return Number(
    meta?.format?.duration ||
      0
  );
}

/* =========================================================
   TẠO 1 VIDEO
   ========================================================= */

async function buildVideo(
  job,
  number
) {
  const videoDir =
    path.join(
      job.workDir,
      `video-${number}`
    );

  await fs.promises.mkdir(
    videoDir,
    {
      recursive: true
    }
  );

  updateJob(
    job,
    {
      step:
        `Video ${number}/${job.count}: phân tích chủ đề`,
      progress:
        Math.round(
          (
            (number - 1) /
            job.count
          ) *
            10
        )
    }
  );

  const knowledge =
    await getTopicKnowledge(
      job.topic
    );

  /*
   Tạo lời thoại từ kiến thức của chính chủ đề.
  */

  const scenes =
    buildScenes(
      job.topic,
      job.duration,
      job.style,
      knowledge
    );

  const sceneFiles = [];

  let ttsEngine = "";

  for (
    let i = 0;
    i < scenes.length;
    i++
  ) {
    const scene =
      scenes[i];

    const sceneDir =
      path.join(
        videoDir,
        `scene-${scene.index}`
      );

    await fs.promises.mkdir(
      sceneDir,
      {
        recursive: true
      }
    );

    updateJob(
      job,
      {
        step:
          `Video ${number}/${job.count}: cảnh ${scene.index}/${scenes.length} — tìm ảnh đúng nội dung`,
        progress:
          Math.round(
            (
              (
                number -
                1
              ) +
              i /
                scenes.length
            ) /
              job.count *
              65
          )
      }
    );

    /*
     Quan trọng:
     ảnh được chọn dựa trên CHÍNH lời thoại của cảnh.
    */

    const image =
      await acquireSceneImage(
        job.topic,
        knowledge,
        scene,
        sceneDir
      );

    scene.imageFile =
      image.file;

    scene.imageSource =
      image.source;

    scene.imageMatched =
      image.matched;

    scene.voiceFile =
      path.join(
        sceneDir,
        "voice.mp3"
      );

    /*
     TTS đúng lời thoại của cảnh.
    */

    ttsEngine =
      await generateTTS(
        scene.text,
        scene.voiceFile
      );

    updateJob(
      job,
      {
        step:
          `Video ${number}/${job.count}: cảnh ${scene.index}/${scenes.length} — ghép hình + tiếng + phụ đề`,
        progress:
          Math.round(
            (
              (
                number -
                1
              ) +
              (
                i +
                0.6
              ) /
                scenes.length
            ) /
              job.count *
              90
          )
      }
    );

    const rendered =
      await renderScene(
        scene,
        sceneDir
      );

    sceneFiles.push(
      rendered.file
    );
  }

  updateJob(
    job,
    {
      step:
        `Video ${number}/${job.count}: ghép ${sceneFiles.length} cảnh`,
      progress:
        Math.round(
          (
            number /
            job.count
          ) *
            96
        )
    }
  );

  const fileName =
    `facebook-${safeFileName(
      job.topic
    )}-${job.id}-${number}.mp4`;

  const output =
    path.join(
      OUTPUT_DIR,
      fileName
    );

  const finalDuration =
    await concatScenes(
      sceneFiles,
      output
    );

  return {
    index:
      number,

    file:
      fileName,

    url:
      `/output/${encodeURIComponent(
        fileName
      )}`,

    duration:
      Number(
        finalDuration.toFixed(
          1
        )
      ),

    scenes:
      sceneFiles.length,

    mode:
      "topic-safe",

    voice:
      ttsEngine
  };
}

/* =========================================================
   CHẠY JOB
   ========================================================= */

async function processJob(
  job
) {
  updateJob(
    job,
    {
      status:
        "processing",
      step:
        "Đang bắt đầu...",
      progress:
        1
    }
  );

  for (
    let i = 1;
    i <= job.count;
    i++
  ) {
    const result =
      await buildVideo(
        job,
        i
      );

    job.outputs.push(
      result
    );
  }

  updateJob(
    job,
    {
      status:
        "done",
      step:
        "🎉 Hoàn tất",
      progress:
        100
    }
  );
}

/* =========================================================
   HÀNG ĐỢI
   ========================================================= */

async function pump() {
  if (processing) {
    return;
  }

  processing = true;

  try {
    while (
      queue.length
    ) {
      const id =
        queue.shift();

      const job =
        jobs.get(id);

      if (!job) {
        continue;
      }

      try {
        await processJob(
          job
        );
      } catch (
        error
      ) {
        console.error(
          "VIDEO ERROR:",
          error
        );

        updateJob(
          job,
          {
            status:
              "failed",
            step:
              "❌ VIDEO LỖI",
            progress:
              100,
            error:
              error?.message ||
              String(error)
          }
        );
      }
    }
  } finally {
    processing = false;
  }
}

/* =========================================================
   HEALTH
   ========================================================= */

app.get(
  "/api/health",
  async (
    _req,
    res
  ) => {
    res.json({
      ok: true,
      service:
        "AI VIDEO FACTORY V6",
      ffmpeg:
        await commandExists(
          "ffmpeg"
        ),
      ffprobe:
        await commandExists(
          "ffprobe"
        ),
      espeak:
        await commandExists(
          "espeak-ng"
        ),
      queue:
        queue.length,
      processing
    });
  }
);

/* =========================================================
   TẠO JOB
   ========================================================= */

app.post(
  "/api/generate",
  (
    req,
    res
  ) => {
    const topic =
      clean(
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
        .toString(
          "hex"
        );

    const workDir =
      path.join(
        WORK_DIR,
        id
      );

    fs.mkdirSync(
      workDir,
      {
        recursive: true
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
        "Đang xếp hàng...",

      progress:
        0,

      outputs: [],

      error:
        null,

      mode:
        "topic-safe",

      workDir,

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
        publicJob(
          job
        )
    });
  }
);

/* =========================================================
   STATUS
   ========================================================= */

app.get(
  "/api/status/:id",
  (
    req,
    res
  ) => {
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
      publicJob(
        job
      )
    );
  }
);

/* =========================================================
   DOWNLOAD
   ========================================================= */

app.get(
  "/api/download/:id/:index",
  (
    req,
    res
  ) => {
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
        item =>
          Number(
            item.index
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
          "File video không còn trên Render."
        );
    }

    res.download(
      file,
      output.file
    );
  }
);

/* =========================================================
   GIAO DIỆN
   ========================================================= */

app.get(
  "/",
  (
    _req,
    res
  ) => {
    res
      .type("html")
      .send(
`<!doctype html>
<html lang="vi">

<head>

<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>
AI VIDEO FACTORY V6
</title>

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
font-weight:700;
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
color:#fff;
border:1px solid #34435f
}

button{
border:0;
background:#22c55e;
color:#04120a;
font-weight:800;
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
🎬 AI VIDEO FACTORY V6
</h1>

<div class="sub">
Bản mới ưu tiên đúng hoàn cảnh:
lời thoại được lấy từ chính chủ đề,
mỗi cảnh tìm ảnh theo nội dung
của chính cảnh đó. Nếu không chắc
ảnh nào phù hợp thì hệ thống dùng
ảnh chính của chủ đề thay vì lấy
nhầm ảnh.
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
Mục tiêu của bản này là loại bỏ
lỗi ảnh sai hoàn cảnh. Video vẫn là
9:16 và mỗi cảnh có hình + tiếng +
phụ đề riêng.
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
document.getElementById(
"create"
);

var result =
document.getElementById(
"result"
);

var status =
document.getElementById(
"status"
);

var fill =
document.getElementById(
"fill"
);

var error =
document.getElementById(
"error"
);

var downloads =
document.getElementById(
"downloads"
);

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
(
job.step ||
job.status
) +
" • " +
(
job.progress ||
0
) +
"%";

fill.style.width =
(
job.progress ||
0
) +
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
function(video){

return (
'<a class="download" href="' +
video.url +
'">⬇️ TẢI VIDEO ' +
video.index +
' • ' +
video.duration +
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
.getElementById(
"topic"
)
.value
.trim();

var count =
Number(
document
.getElementById(
"count"
)
.value
);

var duration =
Number(
document
.getElementById(
"duration"
)
.value
);

var style =
document
.getElementById(
"style"
)
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

poll(
data.id
);

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

</html>`
      );
  }
);

/* =========================================================
   DỌN JOB CŨ
   ========================================================= */

setInterval(
  () => {

    const cutoff =
      Date.now() -
      6 *
      60 *
      60 *
      1000;

    for (
      const [id, job]
      of jobs
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
            recursive:
              true,
            force:
              true
          }
        ).catch(
          () => {}
        );

      }

    }

  },
  30 *
  60 *
  1000
);

/* =========================================================
   START
   ========================================================= */

app.listen(
  PORT,
  HOST,
  () => {

    console.log(
      "================================"
    );

    console.log(
      "AI VIDEO FACTORY V6"
    );

    console.log(
      "Server: http://" +
      HOST +
      ":" +
      PORT
    );

    console.log(
      "Ready."
    );

    console.log(
      "================================"
    );

  }
);
