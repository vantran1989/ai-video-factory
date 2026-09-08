import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawn } from "child_process";

const app = express();

const PORT = Number(process.env.PORT || 10000);
const HOST = "0.0.0.0";

const ROOT = process.cwd();
const WORK_DIR = path.join(ROOT, "work");
const OUTPUT_DIR = path.join(ROOT, "output");

fs.mkdirSync(WORK_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

app.use(express.json({ limit: "2mb" }));

/* =========================================================
   JOB QUEUE
========================================================= */

const jobStore = new Map();
const jobQueue = [];
let workerRunning = false;

function makeId() {
  return crypto.randomBytes(8).toString("hex");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/* =========================================================
   UTILS
========================================================= */

function cleanTopic(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150);
}

function safeFilename(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 70) || "video";
}

function normalizeWords(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .split(/\s+/)
    .filter(word => word.length >= 3);
}

function shorten(text, max = 120) {
  let value = String(text || "")
    .replace(/\s+/g, " ")
    .trim();

  if (value.length <= max) {
    return value;
  }

  let result = value.slice(0, max);

  const lastSpace = result.lastIndexOf(" ");

  if (lastSpace > 35) {
    result = result.slice(0, lastSpace);
  }

  return result.trim() + "...";
}

function captionText(text) {
  let value = shorten(text, 82);

  if (value.length <= 42) {
    return value;
  }

  let middle = Math.floor(value.length / 2);

  let left = value.lastIndexOf(" ", middle);
  let right = value.indexOf(" ", middle);

  let position = left > 20 ? left : right;

  if (position <= 0) {
    position = middle;
  }

  return (
    value.slice(0, position).trim() +
    "\n" +
    value.slice(position).trim()
  );
}

/* =========================================================
   COMMAND RUNNER
========================================================= */

function runCommand(command, args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: process.env
    });

    let stdout = "";
    let stderr = "";
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;

      finished = true;

      try {
        child.kill("SIGKILL");
      } catch {}

      reject(
        new Error(`${command} timeout`)
      );
    }, timeout);

    child.stdout.on("data", data => {
      stdout += data.toString();
    });

    child.stderr.on("data", data => {
      stderr += data.toString();
    });

    child.on("error", error => {
      if (finished) return;

      finished = true;
      clearTimeout(timer);

      reject(error);
    });

    child.on("close", code => {
      if (finished) return;

      finished = true;
      clearTimeout(timer);

      if (code === 0) {
        resolve({
          stdout,
          stderr
        });
      } else {
        reject(
          new Error(
            `${command} exited ${code}\n${stderr.slice(-5000)}`
          )
        );
      }
    });
  });
}

/* =========================================================
   DOWNLOAD IMAGE
========================================================= */

async function downloadImage(url, destination) {
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    30000
  );

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 AI-Video-Factory"
      }
    });

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    const buffer = Buffer.from(
      await response.arrayBuffer()
    );

    if (buffer.length < 1500) {
      throw new Error("Ảnh tải về không hợp lệ");
    }

    fs.writeFileSync(
      destination,
      buffer
    );

    return destination;
  } finally {
    clearTimeout(timer);
  }
}

/* =========================================================
   WIKIPEDIA
========================================================= */

async function getWikipediaTopic(topic) {
  try {
    const searchUrl =
      "https://vi.wikipedia.org/w/api.php" +
      "?action=query" +
      "&list=search" +
      "&srsearch=" +
      encodeURIComponent(topic) +
      "&srlimit=5" +
      "&format=json" +
      "&utf8=1";

    const response = await fetch(
      searchUrl,
      {
        headers: {
          "User-Agent":
            "AI-Video-Factory/6.0"
        }
      }
    );

    if (!response.ok) {
      return null;
    }

    const data = await response.json();

    const first =
      data?.query?.search?.[0];

    if (!first) {
      return null;
    }

    const title = first.title;

    const summaryUrl =
      "https://vi.wikipedia.org/api/rest_v1/page/summary/" +
      encodeURIComponent(title);

    const summaryResponse =
      await fetch(summaryUrl, {
        headers: {
          "User-Agent":
            "AI-Video-Factory/6.0"
        }
      });

    if (!summaryResponse.ok) {
      return {
        title,
        extract: "",
        thumbnail: null
      };
    }

    const summary =
      await summaryResponse.json();

    return {
      title,
      extract:
        summary.extract || "",
      thumbnail:
        summary.thumbnail?.source || null
    };
  } catch {
    return null;
  }
}

