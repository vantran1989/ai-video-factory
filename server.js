import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(exec);

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

function id() {
  return crypto.randomBytes(8).toString("hex");
}

function safeName(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "video";
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run(cmd, args, options = {}) {
  return exec(cmd, args, {
    maxBuffer: 20 * 1024 * 1024,
    ...options
  });
}

async function downloadFile(url, output) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "AI-Video-Factory/3.0"
    }
  });

  if (!res.ok) {
    throw new Error(`Download lỗi ${res.status}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(output, buffer);

  if (!fs.existsSync(output) || fs.statSync(output).size < 100) {
    throw new Error("File tải về không hợp lệ");
  }

  return output;
}

function normalizeTopic(topic) {
  return String(topic || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function buildScenes(topic, style, duration) {
  const t = normalizeTopic(topic);

  const hooks = {
    viral: [
      `Bạn có biết điều này về ${t} không?`,
      `Sự thật về ${t} có thể khiến bạn bất ngờ!`,
      `Đừng bỏ qua điều thú vị này về ${t}.`
    ],
    knowledge: [
      `Hãy cùng tìm hiểu nhanh về ${t}.`,
      `Có một điều rất thú vị về ${t}.`,
      `Bạn cần biết điều này về ${t}.`
    ],
    story: [
      `Câu chuyện về ${t} bắt đầu như thế này...`,
      `Hãy thử tưởng tượng bạn đang khám phá ${t}.`,
      `Và đây là điều bất ngờ về ${t}...`
    ]
  };

  const bodies = [
    `Điều đầu tiên: ${t} có nhiều điểm khiến chúng ta tò mò.`,
    `Quan sát kỹ sẽ thấy ${t} có những đặc điểm rất đặc biệt.`,
    `Một điểm đáng chú ý của ${t} là cách nó thay đổi theo hoàn cảnh.`,
    `Đây cũng là lý do ${t} thường được nhiều người quan tâm.`,
    `Nếu tìm hiểu sâu hơn, bạn sẽ thấy ${t} còn nhiều điều thú vị.`,
    `Điều quan trọng là đừng chỉ nhìn ${t} ở góc độ quen thuộc.`,
    `Một chi tiết nhỏ đôi khi lại giúp chúng ta hiểu rõ hơn về ${t}.`,
    `Càng tìm hiểu, chúng ta càng thấy ${t} thú vị hơn.`,
    `Đây là một trong những điều khiến ${t} trở nên đáng khám phá.`,
    `Và đó mới chỉ là phần đầu của câu chuyện về ${t}.`
  ];

  const cta = [
    `Bạn thấy ${t} thú vị không?`,
    `Nếu thích chủ đề này, hãy theo dõi để xem phần tiếp theo.`,
    `Lưu video này để xem lại khi cần.`,
    `Bạn muốn mình làm video nào tiếp theo?`,
    `Hãy bình luận chủ đề bạn muốn khám phá.`
  ];

  let count = 5;

  if (duration === 30) count = 6;
  if (duration === 60) count = 12;

  const result = [];

  for (let i = 0; i < count; i++) {
    let text;

    if (i === 0) {
      text = hooks[style]?.[0] || hooks.viral[0];
    } else if (i === count - 1) {
      text = cta[i % cta.length];
    } else {
      text = bodies[(i - 1) % bodies.length];
    }

    result.push({
      index: i + 1,
      text
    });
  }

  return result;
}

/* =========================
   IMAGE SEARCH
========================= */

async function wikipediaImage(topic) {
  try {
    const url =
      "https://vi.wikipedia.org/api/rest_v1/page/summary/" +
      encodeURIComponent(topic.replace(/\s+/g, "_"));

    const res = await fetch(url, {
      headers: {
        "User-Agent": "AI-Video-Factory/3.0"
      }
    });

    if (!res.ok) return null;

    const data = await res.json();

    return (
      data?.originalimage?.source ||
      data?.thumbnail?.source ||
      null
    );
  } catch {
    return null;
  }
}

async function commonsImages(query, limit = 10) {
  const api =
    "https://commons.wikimedia.org/w/api.php" +
    "?action=query" +
    "&generator=search" +
    "&gsrnamespace=6" +
    "&gsrsearch=" +
    encodeURIComponent(query) +
    "&gsrlimit=" +
    limit +
    "&prop=imageinfo" +
    "&iiprop=url" +
    "&iiurlwidth=1000" +
    "&format=json" +
    "&origin=*";

  try {
    const res = await fetch(api, {
      headers: {
        "User-Agent": "AI-Video-Factory/3.0"
      }
    });

    if (!res.ok) return [];

    const data = await res.json();

    return Object.values(data?.query?.pages || {})
      .map(
        x =>
          x?.imageinfo?.[0]?.thumburl ||
          x?.imageinfo?.[0]?.url
      )
      .filter(Boolean)
      .filter(url =>
        /\.(jpg|jpeg|png|webp)(\?|$)/i.test(url)
      );
  } catch {
    return [];
  }
}

function sceneSearchTerms(topic, index) {
  const generic = [
    "photo",
    "real photo",
    "nature photo",
    "documentary photo",
    "close up",
    "detail",
    "landscape",
    "environment",
    "people"
  ];

  const extra = generic[index % generic.length];

  return [
    `${topic} ${extra}`,
    `${topic} photography`,
    `${topic}`,
    `${topic} photo`
  ];
}

async function getSceneImage(topic, index, used) {
  if (index === 1) {
    const wiki = await wikipediaImage(topic);

    if (wiki && !used.has(wiki)) {
      return wiki;
    }
  }

  for (const query of sceneSearchTerms(topic, index)) {
    const images = await commonsImages(query, 12);

    for (const url of images) {
      if (!used.has(url)) {
        return url;
      }
    }
  }

  return null;
}

/* =========================
   FALLBACK IMAGE
========================= */

async function createFallbackImage(
  file,
  topic,
  sceneNumber
) {
  const escaped = String(topic)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280">
  <rect width="720" height="1280" fill="#111827"/>

  <circle
    cx="360"
    cy="400"
    r="170"
    fill="#1f2937"
  />

  <text
    x="360"
    y="390"
    text-anchor="middle"
    fill="white"
    font-size="46"
    font-family="DejaVu Sans"
  >
    AI VIDEO
  </text>

  <text
    x="360"
    y="470"
    text-anchor="middle"
    fill="white"
    font-size="30"
    font-family="DejaVu Sans"
  >
    ${escaped}
  </text>

  <text
    x="360"
    y="530"
    text-anchor="middle"
    fill="#d1d5db"
    font-size="24"
    font-family="DejaVu Sans"
  >
    Cảnh ${sceneNumber}
  </text>
</svg>`;

  const svgFile = file + ".svg";

  fs.writeFileSync(svgFile, svg);

  await run("ffmpeg", [
    "-y",
    "-i",
    svgFile,
    "-frames:v",
    "1",
    file
  ]);

  try {
    fs.unlinkSync(svgFile);
  } catch {}

  return file;
}

/* =========================
   VOICE
========================= */

async function googleTTS(text, output) {
  const clean = String(text)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 250);

  const url =
    "https://translate.google.com/translate_tts" +
    "?ie=UTF-8" +
    "&client=tw-ob" +
    "&tl=vi" +
    "&q=" +
    encodeURIComponent(clean);

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept":
        "audio/mpeg,audio/*;q=0.9,*/*;q=0.8"
    }
  });

  if (!res.ok) {
    throw new Error(
      `Google TTS ${res.status}`
    );
  }

  const buffer = Buffer.from(
    await res.arrayBuffer()
  );

  if (buffer.length < 1000) {
    throw new Error(
      "Google TTS trả về file quá nhỏ"
    );
  }

  fs.writeFileSync(output, buffer);

  return output;
}

