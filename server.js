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

app.use(express.json({ limit: "2mb" }));

const jobs = new Map();
const queue = [];
let processing = false;

const FONT =
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

function uid() {
  return crypto.randomBytes(8).toString("hex");
}

function cleanText(value, max = 500) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function safeName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "video";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureFile(file) {
  if (!fs.existsSync(file)) {
    throw new Error("Không tìm thấy file: " + file);
  }
}

async function run(command, args, options = {}) {
  const result = await execFileAsync(command, args, {
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
    timeout: options.timeout || 180000,
  });
  return result;
}

async function ffprobeDuration(file) {
  const result = await run(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      file,
    ],
    { timeout: 60000 }
  );

  const value = Number(String(result.stdout).trim());
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Không đọc được thời lượng audio/video.");
  }
  return value;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeout || 20000
  );

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "User-Agent":
          "AI-Video-Factory/4.0 (+https://github.com/vantran1989/ai-video-factory)",
        Accept: "application/json,text/plain,*/*",
        ...(options.headers || {}),
      },
    });

    if (!response.ok) {
      throw new Error(
        "HTTP " +
          response.status +
          " từ " +
          new URL(url).hostname
      );
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadBinary(url, file, attempts = 3) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);

      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: {
            "User-Agent":
              "AI-Video-Factory/4.0 (+https://github.com/vantran1989/ai-video-factory)",
          },
        });

        if (!response.ok) {
          throw new Error(
            "Download HTTP " + response.status
          );
        }

        const buffer = Buffer.from(await response.arrayBuffer());

        if (buffer.length < 1000) {
          throw new Error("File ảnh quá nhỏ.");
        }

        fs.writeFileSync(file, buffer);
        return;
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      lastError = error;
      await sleep(700 * attempt);
    }
  }

  throw lastError || new Error("Không tải được ảnh.");
}

