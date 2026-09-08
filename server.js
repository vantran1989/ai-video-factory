import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 10000);
const HOST = "0.0.0.0";

const WORK_DIR = path.join(__dirname, "work");
const OUTPUT_DIR = path.join(__dirname, "outputs");

const jobs = new Map();
const queue = [];
let processing = false;

await fs.mkdir(WORK_DIR, { recursive: true });
await fs.mkdir(OUTPUT_DIR, { recursive: true });

const app = express();

app.use(express.json({ limit: "1mb" }));

function run(command, args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;

      done = true;

      try {
        child.kill("SIGKILL");
      } catch {}

      reject(new Error(`Timeout khi chạy ${command}`));
    }, timeout);

    child.stdout.on("data", d => {
      stdout += d.toString();
    });

    child.stderr.on("data", d => {
      stderr += d.toString();
    });

    child.on("error", err => {
      if (done) return;

      done = true;
      clearTimeout(timer);

      reject(err);
    });

    child.on("close", code => {
      if (done) return;

      done = true;
      clearTimeout(timer);

      if (code === 0) {
        resolve({
          stdout,
          stderr
        });
      } else {
        reject(
          new Error(
            `${command} lỗi ${code}: ${stderr.slice(-3500)}`
          )
        );
      }
    });
  });
}

async function fetchBuffer(
  url,
  headers = {},
  timeout = 15000
) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, timeout);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      type: response.headers.get("content-type") || ""
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, timeout = 15000) {
  const result = await fetchBuffer(
    url,
    {
      "User-Agent":
        "AI-Video-Factory-V5/1.0"
    },
    timeout
  );

  return JSON.parse(
    result.buffer.toString("utf8")
  );
}