async function espeakTTS(text, output) {
  await run("espeak-ng", [
    "-v",
    "vi",
    "-s",
    "145",
    "-p",
    "48",
    "-a",
    "175",
    "-w",
    output,
    text
  ]);

  return output;
}

async function createVoice(text, output) {
  try {
    await googleTTS(text, output);
    console.log("TTS: Google");
    return "google";
  } catch (error) {
    console.log(
      "Google TTS lỗi, chuyển sang eSpeak:",
      error.message
    );

    await espeakTTS(text, output);

    console.log("TTS: eSpeak fallback");

    return "espeak";
  }
}

/* =========================
   MAKE VIDEO SCENE
========================= */

async function makeScene({
  image,
  audio,
  output,
  text,
  duration
}) {
  const font =
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

  const safeText = String(text)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");

  const filter =
    `[0:v]` +
    `scale=720:1280:force_original_aspect_ratio=increase,` +
    `crop=720:1280,` +
    `zoompan=` +
    `z='min(zoom+0.0018,1.12)':` +
    `d=125:` +
    `s=720x1280:` +
    `fps=25,` +
    `drawtext=` +
    `fontfile=${font}:` +
    `text='${safeText}':` +
    `fontcolor=white:` +
    `fontsize=42:` +
    `line_spacing=10:` +
    `borderw=4:` +
    `bordercolor=black:` +
    `box=1:` +
    `boxcolor=black@0.58:` +
    `boxborderw=22:` +
    `x=(w-text_w)/2:` +
    `y=h-260` +
    `[v]`;

  await run("ffmpeg", [
    "-y",
    "-loop",
    "1",
    "-i",
    image,
    "-i",
    audio,
    "-filter_complex",
    filter,
    "-map",
    "[v]",
    "-map",
    "1:a",
    "-t",
    String(duration),
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
    "80k",
    "-af",
    "apad",
    "-shortest",
    "-movflags",
    "+faststart",
    output
  ]);
}