function normalizeVietnameseText(text) {
  return cleanText(text)
    .replace(/[“”"]/g, "")
    .replace(/[<>]/g, "")
    .replace(/\.\.\./g, "…");
}

function topicKeywords(topic) {
  const lower = topic.toLowerCase();

  const map = [
    {
      keys: ["cá mập", "ca map", "shark"],
      words: [
        "cá mập",
        "cá mập dưới đại dương",
        "cá mập cận cảnh",
        "cá mập săn mồi",
        "cá mập bơi",
        "răng cá mập",
      ],
    },
    {
      keys: ["khủng long", "khung long", "dinosaur"],
      words: [
        "khủng long",
        "khủng long rex",
        "khủng long hóa thạch",
        "khủng long săn mồi",
        "khủng long thời tiền sử",
        "khủng long cổ đại",
      ],
    },
    {
      keys: ["ai cập", "aicap", "egypt"],
      words: [
        "Ai Cập cổ đại",
        "kim tự tháp Ai Cập",
        "xác ướp Ai Cập",
        "pharaoh Ai Cập",
        "tượng Ai Cập cổ đại",
        "sa mạc Ai Cập",
      ],
    },
    {
      keys: ["cây", "chăm sóc cây", "trồng cây"],
      words: [
        "cây xanh",
        "chăm sóc cây",
        "tưới cây",
        "đất trồng cây",
        "ánh sáng cho cây",
        "lá cây khỏe",
      ],
    },
    {
      keys: ["du lịch việt nam", "việt nam", "viet nam"],
      words: [
        "Việt Nam phong cảnh",
        "vịnh Hạ Long",
        "ruộng bậc thang Việt Nam",
        "phố cổ Hội An",
        "Đà Nẵng Việt Nam",
        "biển Việt Nam",
      ],
    },
  ];

  for (const item of map) {
    if (item.keys.some((key) => lower.includes(key))) {
      return item.words;
    }
  }

  return [
    topic,
    topic + " thực tế",
    topic + " cận cảnh",
    topic + " hoạt động",
    topic + " nổi bật",
    topic + " chi tiết",
  ];
}

function buildFallbackScenes(topic, videoIndex = 1) {
  const keywords = topicKeywords(topic);

  const special = {
    shark: [
      {
        title: "Câu hỏi gây tò mò",
        query: "cá mập dưới đại dương",
        text: `Bạn có biết điều gì khiến ${topic} đáng sợ đến vậy không?`,
      },
      {
        title: "Đặc điểm nổi bật",
        query: "cá mập cận cảnh",
        text: "Cá mập sở hữu cơ thể được thiết kế để di chuyển cực hiệu quả trong nước.",
      },
      {
        title: "Khả năng săn mồi",
        query: "cá mập săn mồi",
        text: "Khi săn mồi, chúng dựa vào nhiều giác quan để phát hiện dấu hiệu rất nhỏ trong môi trường.",
      },
      {
        title: "Điều ít người biết",
        query: "răng cá mập",
        text: "Một điều thú vị là răng cá mập có thể liên tục được thay mới trong suốt cuộc đời.",
      },
      {
        title: "Sự thật bất ngờ",
        query: "cá mập bơi đại dương",
        text: "Vì thế, hình ảnh về cá mập ngoài đời thực thú vị hơn rất nhiều so với những gì bạn thường thấy.",
      },
      {
        title: "Kết",
        query: "cá mập đại dương",
        text: "Bạn còn biết sự thật nào về cá mập không? Bình luận để cùng khám phá nhé.",
      },
    ],
    dinosaur: [
      {
        title: "Hook",
        query: "khủng long",
        text: `Khủng long từng thống trị Trái Đất hàng triệu năm trước.`,
      },
      {
        title: "Kích thước",
        query: "khủng long rex",
        text: "Có loài khổng lồ, nhưng cũng có những loài nhỏ hơn rất nhiều so với hình dung của chúng ta.",
      },
      {
        title: "Săn mồi",
        query: "khủng long săn mồi",
        text: "Một số loài sở hữu hàm răng và cơ thể thích nghi mạnh mẽ với việc săn mồi.",
      },
      {
        title: "Hóa thạch",
        query: "khủng long hóa thạch",
        text: "Những hóa thạch được tìm thấy giúp các nhà khoa học ghép lại câu chuyện về thế giới cổ đại.",
      },
      {
        title: "Điều thú vị",
        query: "khủng long thời tiền sử",
        text: "Điều đáng kinh ngạc là chim hiện đại được xem là hậu duệ của một nhánh khủng long.",
      },
      {
        title: "CTA",
        query: "khủng long cổ đại",
        text: "Bạn muốn khám phá loài khủng long nào tiếp theo? Hãy để lại tên ở phần bình luận.",
      },
    ],
  };

  const lower = topic.toLowerCase();

  if (lower.includes("cá mập") || lower.includes("ca map") || lower.includes("shark")) {
    return special.shark.map((scene, i) => ({
      ...scene,
      id: i + 1,
      durationHint: 4.5 + (i === 0 ? 0.5 : 0),
    }));
  }

  if (lower.includes("khủng long") || lower.includes("khung long") || lower.includes("dinosaur")) {
    return special.dinosaur.map((scene, i) => ({
      ...scene,
      id: i + 1,
      durationHint: 4.5 + (i === 0 ? 0.5 : 0),
    }));
  }

  const genericTitles = [
    "Hook",
    "Điểm nổi bật",
    "Điều thú vị",
    "Chi tiết ít người biết",
    "Sự thật đáng chú ý",
    "Kết",
  ];

  const genericTexts = [
    `Có một điều rất đáng chú ý về ${topic} mà nhiều người chưa biết.`,
    `${topic} có những đặc điểm khiến chủ đề này trở nên đặc biệt.`,
    `Một chi tiết thú vị là ${topic} không đơn giản như chúng ta thường nghĩ.`,
    `Càng tìm hiểu về ${topic}, bạn càng thấy có nhiều điều bất ngờ.`,
    `Đó cũng là lý do ${topic} luôn tạo ra rất nhiều sự tò mò.`,
    `Bạn muốn xem phần tiếp theo về ${topic}? Hãy bình luận chủ đề bạn muốn khám phá.`,
  ];

  return genericTitles.map((title, i) => ({
    id: i + 1,
    title,
    query: keywords[i],
    text: genericTexts[i],
    durationHint: 4.5,
  }));
}

async function generateScenesWithOpenAI(topic, videoIndex) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return null;
  }

  const model =
    process.env.OPENAI_MODEL || "gpt-4o-mini";

  const prompt =
    "Bạn là biên tập viên video Facebook Reels bằng tiếng Việt. " +
    "Hãy tạo đúng 6 cảnh cho chủ đề sau: " +
    topic +
    ". Video khoảng 25-35 giây. " +
    "Mỗi cảnh phải nói về một ý cụ thể, dễ quay bằng ảnh minh họa. " +
    "Câu thoại phải tự nhiên, ngắn, dễ đọc bằng giọng AI. " +
    "Cảnh đầu phải có hook. Cảnh cuối có CTA. " +
    "Không bịa số liệu hoặc khẳng định khoa học nếu không chắc chắn. " +
    "Trả về JSON thuần túy dạng " +
    '{"scenes":[{"title":"","query":"","text":""}]}.' +
    "Không thêm markdown.";

  const response = await fetch(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.7,
        messages: [
          {
            role: "system",
            content:
              "Chỉ trả về JSON hợp lệ, không markdown.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
    }
  );

  if (!response.ok) {
    throw new Error(
      "OpenAI HTTP " + response.status
    );
  }

  const data = await response.json();

  const content =
    data &&
    data.choices &&
    data.choices[0] &&
    data.choices[0].message &&
    data.choices[0].message.content;

  if (!content) {
    throw new Error("OpenAI không trả về nội dung.");
  }

  let parsed;

  try {
    parsed = JSON.parse(content);
  } catch {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start < 0 || end < start) {
      throw new Error("JSON từ AI không hợp lệ.");
    }
    parsed = JSON.parse(content.slice(start, end + 1));
  }

  if (!parsed.scenes || !Array.isArray(parsed.scenes)) {
    throw new Error("AI không trả về danh sách cảnh.");
  }

  return parsed.scenes
    .slice(0, 6)
    .map((scene, index) => ({
      id: index + 1,
      title: cleanText(scene.title, 80),
      query: cleanText(scene.query, 120),
      text: normalizeVietnameseText(scene.text),
      durationHint: 4.5,
    }))
    .filter((scene) => scene.query && scene.text);
}