function cleanTopic(value) {
  return String(value || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function words(value) {
  return normalizeText(value)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(x => x.length > 2);
}

function shortText(text, max = 78) {
  let value = String(text || "")
    .replace(/\s+/g, " ")
    .trim();

  if (value.length <= max) {
    return value;
  }

  const cut = value
    .slice(0, max + 1)
    .replace(/\s+\S*$/, "")
    .trim();

  return (
    cut.replace(/[,:;.!?]+$/, "") +
    "."
  );
}

function captionText(text) {
  const value = shortText(text, 78);
  const parts = value.split(" ");

  if (parts.length < 8) {
    return value;
  }

  const middle = Math.ceil(parts.length / 2);

  return (
    parts.slice(0, middle).join(" ") +
    "\n" +
    parts.slice(middle).join(" ")
  );
}

/* =========================================================
   WIKIPEDIA
========================================================= */

async function wikipediaTopic(topic) {
  try {
    const params = new URLSearchParams({
      action: "query",
      list: "search",
      srsearch: topic,
      srnamespace: "0",
      srlimit: "5",
      format: "json",
      origin: "*"
    });

    const data = await fetchJson(
      `https://vi.wikipedia.org/w/api.php?${params}`
    );

    const hit =
      data?.query?.search?.[0];

    if (!hit?.title) {
      return null;
    }

    const title = hit.title;

    const summary =
      await fetchJson(
        `https://vi.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
          title.replace(/ /g, "_")
        )}`
      );

    return {
      title,
      extract: summary?.extract || "",
      thumbnail:
        summary?.thumbnail?.source || null
    };
  } catch (error) {
    console.log(
      "WIKI FALLBACK:",
      error.message
    );

    return null;
  }
}

/* =========================================================
   IMAGE SEARCH
========================================================= */

async function searchCommons(query, topic) {
  try {
    const params = new URLSearchParams({
      action: "query",
      generator: "search",
      gsrsearch: query,
      gsrnamespace: "6",
      gsrlimit: "12",
      prop: "imageinfo",
      iiprop: "url|mime",
      iiurlwidth: "1000",
      format: "json",
      origin: "*"
    });

    const data = await fetchJson(
      `https://commons.wikimedia.org/w/api.php?${params}`
    );

    const topicWords = words(topic)
      .filter(w => w.length > 3);

    const pages = Object.values(
      data?.query?.pages || {}
    );

    const candidates = pages
      .map(page => {
        const info =
          page.imageinfo?.[0];

        const title =
          String(page.title || "");

        if (
          !info?.thumburl ||
          !/^image\/(jpeg|png|webp)$/i.test(
            info.mime || ""
          )
        ) {
          return null;
        }

        const normalized =
          normalizeText(title);

        let score = 0;

        for (const word of topicWords) {
          if (normalized.includes(word)) {
            score += 4;
          }
        }

        if (normalized.includes("photo")) {
          score += 1;
        }

        if (
          normalized.includes("map") &&
          !topicWords.includes("map")
        ) {
          score -= 5;
        }

        if (
          normalized.includes("station") &&
          !topicWords.includes("station")
        ) {
          score -= 8;
        }

        if (
          normalized.includes("bird") &&
          !topicWords.includes("bird")
        ) {
          score -= 8;
        }

        return {
          url: info.thumburl,
          title,
          score
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    return candidates[0]?.url || null;
  } catch (error) {
    console.log(
      "COMMONS SEARCH FALLBACK:",
      error.message
    );

    return null;
  }
}

async function downloadImage(url, output) {
  if (!url) {
    return false;
  }

  try {
    const result =
      await fetchBuffer(
        url,
        {
          "User-Agent":
            "AI-Video-Factory-V5/1.0"
        },
        15000
      );

    if (
      !/^image\//i.test(result.type) ||
      result.buffer.length < 8000 ||
      result.buffer.length >
        10 * 1024 * 1024
    ) {
      return false;
    }

    await fs.writeFile(
      output,
      result.buffer
    );

    return true;
  } catch (error) {
    console.log(
      "IMAGE DOWNLOAD:",
      error.message
    );

    return false;
  }
}

async function prepareImage(
  source,
  output
) {
  await run(
    "ffmpeg",
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      source,
      "-vf",
      "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,setsar=1",
      "-frames:v",
      "1",
      "-q:v",
      "3",
      output
    ],
    30000
  );
}

async function imageIsValid(file) {
  try {
    await run(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=codec_type,width,height",
        "-of",
        "json",
        file
      ],
      15000
    );

    return true;
  } catch {
    return false;
  }
}

async function makeFallbackImage(
  topic,
  sceneTitle,
  output
) {
  const text = captionText(
    `${topic}\n${sceneTitle}`
  ).replace(/\n/g, " ");

  const textFile = path.join(
    path.dirname(output),
    "fallback.txt"
  );

  await fs.writeFile(
    textFile,
    text,
    "utf8"
  );

  await run(
    "ffmpeg",
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=0x17213b:s=720x1280",
      "-vf",
      `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:fontcolor=white:fontsize=46:x=(w-text_w)/2:y=(h-text_h)/2:textfile='${textFile}'`,
      "-frames:v",
      "1",
      output
    ],
    30000
  );
}

/* =========================================================
   TTS
========================================================= */

async function makeGoogleVoice(
  text,
  output
) {
  const query =
    encodeURIComponent(text);

  const url =
    `https://translate.google.com/translate_tts?ie=UTF-8&q=${query}&tl=vi&client=tw-ob`;

  try {
    const result =
      await fetchBuffer(
        url,
        {
          "User-Agent":
            "Mozilla/5.0"
        },
        12000
      );

    if (
      !result.buffer.length ||
      !/audio/i.test(result.type)
    ) {
      throw new Error(
        "TTS không trả audio"
      );
    }

    await fs.writeFile(
      output,
      result.buffer
    );

    await run(
      "ffmpeg",
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        output,
        "-ar",
        "44100",
        "-ac",
        "1",
        "-codec:a",
        "pcm_s16le",
        output + ".wav"
      ],
      20000
    );

    await fs.rename(
      output + ".wav",
      output
    );

    return true;
  } catch (error) {
    console.log(
      "GOOGLE TTS FALLBACK:",
      error.message
    );

    return false;
  }
}

async function makeVoice(
  text,
  output
) {
  const google =
    await makeGoogleVoice(
      text,
      output
    );

  if (google) {
    return;
  }

  await run(
    "espeak-ng",
    [
      "-v",
      "vi",
      "-s",
      "175",
      "-p",
      "48",
      "-a",
      "150",
      "-w",
      output,
      text
    ],
    30000
  );
}

async function mediaDuration(file) {
  const result =
    await run(
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

  const duration =
    Number(result.stdout.trim());

  if (
    !Number.isFinite(duration) ||
    duration <= 0
  ) {
    throw new Error(
      "Không đọc được thời lượng audio"
    );
  }

  return duration;
}

/* =========================================================
   VIDEO MOTION
========================================================= */

function movementFilter(index) {
  if (index % 4 === 0) {
    return "zoompan=z='min(zoom+0.0008,1.08)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=720x1280:fps=30";
  }

  if (index % 4 === 1) {
    return "zoompan=z='min(zoom+0.0007,1.07)':x='iw/2-(iw/zoom/2)-on*0.2':y='ih/2-(ih/zoom/2)':d=1:s=720x1280:fps=30";
  }

  if (index % 4 === 2) {
    return "zoompan=z='max(1.07,zoom-0.0007)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=720x1280:fps=30";
  }

  return "zoompan=z='min(zoom+0.0007,1.07)':x='iw/2-(iw/zoom/2)+on*0.2':y='ih/2-(ih/zoom/2)':d=1:s=720x1280:fps=30";
}

async function makeScene(
  image,
  audio,
  scene,
  output,
  index,
  targetSeconds
) {
  const captionFile =
    path.join(
      path.dirname(output),
      `caption-${index}.txt`
    );

  await fs.writeFile(
    captionFile,
    captionText(scene.text),
    "utf8"
  );

  const audioDuration =
    await mediaDuration(audio);

  const seconds = Math.max(
    2.5,
    Number(targetSeconds || 0),
    audioDuration + 0.05
  );

  const filter = [
    "scale=900:1600:force_original_aspect_ratio=increase",
    "crop=900:1600",
    movementFilter(index),
    "scale=720:1280",
    "drawbox=x=0:y=0:w=iw:h=240:color=black@0.34:t=fill",
    "drawbox=x=24:y=ih-270:w=iw-48:h=225:color=black@0.52:t=fill",
    `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:fontcolor=white:fontsize=34:x=(w-text_w)/2:y=42:textfile='${captionFile}'`
  ].join(",");

  await run(
    "ffmpeg",
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",

      "-loop",
      "1",
      "-framerate",
      "30",
      "-i",
      image,

      "-i",
      audio,

      "-t",
      String(seconds),

      "-map",
      "0:v:0",
      "-map",
      "1:a:0",

      "-vf",
      filter,

      "-r",
      "30",

      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "30",
      "-pix_fmt",
      "yuv420p",

      "-c:a",
      "aac",
      "-b:a",
      "96k",
      "-ar",
      "44100",
      "-ac",
      "1",

      "-af",
      "apad",

      "-movflags",
      "+faststart",

      output
    ],
    Math.max(
      60000,
      seconds * 18000
    )
  );

  return seconds;
}

/* =========================================================
   CONCAT
========================================================= */

async function concatScenes(
  files,
  output
) {
  const list =
    path.join(
      path.dirname(output),
      "concat.txt"
    );

  const lines = files
    .map(
      file =>
        `file '${file.replace(
          /'/g,
          "'\\''"
        )}'`
    )
    .join("\n");

  await fs.writeFile(
    list,
    lines,
    "utf8"
  );

  try {
    await run(
      "ffmpeg",
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
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
      ],
      120000
    );
  } finally {
    await fs.rm(
      list,
      { force: true }
    );
  }
}