/* =========================================================
   WIKIMEDIA COMMONS
========================================================= */

async function searchCommons(
  searchQuery,
  topic
) {
  try {
    const url =
      "https://commons.wikimedia.org/w/api.php" +
      "?action=query" +
      "&generator=search" +
      "&gsrsearch=" +
      encodeURIComponent(searchQuery) +
      "&gsrnamespace=6" +
      "&gsrlimit=20" +
      "&prop=imageinfo" +
      "&iiprop=url|mime|size" +
      "&iiurlwidth=1200" +
      "&format=json";

    const response = await fetch(
      url,
      {
        headers: {
          "User-Agent":
            "AI-Video-Factory/6.0"
        }
      }
    );

    if (!response.ok) {
      return [];
    }

    const data = await response.json();

    const pages =
      Object.values(
        data?.query?.pages || {}
      );

    const topicWords =
      normalizeWords(topic);

    const badWords = [
      "station",
      "railway",
      "train",
      "airplane",
      "aircraft",
      "airport",
      "map",
      "logo",
      "flag",
      "bird",
      "flower",
      "phone",
      "screenshot",
      "poster",
      "diagram",
      "chart",
      "school",
      "church",
      "building",
      "road",
      "bridge",
      "car",
      "bus"
    ];

    const results = [];

    for (const page of pages) {
      const info =
        page.imageinfo?.[0];

      if (!info?.thumburl) {
        continue;
      }

      if (
        !String(info.mime || "")
          .startsWith("image/")
      ) {
        continue;
      }

      const title =
        String(page.title || "")
          .toLowerCase();

      let score = 0;

      for (const word of topicWords) {
        if (title.includes(word)) {
          score += 15;
        }
      }

      for (const bad of badWords) {
        if (title.includes(bad)) {
          score -= 40;
        }
      }

      if (
        info.width &&
        info.height
      ) {
        const ratio =
          info.width /
          info.height;

        if (
          ratio >= 0.35 &&
          ratio <= 3
        ) {
          score += 5;
        }
      }

      results.push({
        score,
        url: info.thumburl,
        title: page.title
      });
    }

    results.sort(
      (a, b) => b.score - a.score
    );

    return results;
  } catch {
    return [];
  }
}

/* =========================================================
   IMAGE FINDER
========================================================= */

async function findBestImage(
  topic,
  imageQuery,
  wiki
) {
  const queries = [];

  if (imageQuery) {
    queries.push(
      imageQuery
    );
  }

  queries.push(topic);

  if (wiki?.title) {
    queries.push(
      wiki.title
    );
  }

  for (const query of queries) {
    const results =
      await searchCommons(
        query,
        topic
      );

    if (!results.length) {
      continue;
    }

    /*
      Chỉ lấy ảnh có điểm đủ cao.
      Không lấy ảnh linh tinh chỉ để cho đủ cảnh.
    */

    const acceptable =
      results.find(
        item => item.score >= 15
      );

    if (acceptable) {
      return acceptable.url;
    }
  }

  /*
    Wikipedia thumbnail là fallback
    chính chủ đề.
  */

  if (wiki?.thumbnail) {
    return wiki.thumbnail;
  }

  return null;
}

/* =========================================================
   FALLBACK IMAGE
========================================================= */