async function generateScenes(topic, videoIndex) {
  try {
    const aiScenes = await generateScenesWithOpenAI(
      topic,
      videoIndex
    );

    if (aiScenes && aiScenes.length >= 5) {
      return aiScenes;
    }
  } catch (error) {
    console.log(
      "AI script fallback:",
      error.message
    );
  }

  return buildFallbackScenes(topic, videoIndex);
}

function cleanImageTitle(title) {
  return String(title || "")
    .replace(/^File:/i, "")
    .replace(/\.[A-Za-z0-9]+$/, "")
    .replace(/[_-]+/g, " ")
    .trim();
}

async function searchWikimediaImage(query) {
  const searchQueries = [
    query,
    query + " photo",
    query + " Wikimedia",
  ];

  for (const search of searchQueries) {
    try {
      const params = new URLSearchParams({
        action: "query",
        format: "json",
        generator: "search",
        gsrsearch: search,
        gsrnamespace: "6",
        gsrlimit: "12",
        prop: "imageinfo",
        iiprop: "url|mime|size|extmetadata",
        iiurlwidth: "1080",
        origin: "*",
      });

      const apiUrl =
        "https://commons.wikimedia.org/w/api.php?" +
        params.toString();

      const data = await fetchJson(apiUrl);

      const pages =
        data &&
        data.query &&
        data.query.pages
          ? Object.values(data.query.pages)
          : [];

      const candidates = [];

      for (const page of pages) {
        const info =
          page.imageinfo &&
          page.imageinfo[0];

        if (!info) continue;

        const mime = String(info.mime || "");

        if (!mime.startsWith("image/")) {
          continue;
        }

        if (
          mime.includes("svg") ||
          mime.includes("gif")
        ) {
          continue;
        }

        const width = Number(info.width || 0);
        const height = Number(info.height || 0);

        if (width < 500 || height < 300) {
          continue;
        }

        const thumb =
          info.thumburl ||
          info.url;

        if (!thumb) continue;

        const metadata =
          info.extmetadata || {};

        const description =
          metadata.ImageDescription &&
          metadata.ImageDescription.value
            ? String(
                metadata.ImageDescription.value
              ).replace(/<[^>]*>/g, " ")
            : "";

        const titleText =
          cleanImageTitle(page.title);

        const haystack = (
          titleText +
          " " +
          description
        ).toLowerCase();

        const queryWords = search
          .toLowerCase()
          .split(/\s+/)
          .filter((word) => word.length >= 3);

        let score = 0;

        for (const word of queryWords) {
          if (haystack.includes(word)) {
            score += 2;
          }
        }

        const ratio = width / height;

        if (ratio > 0.4 && ratio < 2.8) {
          score += 1;
        }

        candidates.push({
          url: thumb,
          title: titleText,
          width,
          height,
          score,
        });
      }

      candidates.sort(
        (a, b) => b.score - a.score
      );

      if (candidates.length > 0) {
        return candidates[0];
      }
    } catch (error) {
      console.log(
        "Wikimedia search error:",
        search,
        error.message
      );
    }
  }

  return null;
}