/* =========================================================
   VALIDATE
========================================================= */

async function validate(file) {
  const result =
    await run(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        file
      ],
      20000
    );

  const data =
    JSON.parse(result.stdout);

  const video =
    data.streams?.find(
      stream =>
        stream.codec_type ===
        "video"
    );

  const audio =
    data.streams?.find(
      stream =>
        stream.codec_type ===
        "audio"
    );

  return {
    ok: Boolean(video && audio),
    width: Number(
      video?.width || 0
    ),
    height: Number(
      video?.height || 0
    ),
    duration: Number(
      data.format?.duration || 0
    ),
    video:
      video?.codec_name || null,
    audio:
      audio?.codec_name || null
  };
}

/* =========================================================
   FALLBACK SCRIPT
========================================================= */

function fallbackScenes(
  topic,
  wiki,
  style,
  sceneCount
) {
  const extract =
    String(
      wiki?.extract || ""
    )
      .replace(/\s+/g, " ")
      .trim();

  const sentences =
    extract
      .split(/(?<=[.!?])\s+/)
      .filter(
        sentence =>
          sentence.length > 25
      )
      .slice(0, 5);

  const first =
    sentences[0] ||
    `Hãy cùng khám phá ${topic} theo cách ngắn gọn và dễ hiểu.`;

  const second =
    sentences[1] ||
    `Điều đáng chú ý là ${topic} có những đặc điểm rất riêng.`;

  const third =
    sentences[2] ||
    `Chính những đặc điểm đó khiến ${topic} trở nên đáng tìm hiểu.`;

  const fourth =
    sentences[3] ||
    `Đây là một chi tiết thú vị mà nhiều người thường bỏ qua.`;

  const scenes = [
    {
      title:
        "ĐIỀU BẠN CHƯA BIẾT",
      text:
        `Bạn nghĩ mình đã biết hết về ${topic}? Có thể chưa đâu!`,
      query: topic
    },
    {
      title:
        "THÔNG TIN CHÍNH",
      text:
        shortText(first, 78),
      query:
        `${topic} natural`
    },
    {
      title:
        "ĐIỂM ĐẶC BIỆT",
      text:
        shortText(second, 78),
      query:
        `${topic} close up`
    },
    {
      title:
        "ĐÁNG CHÚ Ý",
      text:
        shortText(third, 78),
      query:
        `${topic} action`
    },
    {
      title:
        "MỘT CHI TIẾT HAY",
      text:
        shortText(fourth, 78),
      query:
        `${topic} environment`
    },
    {
      title:
        "CHỐT LẠI",
      text:
        `Nếu thấy thú vị, hãy lưu video và theo dõi để xem phần tiếp theo về ${topic}.`,
      query: topic
    }
  ];

  return scenes.slice(
    0,
    sceneCount
  );
}