/* =========================
   CONCAT
========================= */

async function concatVideos(files, output) {
  const listFile = output + ".txt";

  const content = files
    .map(
      file =>
        `file '${file.replace(/'/g, "'\\''")}'`
    )
    .join("\n");

  fs.writeFileSync(listFile, content);

  await run("ffmpeg", [
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
  ]);

  try {
    fs.unlinkSync(listFile);
  } catch {}

  return output;
}

/* =========================
   PROCESS QUEUE
========================= */

async function processQueue() {
  if (processing) return;

  const jobId = queue.shift();

  if (!jobId) return;

  const job = jobs.get(jobId);

  if (!job) {
    setImmediate(processQueue);
    return;
  }

  processing = true;

  try {
    await processJob(job);
  } catch (error) {
    console.error("JOB ERROR:", error);

    job.status = "error";
    job.error =
      error?.message ||
      String(error);
    job.finishedAt = Date.now();
  }

  processing = false;

  setImmediate(processQueue);
}

async function processJob(job) {
  job.status = "processing";
  job.progress = 1;
  job.message =
    "Đang chuẩn bị nội dung...";

  const scenes = buildScenes(
    job.topic,
    job.style,
    job.duration
  );

  job.totalScenes =
    scenes.length * job.count;

  job.doneScenes = 0;

  const jobDir =
    path.join(WORK_DIR, job.id);

  fs.mkdirSync(jobDir, {
    recursive: true
  });

  const usedImages = new Set();

  for (
    let videoIndex = 1;
    videoIndex <= job.count;
    videoIndex++
  ) {
    job.message =
      `Đang tạo video ${videoIndex}/${job.count}...`;

    const sceneFiles = [];

    const sceneDuration =
      job.duration / scenes.length;

    for (const scene of scenes) {
      job.message =
        `Video ${videoIndex}/${job.count} — cảnh ${scene.index}/${scenes.length}`;

      const sceneDir =
        path.join(
          jobDir,
          `video-${videoIndex}`
        );

      fs.mkdirSync(sceneDir, {
        recursive: true
      });

      const imageFile =
        path.join(
          sceneDir,
          `scene-${scene.index}.jpg`
        );

      const audioFile =
        path.join(
          sceneDir,
          `scene-${scene.index}.mp3`
        );

      const videoFile =
        path.join(
          sceneDir,
          `scene-${scene.index}.mp4`
        );

      let imageUrl = null;

      try {
        imageUrl =
          await getSceneImage(
            job.topic,
            scene.index,
            usedImages
          );
      } catch (error) {
        console.log(
          "IMAGE SEARCH ERROR:",
          error.message
        );
      }

      let imageReady = false;

      if (imageUrl) {
        try {
          await downloadFile(
            imageUrl,
            imageFile
          );

          imageReady = true;
          usedImages.add(imageUrl);
        } catch (error) {
          console.log(
            "IMAGE DOWNLOAD ERROR:",
            error.message
          );
        }
      }

      if (!imageReady) {
        await createFallbackImage(
          imageFile,
          job.topic,
          scene.index
        );
      }

      await createVoice(
        scene.text,
        audioFile
      );

      await makeScene({
        image: imageFile,
        audio: audioFile,
        output: videoFile,
        text: scene.text,
        duration: sceneDuration
      });

      sceneFiles.push(videoFile);

      job.doneScenes++;

      job.progress =
        Math.min(
          99,
          Math.round(
            (job.doneScenes /
              job.totalScenes) *
              100
          )
        );
    }

    const finalFile =
      path.join(
        OUTPUT_DIR,
        `${job.id}-video-${videoIndex}.mp4`
      );

    await concatVideos(
      sceneFiles,
      finalFile
    );

    job.outputs.push({
      index: videoIndex,
      file: finalFile,
      name:
        `${safeName(job.topic)}-facebook-${videoIndex}.mp4`
    });

    job.progress =
      Math.min(
        99,
        Math.round(
          (videoIndex /
            job.count) *
            100
        )
      );

    await sleep(300);
  }

  job.progress = 100;
  job.status = "done";
  job.message = "Hoàn thành!";
  job.finishedAt = Date.now();

  try {
    fs.rmSync(jobDir, {
      recursive: true,
      force: true
    });
  } catch {}
}