function fallbackSvg(file, title, subtitle) {
  const escapedTitle = String(title)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .slice(0, 60);

  const escapedSubtitle = String(subtitle)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .slice(0, 120);

  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1600">' +
    '<rect width="900" height="1600" fill="#101820"/>' +
    '<rect x="45" y="420" width="810" height="760" rx="35" fill="#18242f"/>' +
    '<text x="450" y="650" text-anchor="middle" ' +
    'fill="white" font-family="DejaVu Sans" font-size="58" font-weight="700">' +
    escapedTitle +
    "</text>" +
    '<text x="450" y="760" text-anchor="middle" ' +
    'fill="#dddddd" font-family="DejaVu Sans" font-size="34">' +
    escapedSubtitle +
    "</text>" +
    "</svg>";

  fs.writeFileSync(file, svg, "utf8");
}

async function prepareImage(scene, sceneDir) {
  const imageFile = path.join(
    sceneDir,
    "source.jpg"
  );

  const found = await searchWikimediaImage(
    scene.query
  );

  if (found) {
    try {
      await downloadBinary(
        found.url,
        imageFile
      );

      return {
        file: imageFile,
        source: found,
      };
    } catch (error) {
      console.log(
        "Image download fallback:",
        error.message
      );
    }
  }

  const svgFile = path.join(
    sceneDir,
    "fallback.svg"
  );

  fallbackSvg(
    svgFile,
    scene.title || scene.query,
    scene.query
  );

  await run(
    "ffmpeg",
    [
      "-y",
      "-i",
      svgFile,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      imageFile,
    ],
    { timeout: 60000 }
  );

  return {
    file: imageFile,
    source: null,
  };
}

function makeEscapedTextForFile(text) {
  return normalizeVietnameseText(text);
}