/* =========================================================
   OPTIONAL AI SCRIPT
========================================================= */

async function aiScenes(
  topic,
  duration,
  style,
  sceneCount
) {
  const key =
    process.env.OPENAI_API_KEY;

  if (!key) {
    return null;
  }

  const prompt = [
    "Bạn là biên tập viên video dọc Facebook/TikTok bằng tiếng Việt.",
    `Chủ đề: ${topic}`,
    `Phong cách: ${style}`,
    `Thời lượng: ${duration} giây, ${sceneCount} cảnh.`,
    "Tạo đúng JSON: {\"scenes\":[{\"title\":\"\",\"text\":\"\",\"query\":\"\"}]}",
    "Mỗi text 8-18 từ, nói tự nhiên, nhanh, không lan man.",
    "Mỗi query phải mô tả ĐÚNG hình cần tìm và bắt buộc chứa chủ đề.",
    "Không được đổi chủ đề sang vật khác.",
    "Không bịa số liệu nếu không chắc.",
    "Cảnh 1 phải là hook.",
    "Cảnh cuối là CTA ngắn."
  ].join("\n");

  try {
    const response =
      await fetch(
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
            model:
              process.env.OPENAI_MODEL ||
              "gpt-5",
            input: prompt,
            text: {
              format: {
                type:
                  "json_object"
              }
            }
          })
        }
      );

    if (!response.ok) {
      throw new Error(
        `OpenAI HTTP ${response.status}`
      );
    }

    const data =
      await response.json();

    const text =
      data.output_text ||
      data.output
        ?.flatMap(
          x =>
            x.content || []
        )
        .find(
          x =>
            x.type ===
            "output_text"
        )?.text ||
      "";

    const parsed =
      JSON.parse(text);

    if (
      !Array.isArray(
        parsed.scenes
      ) ||
      parsed.scenes.length <
        sceneCount
    ) {
      throw new Error(
        "AI trả thiếu cảnh"
      );
    }

    return parsed.scenes
      .slice(0, sceneCount)
      .map((scene, index) => ({
        title:
          shortText(
            scene.title ||
              `CẢNH ${index + 1}`,
            32
          ),
        text:
          shortText(
            scene.text ||
              `Đây là một điều thú vị về ${topic}.`,
            78
          ),
        query:
          shortText(
            scene.query ||
              topic,
            90
          )
      }));
  } catch (error) {
    console.log(
      "AI SCRIPT FALLBACK:",
      error.message
    );

    return null;
  }
}