/* =========================
   API
========================= */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    app: "AI VIDEO FACTORY V3",
    time: new Date().toISOString()
  });
});

app.post("/api/generate", (req, res) => {
  const topic =
    normalizeTopic(
      req.body?.topic
    );

  if (!topic) {
    return res.status(400).json({
      error:
        "Vui lòng nhập chủ đề."
    });
  }

  let count =
    Number(
      req.body?.count || 1
    );

  if (!Number.isFinite(count)) {
    count = 1;
  }

  count =
    Math.max(
      1,
      Math.min(
        3,
        Math.round(count)
      )
    );

  let duration =
    Number(
      req.body?.duration || 30
    );

  if (
    ![15, 30, 60].includes(
      duration
    )
  ) {
    duration = 30;
  }

  const style =
    ["viral", "knowledge", "story"]
      .includes(
        req.body?.style
      )
      ? req.body.style
      : "viral";

  const jobId = id();

  const job = {
    id: jobId,
    topic,
    count,
    duration,
    style,
    status: "queued",
    progress: 0,
    message: "Đang xếp hàng...",
    totalScenes: 0,
    doneScenes: 0,
    outputs: [],
    createdAt: Date.now(),
    finishedAt: null,
    error: null
  };

  jobs.set(
    jobId,
    job
  );

  queue.push(jobId);

  processQueue();

  res.json({
    ok: true,
    id: jobId,
    count,
    duration
  });
});