async function createFallbackImage(
  topic,
  output
) {
  const textFile =
    output + ".txt";

  fs.writeFileSync(
    textFile,
    `CHỦ ĐỀ\n${topic}`,
    "utf8"
  );

  await runCommand(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=0x111827:s=720x1280:d=1",
      "-vf",
      `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:textfile=${textFile}:fontcolor=white:fontsize=52:x=(w-text_w)/2:y=(h-text_h)/2`,
      "-frames:v",
      "1",
      output
    ],
    30000
  );

  try {
    fs.unlinkSync(textFile);
  } catch {}

  return output;
}

/* =========================================================
   TTS
========================================================= */

async function createVoice(
  text,
  output
) {
  /*
    Thử Google TTS trước.
    Nếu lỗi -> eSpeak offline.
  */

  try {
    const url =
      "https://translate.google.com/translate_tts" +
      "?ie=UTF-8" +
      "&q=" +
      encodeURIComponent(text) +
      "&tl=vi" +
      "&client=tw-ob";

    const response =
      await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0"
        }
      });

    const contentType =
      response.headers.get(
        "content-type"
      ) || "";

    if (
      response.ok &&
      contentType.includes("audio")
    ) {
      const buffer =
        Buffer.from(
          await response.arrayBuffer()
        );

      if (buffer.length > 1000) {
        fs.writeFileSync(
          output,
          buffer
        );

        /*
          Tăng tốc nhẹ để giọng
          đỡ chậm.
        */

        const temp =
          output + ".tmp.mp3";

        await runCommand(
          "ffmpeg",
          [
            "-y",
            "-i",
            output,
            "-filter:a",
            "atempo=1.12",
            "-ar",
            "44100",
            "-ac",
            "1",
            temp
          ],
          30000
        );

        fs.renameSync(
          temp,
          output
        );

        return output;
      }
    }
  } catch {}

  /*
    Offline fallback.
  */

  await runCommand(
    "espeak-ng",
    [
      "-v",
      "vi",
      "-s",
      "190",
      "-p",
      "48",
      "-a",
      "160",
      "-w",
      output,
      text
    ],
    30000
  );

  return output;
}

/* =========================================================
   AUDIO DURATION
========================================================= */

async function getDuration(
  file
) {
  try {
    const result =
      await runCommand(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "default=noprint_wrappers=1:nokey=1",
          file
        ],
        15000
      );

    const value =
      Number(
        result.stdout.trim()
      );

    if (
      Number.isFinite(value) &&
      value > 0
    ) {
      return value;
    }
  } catch {}

  return 3;
}

/* =========================================================
   FALLBACK SCRIPT
========================================================= */

function makeFallbackScenes(
  topic,
  wiki,
  duration
) {
  const count =
    duration <= 15
      ? 4
      : duration <= 30
      ? 6
      : duration <= 45
      ? 8
      : 8;

  let sentences = [];

  if (wiki?.extract) {
    sentences =
      wiki.extract
        .replace(/\s+/g, " ")
        .split(
          /(?<=[.!?])\s+/
        )
        .map(
          x => x.trim()
        )
        .filter(
          x => x.length > 25
        );
  }

  if (!sentences.length) {
    sentences = [
      `Hôm nay chúng ta khám phá ${topic}.`,
      `${topic} có nhiều điều thú vị mà không phải ai cũng biết.`,
      `Một điểm đáng chú ý của ${topic} là những đặc điểm rất riêng.`,
      `Càng tìm hiểu, bạn càng thấy ${topic} hấp dẫn.`,
      `Đây là một chủ đề rất đáng để khám phá.`,
      `Bạn đã biết điều này về ${topic} chưa?`,
      `Có rất nhiều điều bất ngờ xoay quanh ${topic}.`,
      `Nếu quan tâm đến ${topic}, hãy tiếp tục tìm hiểu thêm.`
    ];
  }

  const intents = [
    "overview",
    "main subject",
    "close up detail",
    "natural environment",
    "real life",
    "interesting detail",
    "action",
    "wide view"
  ];

  const scenes = [];

  for (
    let i = 0;
    i < count;
    i++
  ) {
    const narration =
      shorten(
        sentences[
          i % sentences.length
        ],
        115
      );

    scenes.push({
      narration,
      caption:
        captionText(
          narration
        ),
      imageQuery:
        `${topic} ${intents[i]}`
    });
  }

  return scenes;
}