/* =========================================================
   BUILD SCRIPT
========================================================= */

async function buildScenes(
  topic,
  duration,
  style
) {
  const sceneCount =
    duration <= 20
      ? 4
      : duration <= 35
        ? 6
        : 8;

  const ai =
    await aiScenes(
      topic,
      duration,
      style,
      sceneCount
    );

  if (ai) {
    return ai;
  }

  const wiki =
    await wikipediaTopic(
      topic
    );

  return fallbackScenes(
    topic,
    wiki,
    style,
    sceneCount
  );
}

/* =========================================================
   PROCESS ONE VIDEO
========================================================= */

async function processVideo(
  job,
  videoIndex
) {
  const topic =
    job.topic;

  const id =
    crypto.randomUUID();

  const dir =
    path.join(
      WORK_DIR,
      id
    );

  const output =
    path.join(
      OUTPUT_DIR,
      `${id}.mp4`
    );

  await fs.mkdir(
    dir,
    { recursive: true }
  );

  const sceneFiles = [];

  try {
    const scenes =
      await buildScenes(
        topic,
        job.duration,
        job.style
      );

    if (!scenes.length) {
      throw new Error(
        "Không tạo được kịch bản."
      );
    }

    job.current =
      `Video ${videoIndex}/${job.count}: đang dựng cảnh 1/${scenes.length}`;

    for (
      let i = 0;
      i < scenes.length;
      i++
    ) {
      const scene =
        scenes[i];

      job.current =
        `Video ${videoIndex}/${job.count}: dựng cảnh ${i + 1}/${scenes.length}`;

      job.progress =
        Math.round(
          (
            (
              videoIndex -
              1 +
              (i + 0.25) /
                scenes.length
            ) /
            job.count
          ) *
            100
        );

      const source =
        path.join(
          dir,
          `source-${i}.img`
        );

      const image =
        path.join(
          dir,
          `image-${i}.jpg`
        );

      const audio =
        path.join(
          dir,
          `audio-${i}.wav`
        );

      const sceneOutput =
        path.join(
          dir,
          `scene-${i}.mp4`
        );

      const query =
        scene.query ||
        `${topic}`;

      let imageUrl =
        await searchCommons(
          query,
          topic
        );

      if (
        !imageUrl &&
        i === 0
      ) {
        const wiki =
          await wikipediaTopic(
            topic
          );

        imageUrl =
          wiki?.thumbnail ||
          null;
      }

      let downloaded =
        await downloadImage(
          imageUrl,
          source
        );

      if (
        !downloaded ||
        !(await imageIsValid(
          source
        ))
      ) {
        await makeFallbackImage(
          topic,
          scene.title,
          source
        );
      }

      await prepareImage(
        source,
        image
      );

      if (
        !(await imageIsValid(
          image
        ))
      ) {
        throw new Error(
          `Ảnh cảnh ${i + 1} không hợp lệ.`
        );
      }

      await makeVoice(
        scene.text,
        audio
      );

      const targetSeconds =
        job.duration /
        scenes.length;

      const sceneSeconds =
        await makeScene(
          image,
          audio,
          scene,
          sceneOutput,
          i,
          targetSeconds
        );

      sceneFiles.push(
        sceneOutput
      );

      job.progress =
        Math.round(
          (
            (
              videoIndex -
              1 +
              (i + 1) /
                scenes.length
            ) /
            job.count
          ) *
            100
        );

      console.log(
        `SCENE ${i + 1}/${scenes.length} OK ${sceneSeconds.toFixed(2)}s`
      );
    }

    job.current =
      `Video ${videoIndex}/${job.count}: ghép MP4`;

    await concatScenes(
      sceneFiles,
      output
    );

    const result =
      await validate(
        output
      );

    if (
      !result.ok ||
      result.width !== 720 ||
      result.height !== 1280
    ) {
      throw new Error(
        "MP4 cuối không đúng 720x1280 hoặc thiếu âm thanh."
      );
    }

    return {
      ok: true,
      index: videoIndex,
      title: topic,
      file:
        `/api/download/${id}`,
      result
    };
  } finally {
    await fs.rm(
      dir,
      {
        recursive: true,
        force: true
      }
    );
  }
}