async function makeAudio(text, sceneDir) {
  const audioFile = path.join(
    sceneDir,
    "voice.mp3"
  );

  const encoded =
    encodeURIComponent(
      normalizeVietnameseText(text)
    );

  const googleUrl =
    "https://translate.google.com/translate_tts?" +
    "ie=UTF-8&client=tw-ob&tl=vi&q=" +
    encoded;

  try {
    await downloadBinary(
      googleUrl,
      audioFile,
      2
    );

    const duration =
      await ffprobeDuration(audioFile);

    if (duration > 0.6) {
      return {
        file: audioFile,
        duration,
        provider: "google",
      };
    }
  } catch (error) {
    console.log(
      "Google TTS fallback:",
      error.message
    );
  }

  const wavFile = path.join(
    sceneDir,
    "voice.wav"
  );

  await run(
    "espeak-ng",
    [
      "-v",
      "vi",
      "-s",
      "145",
      "-p",
      "48",
      "-a",
      "170",
      "-w",
      wavFile,
      normalizeVietnameseText(text),
    ],
    { timeout: 60000 }
  );

  await run(
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
      "aac",
      audioFile,
    ],
    { timeout: 60000 }
  );

  const duration =
    await ffprobeDuration(audioFile);

  return {
    file: audioFile,
    duration,
    provider: "espeak",
  };
}

async function createCaptionFile(text, sceneDir) {
  const file = path.join(
    sceneDir,
    "caption.txt"
  );

  fs.writeFileSync(
    file,
    makeEscapedTextForFile(text),
    "utf8"
  );

  return file;
}

function makeSceneVideoArgs(
  image,
  audio,
  caption,
  output,
  duration,
  direction
) {
  const safeDuration =
    Math.max(1.2, duration);

  const frames =
    Math.ceil(safeDuration * 30);

  const zoomStart =
    direction % 2 === 0
      ? "1.00"
      : "1.08";

  const zoomEnd =
    direction % 2 === 0
      ? "1.10"
      : "1.00";

  const zoomExpr =
    "zoom=" +
    zoomStart +
    "+(" +
    zoomEnd +
    "-" +
    zoomStart +
    ")*on/" +
    Math.max(1, frames - 1);

  const vf =
    "scale=900:1600:force_original_aspect_ratio=increase," +
    "crop=900:1600," +
    "zoompan=z='" +
    zoomExpr +
    "':x='iw/2-(iw/zoom/2)':" +
    "y='ih/2-(ih/zoom/2)':d=1:s=900x1600:fps=30," +
    "drawbox=x=25:y=1160:w=850:h=310:" +
    "color=black@0.58:t=fill," +
    "drawtext=fontfile=" +
    FONT +
    ":textfile='" +
    caption +
    "':fontcolor=white:fontsize=42:" +
    "line_spacing=12:x=65:y=1205:" +
    "box=0";

  return [
    "-y",
    "-loop",
    "1",
    "-i",
    image,
    "-i",
    audio,
    "-t",
    String(safeDuration),
    "-vf",
    vf,
    "-r",
    "30",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "29",
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
    output,
  ];
}

async function renderScene(scene, sceneDir, index) {
  const image = await prepareImage(
    scene,
    sceneDir
  );

  const audio = await makeAudio(
    scene.text,
    sceneDir
  );

  const caption =
    await createCaptionFile(
      scene.text,
      sceneDir
    );

  const output = path.join(
    sceneDir,
    "scene.mp4"
  );

  const extraPad = 0.35;

  const duration = Math.max(
    2.8,
    Math.min(
      6.0,
      audio.duration + extraPad
    )
  );

  await run(
    "ffmpeg",
    makeSceneVideoArgs(
      image.file,
      audio.file,
      caption,
      output,
      duration,
      index
    ),
    { timeout: 150000 }
  );

  ensureFile(output);

  return {
    video: output,
    imageSource: image.source,
    audioProvider: audio.provider,
    audioDuration: audio.duration,
    duration,
  };
}

async function concatScenes(sceneFiles, output) {
  const listFile = path.join(
    path.dirname(output),
    "concat.txt"
  );

  const content = sceneFiles
    .map((file) => {
      const normalized =
        file.replace(/'/g, "'\\''");
      return "file '" + normalized + "'";
    })
    .join("\n");

  fs.writeFileSync(
    listFile,
    content,
    "utf8"
  );

  await run(
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
      output,
    ],
    { timeout: 180000 }
  );

  ensureFile(output);
}