/* =========================================================
   OPTIONAL OPENAI SCRIPT
========================================================= */

async function createAIScenes(
  topic,
  duration
) {
  if (
    !process.env.OPENAI_API_KEY
  ) {
    return null;
  }

  const count =
    duration <= 15
      ? 4
      : duration <= 30
      ? 6
      : duration <= 45
      ? 8
      : 8;

  const prompt = `
Tạo kịch bản video TikTok/Facebook bằng tiếng Việt.

CHỦ ĐỀ:
${topic}

Yêu cầu:
- ${count} cảnh.
- Mỗi cảnh có câu thoại ngắn, tự nhiên.
- Nội dung phải đúng và liên quan trực tiếp đến chủ đề.
- Mỗi cảnh phải có hình ảnh phù hợp với câu thoại.
- Không được đưa chủ đề khác vào.
- imageQuery dùng tiếng Anh khi có thể để tìm ảnh trên Wikimedia Commons.
- Không bịa thông tin cụ thể nếu không chắc chắn.
- Hook mạnh ở cảnh đầu.
- Câu cuối tạo cảm giác muốn xem tiếp hoặc tương tác.

Chỉ trả JSON:

{
  "scenes": [
    {
      "narration": "...",
      "caption": "...",
      "imageQuery": "..."
    }
  ]
}
`;

  try {
    const response =
      await fetch(
        "https://api.openai.com/v1/responses",
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",
            "Authorization":
              `Bearer ${process.env.OPENAI_API_KEY}`
          },
          body: JSON.stringify({
            model:
              process.env.OPENAI_MODEL ||
              "gpt-5",
            input: prompt
          })
        }
      );

    if (!response.ok) {
      return null;
    }

    const data =
      await response.json();

    let text =
      data.output_text || "";

    if (!text) {
      text =
        data.output
          ?.flatMap(
            item =>
              item.content || []
          )
          ?.map(
            item =>
              item.text || ""
          )
          ?.join("") || "";
    }

    const start =
      text.indexOf("{");

    const end =
      text.lastIndexOf("}");

    if (
      start < 0 ||
      end <= start
    ) {
      return null;
    }

    const json =
      JSON.parse(
        text.slice(
          start,
          end + 1
        )
      );

    if (
      !Array.isArray(
        json.scenes
      )
    ) {
      return null;
    }

    return json.scenes
      .filter(
        item =>
          item?.narration &&
          item?.imageQuery
      )
      .slice(0, count)
      .map(item => ({
        narration:
          shorten(
            item.narration,
            115
          ),
        caption:
          captionText(
            item.caption ||
            item.narration
          ),
        imageQuery:
          String(
            item.imageQuery
          ).slice(0, 160)
      }));
  } catch {
    return null;
  }
}

/* =========================================================
   CREATE ONE SCENE VIDEO
========================================================= */