/* =========================================================
   JOB QUEUE
========================================================= */

async function processJob(job) {
  job.status =
    "processing";

  try {
    for (
      let i = 1;
      i <= job.count;
      i++
    ) {
      const result =
        await processVideo(
          job,
          i
        );

      job.videos.push(
        result
      );
    }

    job.progress = 100;
    job.status = "done";
    job.current =
      "Hoàn tất";
  } catch (error) {
    console.error(
      "JOB ERROR:",
      error
    );

    job.status =
      "failed";

    job.error =
      error.message ||
      String(error);

    job.current =
      "Đã xảy ra lỗi";
  }
}

async function pump() {
  if (
    processing ||
    queue.length === 0
  ) {
    return;
  }

  processing = true;

  const id =
    queue.shift();

  const job =
    jobs.get(id);

  if (job) {
    await processJob(
      job
    );
  }

  processing = false;

  setImmediate(
    pump
  );
}

/* =========================================================
   FRONTEND
========================================================= */

const HTML = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI VIDEO FACTORY V5</title>
<style>
*{box-sizing:border-box}
body{
  margin:0;
  background:#0d1427;
  color:#fff;
  font-family:Arial,sans-serif
}
main{
  max-width:680px;
  margin:auto;
  padding:20px 14px 50px
}
.logo{
  font-size:27px;
  font-weight:900;
  text-align:center
}
.sub{
  text-align:center;
  color:#aeb9d6;
  margin:8px 0 20px
}
.card{
  background:#17213c;
  border:1px solid #2e3b60;
  border-radius:20px;
  padding:18px;
  margin-top:16px
}
label{
  display:block;
  font-weight:800;
  margin:14px 0 7px
}
input,select,button{
  width:100%;
  padding:15px;
  border-radius:14px;
  font-size:17px
}
input,select{
  border:1px solid #415070;
  background:#081126;
  color:#fff
}
button{
  margin-top:20px;
  border:0;
  background:#19b85a;
  color:#fff;
  font-weight:900;
  font-size:19px
}
button:disabled{
  opacity:.55
}
.bar{
  height:13px;
  background:#293650;
  border-radius:20px;
  overflow:hidden;
  margin-top:12px
}
.fill{
  height:100%;
  background:#27c6ff;
  width:0
}
.ok{
  color:#62ee9a
}
.err{
  color:#ff8b8b
}
.small{
  font-size:13px;
  color:#aeb9d6;
  line-height:1.5
}
.download{
  display:block;
  background:#19b85a;
  color:#fff;
  text-decoration:none;
  text-align:center;
  font-weight:900;
  padding:15px;
  border-radius:14px;
  margin-top:12px
}
</style>
</head>

<body>

<main>

<div class="logo">
🎬 AI VIDEO FACTORY V5
</div>

<div class="sub">
Video dọc 9:16 — cảnh đúng chủ đề — lời thoại ngắn — phụ đề dễ đọc
</div>

<div class="card">

<label>Chủ đề</label>

<input
 id="topic"
 value="Cá mập"
 placeholder="Ví dụ: Cá mập, khủng long, du lịch Việt Nam..."
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

<label>Phong cách</label>