app.get(
  "/api/status/:id",
  (req, res) => {
    const job =
      jobs.get(
        req.params.id
      );

    if (!job) {
      return res.status(404).json({
        error:
          "Không tìm thấy tiến trình."
      });
    }

    res.json({
      id: job.id,
      topic: job.topic,
      count: job.count,
      duration: job.duration,
      style: job.style,
      status: job.status,
      progress: job.progress,
      message: job.message,
      totalScenes:
        job.totalScenes,
      doneScenes:
        job.doneScenes,

      outputs:
        job.outputs.map(
          x => ({
            index: x.index,
            name: x.name,
            url:
              `/api/download/${job.id}/${x.index}`
          })
        ),

      error: job.error
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
      return res
        .status(404)
        .send(
          "Không tìm thấy video."
        );
    }

    const index =
      Number(
        req.params.index
      );

    const item =
      job.outputs.find(
        x =>
          x.index === index
      );

    if (
      !item ||
      !fs.existsSync(
        item.file
      )
    ) {
      return res
        .status(404)
        .send(
          "Video không còn trên máy chủ."
        );
    }

    res.download(
      item.file,
      item.name
    );
  }
);

/* =========================
   FRONTEND
========================= */

app.get("/", (req, res) => {
  res.send(`<!doctype html>
<html lang="vi">

<head>

<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>
AI VIDEO FACTORY V3
</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: Arial, sans-serif;
  background: #0b1020;
  color: white;
}

.container {
  max-width: 760px;
  margin: auto;
  padding: 22px 16px 50px;
}

h1 {
  text-align: center;
  margin: 8px 0 6px;
  font-size: 28px;
}

.subtitle {
  text-align: center;
  color: #aab4cc;
  margin-bottom: 24px;
}

.card {
  background: #151c30;
  border-radius: 18px;
  padding: 18px;
  margin-bottom: 16px;
  border: 1px solid #27304a;
}

label {
  display: block;
  font-weight: bold;
  margin-bottom: 8px;
}

input,
select,
button {
  width: 100%;
  border-radius: 12px;
  border: 0;
  padding: 14px;
  font-size: 16px;
}

input,
select {
  background: #0e1424;
  color: white;
  border: 1px solid #303a56;
  margin-bottom: 15px;
}

button {
  background: #2563eb;
  color: white;
  font-weight: bold;
  cursor: pointer;
  margin-top: 5px;
}

button:disabled {
  opacity: .55;
}

.progress-wrap {
  background: #0d1322;
  border-radius: 10px;
  overflow: hidden;
  height: 16px;
  margin: 12px 0;
}

.progress {
  height: 100%;
  width: 0%;
  background: #22c55e;
  transition: width .3s;
}

.status {
  color: #cbd5e1;
  line-height: 1.5;
}

.download {
  display: block;
  text-decoration: none;
  text-align: center;
  background: #16a34a;
  color: white;
  padding: 13px;
  border-radius: 12px;
  margin-top: 10px;
  font-weight: bold;
}

.small {
  font-size: 13px;
  color: #94a3b8;
  line-height: 1.5;
}

</style>

</head>

<body>

<div class="container">

<h1>
🎬 AI VIDEO FACTORY V3
</h1>

<div class="subtitle">
Tạo video Facebook dọc 9:16 tự động
</div>

<div class="card">

<label>
Chủ đề video
</label>

<input
  id="topic"
  placeholder="Ví dụ: Cá mập, Khủng long, Ai Cập cổ đại..."
>

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

<label>
Thời lượng
</label>

<select id="duration">

<option value="15">
15 giây — nhanh, dễ render
</option>

<option
  value="30"
  selected
>
30 giây — khuyên dùng
</option>

<option value="60">
60 giây — nhiều cảnh hơn
</option>

</select>

<label>
Phong cách
</label>

<select id="style">

<option value="viral">
🔥 Viral / cuốn hút
</option>

<option value="knowledge">
📚 Kiến thức
</option>

<option value="story">
📖 Kể chuyện
</option>

</select>

<button id="create">
🚀 TẠO VIDEO
</button>

</div>

<div class="card">

<div
  id="status"
  class="status"
>
Chưa có video nào.
</div>

<div class="progress-wrap">

<div
  id="progress"
  class="progress"
></div>

</div>

<div id="downloads">
</div>

<div class="small">
💡 Video 9:16 • nhiều cảnh • hình ảnh • chuyển động • phụ đề • giọng tiếng Việt.
</div>

</div>

</div>

<script>

const topic =
  document.getElementById(
    "topic"
  );

const count =
  document.getElementById(
    "count"
  );

const duration =
  document.getElementById(
    "duration"
  );

const style =
  document.getElementById(
    "style"
  );

const create =
  document.getElementById(
    "create"
  );

const statusEl =
  document.getElementById(
    "status"
  );

const progressEl =
  document.getElementById(
    "progress"
  );

const downloadsEl =
  document.getElementById(
    "downloads"
  );

let timer = null;

function showStatus(text) {
  statusEl.textContent =
    text;
}

async function poll(jobId) {

  try {

    const response =
      await fetch(
        "/api/status/" +
        jobId
      );

    const job =
      await response.json();

    if (!response.ok) {
      throw new Error(
        job.error ||
        "Lỗi trạng thái"
      );
    }

    progressEl.style.width =
      Math.max(
        0,
        Math.min(
          100,
          job.progress || 0
        )
      ) + "%";

    showStatus(
      job.message +
      " (" +
      (job.progress || 0) +
      "%)"
    );

    if (
      job.status ===
      "done"
    ) {

      clearInterval(timer);

      create.disabled =
        false;

      showStatus(
        "🎉 Hoàn thành " +
        job.count +
        " video!"
      );

      downloadsEl.innerHTML =
        job.outputs.map(
          function(video) {

            return (
              '<a class="download" href="' +
              video.url +
              '">' +
              '⬇️ TẢI VIDEO ' +
              video.index +
              '</a>'
            );

          }
        ).join("");

      return;
    }

    if (
      job.status ===
      "error"
    ) {

      clearInterval(timer);

      create.disabled =
        false;

      showStatus(
        "❌ Lỗi: " +
        (
          job.error ||
          "Không xác định"
        )
      );

    }

  } catch (error) {

    showStatus(
      "⚠️ Đang kết nối lại..."
    );

  }

}

create.addEventListener(
  "click",
  async function() {

    const value =
      topic.value.trim();

    if (!value) {

      alert(
        "Bạn hãy nhập chủ đề trước."
      );

      topic.focus();

      return;
    }

    clearInterval(timer);

    create.disabled =
      true;

    progressEl.style.width =
      "0%";

    downloadsEl.innerHTML =
      "";

    showStatus(
      "⏳ Đang tạo yêu cầu..."
    );

    try {

      const response =
        await fetch(
          "/api/generate",
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json"
            },

            body:
              JSON.stringify({
                topic: value,
                count:
                  Number(
                    count.value
                  ),
                duration:
                  Number(
                    duration.value
                  ),
                style:
                  style.value
              })
          }
        );

      const data =
        await response.json();

      if (!response.ok) {

        throw new Error(
          data.error ||
          "Không tạo được video"
        );

      }

      showStatus(
        "⏳ Đã nhận yêu cầu. Đang xử lý..."
      );

      await poll(
        data.id
      );

      timer =
        setInterval(
          function() {
            poll(data.id);
          },
          2500
        );

    } catch (error) {

      create.disabled =
        false;

      showStatus(
        "❌ " +
        error.message
      );

    }

  }
);

</script>

</body>

</html>`);
});

/* =========================
   START SERVER
========================= */

app.listen(
  PORT,
  HOST,
  function() {

    console.log(
      "================================="
    );

    console.log(
      " AI VIDEO FACTORY V3"
    );

    console.log(
      "================================="
    );

    console.log(
      `Server: http://${HOST}:${PORT}`
    );

    console.log(
      "Ready."
    );

  }
);