function sanitizeForFacebook(text) {
  return cleanText(text, 120)
    .replace(/\s+/g, " ")
    .trim();
}

async function createVideo(job, videoIndex) {
  const videoDir = path.join(
    job.workDir,
    "video-" + videoIndex
  );

  fs.mkdirSync(videoDir, {
    recursive: true,
  });

  const scenes =
    await generateScenes(
      job.topic,
      videoIndex
    );

  job.logs.push(
    "Video " +
      videoIndex +
      ": " +
      scenes.length +
      " cảnh"
  );

  const sceneFiles = [];
  const metadata = [];

  for (
    let i = 0;
    i < scenes.length;
    i++
  ) {
    const scene = scenes[i];

    job.progress =
      Math.round(
        ((videoIndex - 1) /
          job.count +
          (i + 1) /
            scenes.length /
            job.count) *
          100
      );

    const sceneDir = path.join(
      videoDir,
      "scene-" + (i + 1)
    );

    fs.mkdirSync(sceneDir, {
      recursive: true,
    });

    const result =
      await renderScene(
        scene,
        sceneDir,
        i
      );

    sceneFiles.push(
      result.video
    );

    metadata.push({
      id: scene.id,
      title: scene.title,
      query: scene.query,
      text: sanitizeForFacebook(
        scene.text
      ),
      image:
        result.imageSource
          ? result.imageSource.url
          : null,
      imageTitle:
        result.imageSource
          ? result.imageSource.title
          : "Fallback",
      voice:
        result.audioProvider,
      duration:
        result.duration,
    });

    job.logs.push(
      "Cảnh " +
        (i + 1) +
        ": " +
        scene.title +
        " | ảnh: " +
        (result.imageSource
          ? result.imageSource.title
          : "fallback") +
        " | tiếng: " +
        result.audioProvider
    );
  }

  const topicName =
    safeName(job.topic);

  const output =
    path.join(
      OUTPUT_DIR,
      job.id +
        "-" +
        topicName +
        "-" +
        videoIndex +
        ".mp4"
    );

  await concatScenes(
    sceneFiles,
    output
  );

  const publicDuration =
    await ffprobeDuration(output);

  return {
    index: videoIndex,
    file: output,
    url:
      "/api/download/" +
      job.id +
      "/" +
      videoIndex,
    duration: publicDuration,
    scenes: metadata,
  };
}

async function processJob(job) {
  job.status = "processing";
  job.startedAt = Date.now();

  try {
    for (
      let i = 1;
      i <= job.count;
      i++
    ) {
      const result =
        await createVideo(
          job,
          i
        );

      job.outputs.push(result);
    }

    job.progress = 100;
    job.status = "completed";
    job.finishedAt = Date.now();
  } catch (error) {
    console.error(
      "VIDEO ERROR:",
      error
    );

    job.status = "failed";
    job.error =
      error &&
      error.message
        ? error.message
        : String(error);

    job.finishedAt = Date.now();
  }
}

async function processQueue() {
  if (processing) return;

  processing = true;

  try {
    while (queue.length > 0) {
      const jobId =
        queue.shift();

      const job = jobs.get(jobId);

      if (!job) continue;

      await processJob(job);
    }
  } finally {
    processing = false;
  }
}

function enqueue(job) {
  queue.push(job.id);
  processQueue().catch((error) => {
    console.error(
      "QUEUE ERROR:",
      error
    );
  });
}

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      ok: true,
      version: "V4",
      aiMode:
        Boolean(
          process.env.OPENAI_API_KEY
        ),
      queue: queue.length,
      processing,
    });
  }
);