<select id="style">
<option value="viral">🔥 Viral / cuốn hút</option>
<option value="kiến thức">📚 Kiến thức</option>
<option value="kể chuyện">🎭 Kể chuyện</option>
</select>

<button
 id="go"
 onclick="generate()"
>
🎥 TẠO VIDEO
</button>

<div
 class="small"
 style="margin-top:12px"
>
V5 ưu tiên ảnh đúng chủ đề, 6 cảnh cho video 30 giây, chuyển động nhẹ, phụ đề ngắn và xử lý video theo hàng đợi để giảm lỗi Render.
</div>

</div>

<div id="result"></div>

</main>

<script>

let timer = null;

async function generate(){

  const topic =
    document
      .getElementById("topic")
      .value
      .trim();

  if(!topic){
    alert("Hãy nhập chủ đề.");
    return;
  }

  const btn =
    document.getElementById("go");

  btn.disabled = true;
  btn.textContent =
    "⏳ ĐANG XẾP HÀNG...";

  try{

    const response =
      await fetch(
        "/api/generate",
        {
          method:"POST",
          headers:{
            "Content-Type":
              "application/json"
          },
          body:JSON.stringify({
            topic:topic,
            count:Number(
              document
                .getElementById("count")
                .value
            ),
            duration:Number(
              document
                .getElementById("duration")
                .value
            ),
            style:
              document
                .getElementById("style")
                .value
          })
        }
      );

    const data =
      await response.json();

    if(
      !response.ok ||
      !data.ok
    ){
      throw new Error(
        data.error ||
        "Không tạo được job"
      );
    }

    renderJob(
      data.job
    );

    poll(
      data.job.id
    );

  }catch(error){

    document
      .getElementById("result")
      .innerHTML =
      '<div class="card err">❌ ' +
      error.message +
      '</div>';

    btn.disabled = false;
    btn.textContent =
      "🎥 TẠO VIDEO";
  }
}

function poll(id){

  if(timer){
    clearInterval(timer);
  }

  timer =
    setInterval(
      async () => {

        try{

          const response =
            await fetch(
              "/api/status/" +
              id
            );

          const data =
            await response.json();

          if(!data.ok){
            throw new Error(
              data.error ||
              "Không đọc được trạng thái"
            );
          }

          renderJob(
            data.job
          );

          if(
            data.job.status ===
              "done" ||
            data.job.status ===
              "failed"
          ){

            clearInterval(
              timer
            );

            const btn =
              document
                .getElementById(
                  "go"
                );

            btn.disabled = false;

            btn.textContent =
              "🎥 TẠO VIDEO";
          }

        }catch(error){

          clearInterval(
            timer
          );

          document
            .getElementById(
              "result"
            )
            .innerHTML =
            '<div class="card err">❌ ' +
            error.message +
            '</div>';

          const btn =
            document
              .getElementById(
                "go"
              );

          btn.disabled = false;

          btn.textContent =
            "🎥 TẠO VIDEO";
        }

      },
      1500
    );
}

function renderJob(job){

  let html =
    '<div class="card">' +
    '<b>' +
    escapeHtml(
      job.current ||
      "Đang xử lý..."
    ) +
    '</b>' +

    '<div class="bar">' +
    '<div class="fill" style="width:' +
    Math.max(
      0,
      Math.min(
        100,
        job.progress || 0
      )
    ) +
    '%"></div>' +
    '</div>' +

    '<div class="small" style="margin-top:8px">' +
    (job.progress || 0) +
    '%' +
    '</div>' +

    '</div>';

  for(
    const video of
    job.videos || []
  ){

    if(video.ok){

      html +=
        '<div class="card">' +

        '<b class="ok">' +
        '✅ VIDEO ' +
        video.index +
        ' HOÀN TẤT' +
        '</b>' +

        '<div class="small">' +
        (video.result?.width || 720) +
        "×" +
        (video.result?.height || 1280) +
        " • " +
        Number(
          video.result?.duration || 0
        ).toFixed(1) +
        " giây • hình + âm thanh OK" +
        '</div>' +

        '<a class="download" href="' +
        video.file +
        '">' +
        '⬇️ TẢI MP4' +
        '</a>' +

        '</div>';

    }else{

      html +=
        '<div class="card err">' +
        '❌ Video ' +
        video.index +
        ' lỗi: ' +
        escapeHtml(
          video.error ||
          "Không xác định"
        ) +
        '</div>';
    }
  }

  if(
    job.status ===
    "failed"
  ){

    html +=
      '<div class="card err">' +
      '❌ ' +
      escapeHtml(
        job.error ||
        "Job lỗi"
      ) +
      '</div>';
  }

  document
    .getElementById(
      "result"
    )
    .innerHTML =
    html;
}