async function renderScene({
  image,
  audio,
  caption,
  output,
  index,
  targetSeconds
}) {
  const captionFile =
    output +
    ".caption.txt";

  fs.writeFileSync(
    captionFile,
    caption,
    "utf8"
  );

  const audioSeconds =
    await getDuration(audio);

  const duration =
    Math.max(
      2.8,
      targetSeconds,
      audioSeconds + 0.15
    );

  const frames =
    Math.ceil(
      duration * 30
    );

  /*
    Mỗi cảnh có chuyển động
    khác nhau.
  */

  let zoom;

  if (index % 4 === 0) {
    zoom =
      `zoompan=z='min(zoom+0.0018,1.10)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=720x1280:fps=30`;
  } else if (index % 4 === 1) {
    zoom =
      `zoompan=z='min(zoom+0.0015,1.09)':x='0':y='ih/2-(ih/zoom/2)':d=${frames}:s=720x1280:fps=30`;
  } else if (index % 4 === 2) {
    zoom =
      `zoompan=z='min(zoom+0.0017,1.10)':x='iw/zoom-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=720x1280:fps=30`;
  } else {
    zoom =
      `zoompan=z='min(zoom+0.0016,1.09)':x='iw/2-(iw/zoom/2)':y='0':d=${frames}:s=720x1280:fps=30`;
  }

  const filter =
    `scale=900:1600:force_original_aspect_ratio=increase,` +
    `crop=900:1600,` +
    `eq=saturation=1.08:contrast=1.04,` +
    `${zoom},` +

    /*
      Thanh tiêu đề phía trên
    */

    `drawbox=x=18:y=18:w=684:h=115:color=black@0.42:t=fill,` +

    /*
      Thanh caption phía dưới
    */

    `drawbox=x=22:y=ih-300:w=676:h=250:color=black@0.76:t=fill,` +

    `drawtext=` +
    `fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:` +
    `text='CẢNH ${index + 1}':` +
    `fontcolor=white:` +
    `fontsize=28:` +
    `x=42:` +
    `y=48,` +

    `drawtext=` +
    `fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:` +
    `textfile=${captionFile}:` +
    `fontcolor=white:` +
    `fontsize=34:` +
    `line_spacing=12:` +
    `x=42:` +
    `y=ih-265`;

  await runCommand(
    "ffmpeg",
    [
      "-y",
      "-loop",
      "1",
      "-i",
      image,
      "-i",
      audio,
      "-vf",
      filter,
      "-t",
      String(duration),
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "30",
      "-pix_fmt",
      "yuv420p",
      "-r",
      "30",
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      "-ar",
      "44100",
      "-ac",
      "1",
      "-shortest",
      "-movflags",
      "+faststart",
      output
    ],
    150000
  );

  try {
    fs.unlinkSync(
      captionFile
    );
  } catch {}

  return output;
}

/* =========================================================
   CONCAT
========================================================= */

async function mergeScenes(
  sceneFiles,
  output
) {
  const listFile =
    output + ".list.txt";

  const content =
    sceneFiles
      .map(
        file =>
          `file '${file.replace(
            /'/g,
            "'\\''"
          )}'`
      )
      .join("\n");

  fs.writeFileSync(
    listFile,
    content,
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
        output
      ],
      180000
    );
  } catch {
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
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "30",
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        "-movflags",
        "+faststart",
        output
      ],
      180000
    );
  }

  try {
    fs.unlinkSync(
      listFile
    );
  } catch {}
}

/* =========================================================
   PROCESS VIDEO
========================================================= */