app.post(
  "/api/generate",
  async (req, res) => {
    try {
      const topic =
        cleanText(
          req.body.topic,
          180
        );

      let count =
        Number(req.body.count);

      if (
        !Number.isFinite(count) ||
        count < 1
      ) {
        count = 1;
      }

      count = Math.min(
        3,
        Math.floor(count)
      );

      if (!topic) {
        return res.status(400).json({
          ok: false,
          error:
            "Vui lòng nhập chủ đề.",
        });
      }

      const id = uid();

      const job = {
        id,
        topic,
        count,
        createdAt: Date.now(),
        startedAt: null,
        finishedAt: null,
        status: "queued",
        progress: 0,
        outputs: [],
        logs: [],
        error: null,
        workDir:
          path.join(
            WORK_DIR,
            id
          ),
      };

      fs.mkdirSync(
        job.workDir,
        {
          recursive: true,
        }
      );

      jobs.set(
        id,
        job
      );

      enqueue(job);

      res.json({
        ok: true,
        id,
        status: job.status,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error:
          error.message ||
          "Lỗi tạo job.",
      });
    }
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
      return res.status(404).json({
        ok: false,
        error:
          "Không tìm thấy job.",
      });
    }

    res.json({
      ok: true,
      id: job.id,
      topic: job.topic,
      count: job.count,
      status: job.status,
      progress: job.progress,
      error: job.error,
      logs: job.logs.slice(-30),
      outputs:
        job.outputs.map((item) => ({
          index: item.index,
          url: item.url,
          duration: item.duration,
          scenes: item.scenes,
        })),
    });
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
      return res.status(404).send(
        "Job không tồn tại."
      );
    }

    const index =
      Number(req.params.index);

    const item =
      job.outputs.find(
        (output) =>
          output.index === index
      );

    if (!item) {
      return res.status(404).send(
        "Video chưa sẵn sàng."
      );
    }

    if (!fs.existsSync(item.file)) {
      return res.status(404).send(
        "File video không còn tồn tại."
      );
    }

    res.download(
      item.file,
      path.basename(item.file)
    );
  }
);