function escapeHtml(value){

  return String(
    value || ""
  ).replace(
    /[&<>"']/g,
    function(character){

      return {
        "&":"&amp;",
        "<":"&lt;",
        ">":"&gt;",
        '"':"&quot;",
        "'":"&#39;"
      }[character];

    }
  );
}

</script>

</body>
</html>`;

app.get(
  "/",
  (_req, res) =>
    res
      .type("html")
      .send(HTML)
);

app.get(
  "/api/health",
  (_req, res) =>
    res.json({
      ok:true,
      service:
        "AI VIDEO FACTORY V5",
      aiScript:
        Boolean(
          process.env.OPENAI_API_KEY
        )
    })
);

app.post(
  "/api/generate",
  (req, res) => {

    const topic =
      cleanTopic(
        req.body?.topic
      );

    if(!topic){

      return res
        .status(400)
        .json({
          ok:false,
          error:
            "Hãy nhập chủ đề."
        });
    }

    const count =
      Math.max(
        1,
        Math.min(
          Number(
            req.body?.count || 1
          ),
          3
        )
      );

    const duration =
      Math.max(
        15,
        Math.min(
          Number(
            req.body?.duration ||
            30
          ),
          60
        )
      );

    const style =
      String(
        req.body?.style ||
        "viral"
      );

    const id =
      crypto.randomUUID();

    const job = {
      id,
      topic,
      count,
      duration,
      style,
      status:
        "queued",
      progress:0,
      current:
        "Đã nhận yêu cầu, đang chờ xử lý...",
      videos:[],
      error:null,
      createdAt:
        Date.now()
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
      ok:true,
      job:{
        id,
        status:
          job.status,
        progress:
          job.progress,
        current:
          job.current,
        videos:[]
      }
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

    if(!job){

      return res
        .status(404)
        .json({
          ok:false,
          error:
            "Job không tồn tại."
        });
    }

    res.json({
      ok:true,
      job:{
        id:job.id,
        status:
          job.status,
        progress:
          job.progress,
        current:
          job.current,
        videos:
          job.videos,
        error:
          job.error
      }
    });
  }
);

app.get(
  "/api/download/:id",
  async (req, res) => {

    if(
      !/^[a-f0-9-]{36}$/i.test(
        req.params.id
      )
    ){

      return res
        .status(400)
        .send(
          "ID không hợp lệ"
        );
    }

    const file =
      path.join(
        OUTPUT_DIR,
        `${req.params.id}.mp4`
      );

    try{

      await fs.access(
        file
      );

      res.download(
        file,
        `facebook-video-${req.params.id}.mp4`
      );

    }catch{

      res
        .status(404)
        .send(
          "Video không tồn tại hoặc Render đã khởi động lại."
        );
    }
  }
);

app.use(
  (_req, res) =>
    res
      .status(404)
      .json({
        ok:false,
        error:
          "Không tìm thấy đường dẫn."
      })
);

app.listen(
  PORT,
  HOST,
  () => {

    console.log(
      "========================================"
    );

    console.log(
      " AI VIDEO FACTORY V5"
    );

    console.log(
      `Server: http://${HOST}:${PORT}`
    );

    console.log(
      `AI script: ${
        process.env.OPENAI_API_KEY
          ? "ON"
          : "OFF"
      }`
    );

    console.log(
      "Ready."
    );

    console.log(
      "========================================"
    );
  }
);