async function processJob(job) {
  const work =
    path.join(
      WORK_DIR,
      job.id
    );

  fs.mkdirSync(
    work,
    { recursive: true }
  );

  try {
    job.status =
      "processing";

    job.progress = 3;
    job.message =
      "Đang phân tích chủ đề...";

    const topic =
      cleanTopic(
        job.topic
      );

    /*
      Wikipedia được dùng để
      lấy thông tin đúng chủ đề.
    */

    const wiki =
      await getWikipediaTopic(
        topic
      );

    job.progress = 10;
    job.message =
      "Đang tạo kịch bản...";

    /*
      Nếu có OPENAI_API_KEY:
      tạo kịch bản thông minh.

      Nếu không có:
      Wikipedia + fallback.
    */

    let scenes =
      await createAIScenes(
        topic,
        job.duration
      );

    if (
      !scenes ||
      scenes.length < 2
    ) {
      scenes =
        makeFallbackScenes(
          topic,
          wiki,
          job.duration
        );
    }

    const sceneCount =
      scenes.length;

    const targetSeconds =
      Math.max(
        2.8,
        Number(job.duration) /
          sceneCount
      );

    const sceneFiles = [];

    for (
      let i = 0;
      i < sceneCount;
      i++
    ) {
      const scene =
        scenes[i];

      job.progress =
        15 +
        Math.round(
          (i / sceneCount) * 75
        );

      job.message =
        `Đang tạo cảnh ${i + 1}/${sceneCount}: ${shorten(
          scene.narration,
          45
        )}`;

      const imagePath =
        path.join(
          work,
          `image-${i}.jpg`
        );

      const audioPath =
        path.join(
          work,
          `audio-${i}.mp3`
        );

      const scenePath =
        path.join(
          work,
          `scene-${i}.mp4`
        );

      /*
        Tìm ảnh ĐÚNG chủ đề.
      */

      const imageUrl =
        await findBestImage(
          topic,
          scene.imageQuery,
          wiki
        );

      if (imageUrl) {
        try {
          await downloadImage(
            imageUrl,
            imagePath
          );
        } catch {
          await createFallbackImage(
            topic,
            imagePath
          );
        }
      } else {
        await createFallbackImage(
          topic,
          imagePath
        );
      }

      /*
        Tạo giọng đọc.
      */

      await createVoice(
        scene.narration,
        audioPath
      );

      /*
        Render cảnh.
      */

      await renderScene({
        image:
          imagePath,
        audio:
          audioPath,
        caption:
          scene.caption,
        output:
          scenePath,
        index:
          i,
        targetSeconds
      });

      sceneFiles.push(
        scenePath
      );
    }

    job.progress = 94;
    job.message =
      "Đang ghép các cảnh thành video...";

    const filename =
      `${safeFilename(topic)}-${job.id}.mp4`;

    const finalPath =
      path.join(
        OUTPUT_DIR,
        filename
      );

    await mergeScenes(
      sceneFiles,
      finalPath
    );

    if (
      !fs.existsSync(
        finalPath
      )
    ) {
      throw new Error(
        "Không tìm thấy file MP4 sau khi render"
      );
    }

    const size =
      fs.statSync(
        finalPath
      ).size;

    if (size < 10000) {
      throw new Error(
        "File MP4 được tạo nhưng không hợp lệ"
      );
    }

    job.status =
      "done";

    job.progress = 100;

    job.message =
      "✅ Tạo video thành công";

    job.filename =
      filename;

    /*
      Dọn thư mục tạm.
    */

    try {
      fs.rmSync(
        work,
        {
          recursive: true,
          force: true
        }
      );
    } catch {}
  } catch (error) {
    console.error(
      "VIDEO ERROR:",
      error?.stack ||
      error
    );

    job.status =
      "error";

    job.progress = 0;

    job.message =
      error?.message ||
      "Không thể tạo video";

    try {
      fs.rmSync(
        work,
        {
          recursive: true,
          force: true
        }
      );
    } catch {}
  }
}

/* =========================================================
   QUEUE WORKER
========================================================= */

async function startWorker() {
  if (workerRunning) {
    return;
  }

  workerRunning = true;

  while (
    jobQueue.length > 0
  ) {
    const jobId =
      jobQueue.shift();

    const job =
      jobStore.get(
        jobId
      );

    if (!job) {
      continue;
    }

    await processJob(
      job
    );

    /*
      Nghỉ nhẹ để Render
      không bị quá tải.
    */

    await sleep(500);
  }

  workerRunning = false;
}

/* =========================================================
   API: CREATE
========================================================= */