app.get(
  "/",
  (req, res) => {
    const html =
      '<!doctype html>' +
      '<html lang="vi">' +
      '<head>' +
      '<meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>AI Video Factory V4</title>' +
      '<style>' +
      '*{box-sizing:border-box}' +
      'body{margin:0;background:#0f1115;color:#fff;font-family:Arial,sans-serif}' +
      '.wrap{max-width:760px;margin:0 auto;padding:22px}' +
      '.card{background:#191d24;border:1px solid #2b313b;border-radius:20px;padding:20px}' +
      'h1{margin:0 0 8px;font-size:28px}' +
      '.sub{color:#aab2bf;margin-bottom:20px;line-height:1.5}' +
      'label{display:block;margin:14px 0 7px;font-weight:700}' +
      'input,select{width:100%;padding:15px;border-radius:12px;border:1px solid #3a414d;background:#0e1116;color:#fff;font-size:17px}' +
      'button{width:100%;margin-top:18px;padding:16px;border:0;border-radius:13px;background:#1877f2;color:#fff;font-weight:700;font-size:18px}' +
      'button:disabled{opacity:.5}' +
      '.status{margin-top:18px;padding:15px;border-radius:12px;background:#11151b;line-height:1.5;white-space:pre-wrap}' +
      '.download{display:block;margin-top:12px;padding:14px;background:#202733;color:#fff;text-decoration:none;border-radius:12px;font-weight:700}' +
      '.small{font-size:13px;color:#8f98a7;margin-top:14px;line-height:1.5}' +
      '</style>' +
      '</head>' +
      '<body>' +
      '<div class="wrap">' +
      '<div class="card">' +
      '<h1>🎬 AI VIDEO FACTORY V4</h1>' +
      '<div class="sub">Tạo video Facebook 9:16: chia cảnh, ảnh, giọng đọc và phụ đề đồng bộ.</div>' +

      '<label>Chủ đề</label>' +
      '<input id="topic" placeholder="Ví dụ: Cá mập, Khủng long, Ai Cập cổ đại..." />' +

      '<label>Số video</label>' +
      '<select id="count">' +
      '<option value="1">1 video</option>' +
      '<option value="2">2 video</option>' +
      '<option value="3">3 video</option>' +
      '</select>' +

      '<button id="create">🎥 TẠO VIDEO</button>' +

      '<div id="status" class="status">Sẵn sàng.</div>' +
      '<div id="downloads"></div>' +
      '<div class="small">Video ngắn ưu tiên 25–35 giây. Khi có OPENAI_API_KEY, phần kịch bản sẽ dùng AI; nếu không có key, hệ thống dùng kịch bản dự phòng.</div>' +
      '</div>' +
      '</div>' +

      '<script>' +
      'var createBtn=document.getElementById("create");' +
      'var topicEl=document.getElementById("topic");' +
      'var countEl=document.getElementById("count");' +
      'var statusEl=document.getElementById("status");' +
      'var downloadsEl=document.getElementById("downloads");' +

      'function setStatus(text){statusEl.textContent=text;}' +

      'async function start(){' +
        'var topic=topicEl.value.trim();' +
        'var count=Number(countEl.value);' +
        'if(!topic){setStatus("Hãy nhập chủ đề trước.");return;}' +

        'createBtn.disabled=true;' +
        'downloadsEl.innerHTML="";' +
        'setStatus("Đang tạo video...");' +

        'try{' +
          'var response=await fetch("/api/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({topic:topic,count:count})});' +
          'var data=await response.json();' +

          'if(!response.ok||!data.ok){throw new Error(data.error||"Không tạo được job.");}' +

          'poll(data.id);' +
        '}catch(error){' +
          'setStatus("❌ "+error.message);' +
          'createBtn.disabled=false;' +
        '}' +
      '}' +

      'async function poll(id){' +
        'try{' +
          'var response=await fetch("/api/status/"+id);' +
          'var job=await response.json();' +

          'if(!response.ok||!job.ok){throw new Error(job.error||"Không đọc được trạng thái.");}' +

          'var text="Trạng thái: "+job.status+"\\nTiến độ: "+job.progress+"%";' +

          'if(job.logs&&job.logs.length){' +
            'text+="\\n\\n"+job.logs.slice(-8).join("\\n");' +
          '}' +

          'setStatus(text);' +

          'if(job.status==="completed"){' +
            'createBtn.disabled=false;' +
            'downloadsEl.innerHTML="";' +

            'job.outputs.forEach(function(video){' +
              'var a=document.createElement("a");' +
              'a.className="download";' +
              'a.href=video.url;' +
              'a.textContent="⬇️ TẢI VIDEO "+video.index+" ("+Math.round(video.duration)+" giây)";' +
              'downloadsEl.appendChild(a);' +
            '});' +

            'return;' +
          '}' +

          'if(job.status==="failed"){' +
            'createBtn.disabled=false;' +
            'setStatus("❌ VIDEO LỖI\\n\\n"+(job.error||"Lỗi không xác định."));' +
            'return;' +
          '}' +

          'setTimeout(function(){poll(id);},2500);' +
        '}catch(error){' +
          'createBtn.disabled=false;' +
          'setStatus("❌ "+error.message);' +
        '}' +
      '}' +

      'createBtn.addEventListener("click",start);' +
      '</script>' +
      '</body>' +
      '</html>';

    res.send(html);
  }
);

app.listen(
  PORT,
  HOST,
  () => {
    console.log(
      "========================================"
    );
    console.log(
      "AI VIDEO FACTORY V4"
    );
    console.log(
      "Server: http://" +
        HOST +
        ":" +
        PORT
    );
    console.log(
      "AI script: " +
        (process.env.OPENAI_API_KEY
          ? "ON"
          : "OFF")
    );
    console.log(
      "Ready."
    );
    console.log(
      "========================================"
    );
  }
);