app.post(
  "/api/generate",
  (req, res) => {
    const topic =
      cleanTopic(
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
      clamp(
        Number(
          req.body?.duration || 30
        ),
        15,
        60
      );

    if (!topic) {
      return res
        .status(400)
        .json({
          error:
            "Bạn chưa nhập chủ đề"
        });
    }

    const ids = [];

    for (
      let i = 0;
      i < count;
      i++
    ) {
      const job = {
        id:
          makeId(),
        topic,
        duration,
        status:
          "queued",
        progress:
          0,
        message:
          "Đang chờ xử lý...",
        createdAt:
          Date.now(),
        filename:
          null
      };

      jobStore.set(
        job.id,
        job
      );

      jobQueue.push(
        job.id
      );

      ids.push(
        job.id
      );
    }

    /*
      Bắt đầu worker
      nhưng API trả về ngay.
    */

    startWorker();

    res.json({
      ok: true,
      jobs: ids
    });
  }
);

/* =========================================================
   API: STATUS
========================================================= */

app.get(
  "/api/status/:id",
  (req, res) => {
    const job =
      jobStore.get(
        req.params.id
      );

    if (!job) {
      return res
        .status(404)
        .json({
          error:
            "Không tìm thấy video"
        });
    }

    res.json({
      id:
        job.id,
      status:
        job.status,
      progress:
        job.progress,
      message:
        job.message,
      filename:
        job.filename
    });
  }
);

/* =========================================================
   API: DOWNLOAD
========================================================= */

app.get(
  "/api/download/:id",
  (req, res) => {
    const job =
      jobStore.get(
        req.params.id
      );

    if (
      !job ||
      job.status !== "done"
    ) {
      return res
        .status(404)
        .send(
          "Video chưa sẵn sàng"
        );
    }

    const file =
      path.join(
        OUTPUT_DIR,
        job.filename
      );

    if (
      !fs.existsSync(file)
    ) {
      return res
        .status(404)
        .send(
          "File video không còn tồn tại"
        );
    }

    res.download(
      file,
      job.filename
    );
  }
);

/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,
      version:
        "FINAL-ANY-TOPIC",
      queue:
        jobQueue.length,
      running:
        workerRunning
    });
  }
);

/* =========================================================
   FRONTEND
========================================================= */

app.get(
  "/",
  (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport"
      content="width=device-width,initial-scale=1">

<title>AI VIDEO FACTORY</title>

<style>

*{
  box-sizing:border-box;
}

body{
  margin:0;
  background:#0b1020;
  color:#fff;
  font-family:Arial,sans-serif;
}

.container{
  max-width:680px;
  margin:auto;
  padding:20px;
}

h1{
  text-align:center;
  margin:10px 0 5px;
}

.subtitle{
  text-align:center;
  color:#9ca3af;
  margin-bottom:24px;
}

.card{
  background:#151c30;
  padding:20px;
  border-radius:18px;
}

label{
  display:block;
  margin-top:15px;
  margin-bottom:7px;
  font-weight:bold;
}

input,
select,
button{
  width:100%;
  border:0;
  border-radius:12px;
  padding:15px;
  font-size:16px;
}

input,
select{
  background:#222b43;
  color:#fff;
}

button{
  margin-top:22px;
  background:#16a34a;
  color:white;
  font-weight:bold;
}

button:disabled{
  opacity:.5;
}

.progress{
  margin-top:20px;
  height:12px;
  border-radius:10px;
  background:#252e45;
  overflow:hidden;
}

.bar{
  height:100%;
  width:0%;
  background:#22c55e;
  transition:.3s;
}

.status{
  margin-top:12px;
  min-height:24px;
  color:#d1d5db;
}

.download{
  display:block;
  margin-top:14px;
  padding:15px;
  border-radius:12px;
  background:#2563eb;
  color:white;
  text-decoration:none;
  text-align:center;
  font-weight:bold;
}

.error{
  color:#f87171;
  margin-top:14px;
}

.note{
  margin-top:18px;
  color:#9ca3af;
  font-size:13px;
  line-height:1.5;
}

</style>
</head>

<body>

<div class="container">

<h1>🎬 AI VIDEO FACTORY</h1>

<div class="subtitle">
Tạo video Facebook / TikTok từ CHỦ ĐỀ BẤT KỲ
</div>

<div class="card">

<label>Chủ đề</label>

<input
  id="topic"
  placeholder="Ví dụ: Khủng long, Ai Cập cổ đại, cây cảnh, du lịch Đà Nẵng..."
>

<label>Số video</label>

<select id="count">
  <option value="1">1 video</option>
  <option value="2">2 video</option>
  <option value="3">3 video</option>
</select>

<label>Thời lượng</label>

<select id="duration">
  <option value="15">15 giây</option>
  <option value="30" selected>30 giây</option>
  <option value="45">45 giây</option>
  <option value="60">60 giây</option>
</select>

<button
  id="createButton"
  onclick="createVideos()"
>
🚀 TẠO VIDEO
</button>

<div class="progress">
  <div
    class="bar"
    id="progressBar">
  </div>
</div>

<div
  class="status"
  id="status">
Chưa tạo video
</div>

<div id="downloads"></div>

<div class="note">
Hệ thống ưu tiên hình ảnh đúng với chủ đề.
Nếu không tìm được ảnh phù hợp, hệ thống không
lấy ảnh ngẫu nhiên của chủ đề khác.
</div>

</div>
</div>

<script>

async function createVideos(){

  const topic =
    document
      .getElementById("topic")
      .value
      .trim();

  const count =
    Number(
      document
        .getElementById("count")
        .value
    );

  const duration =
    Number(
      document
        .getElementById("duration")
        .value
    );

  const button =
    document
      .getElementById("createButton");

  const status =
    document
      .getElementById("status");

  const bar =
    document
      .getElementById("progressBar");

  const downloads =
    document
      .getElementById("downloads");

  if(!topic){

    alert(
      "Hãy nhập chủ đề"
    );

    return;
  }

  button.disabled =
    true;

  downloads.innerHTML =
    "";

  bar.style.width =
    "3%";

  status.textContent =
    "Đang tạo hàng đợi...";

  try{

    const response =
      await fetch(
        "/api/generate",
        {
          method:
            "POST",

          headers:{
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              topic,
              count,
              duration
            })
        }
      );

    const data =
      await response.json();

    if(!response.ok){

      throw new Error(
        data.error ||
        "Không tạo được video"
      );
    }

    for(
      let index = 0;
      index < data.jobs.length;
      index++
    ){

      const jobId =
        data.jobs[index];

      let finished =
        false;

      while(!finished){

        await new Promise(
          resolve =>
            setTimeout(
              resolve,
              1500
            )
        );

        const result =
          await fetch(
            "/api/status/" +
            jobId
          );

        const job =
          await result.json();

        bar.style.width =
          Math.max(
            3,
            Number(
              job.progress || 3
            )
          ) + "%";

        status.textContent =
          "Video " +
          (index + 1) +
          "/" +
          data.jobs.length +
          ": " +
          (
            job.message ||
            "Đang xử lý..."
          );

        if(
          job.status ===
          "done"
        ){

          finished =
            true;

          const link =
            document
              .createElement(
                "a"
              );

          link.className =
            "download";

          link.href =
            "/api/download/" +
            jobId;

          link.textContent =
            "⬇️ TẢI VIDEO " +
            (index + 1);

          downloads.appendChild(
            link
          );
        }

        if(
          job.status ===
          "error"
        ){

          finished =
            true;

          const error =
            document
              .createElement(
                "div"
              );

          error.className =
            "error";

          error.textContent =
            "❌ Video " +
            (index + 1) +
            ": " +
            (
              job.message ||
              "Video lỗi"
            );

          downloads.appendChild(
            error
          );
        }
      }
    }

    bar.style.width =
      "100%";

    status.textContent =
      "✅ Đã hoàn tất";

  }catch(error){

    status.textContent =
      "❌ " +
      error.message;

  }finally{

    button.disabled =
      false;
  }
}

</script>

</body>
</html>
`);
  }
);

/* =========================================================
   START
========================================================= */

app.listen(
  PORT,
  HOST,
  () => {
    console.log(
      "===================================="
    );

    console.log(
      "AI VIDEO FACTORY FINAL"
    );

    console.log(
      "Mode: ANY TOPIC"
    );

    console.log(
      "Server: " +
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
      "===================================="
    );
  }
);
