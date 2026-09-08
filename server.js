import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import crypto from "crypto";

const app = express();

const PORT = Number(process.env.PORT) || 10000;
const HOST = "0.0.0.0";

const ROOT = process.cwd();
const WORK = path.join(ROOT, "work");
const OUTPUT = path.join(ROOT, "output");

fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(OUTPUT, { recursive: true });

app.use(express.json({ limit: "1mb" }));

const jobs = new Map();
const queue = [];
let processing = false;

function id() {
  return crypto.randomBytes(8).toString("hex");
}

function safeText(value, fallback = "") {
  return String(value ?? fallback)
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanTopic(value) {
  const text = safeText(value, "Khám phá thế giới");
  return text.slice(0, 160);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      ...options
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            `${command} exited with code ${code}\n${stderr.slice(-4000)}`
          )
        );
      }
    });
  });
}

async function downloadFile(url, target) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "FacebookVideoTool/2.0"
    }
  });

  if (!response.ok) {
    throw new Error(`Download failed: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(target, buffer);

  if (buffer.length < 1000) {
    throw new Error("Downloaded file is too small");
  }

  return target;
}

function buildScenes(topic, style, videoIndex) {
  const t = topic;

  const sceneSets = {
    viral: [
      {
        title: `Bạn có biết?`,
        text: `Có một điều rất thú vị về ${t} mà nhiều người chưa biết.`
      },
      {
        title: `Điều bất ngờ`,
        text: `Điểm đặc biệt của ${t} khiến chủ đề này được rất nhiều người quan tâm.`
      },
      {
        title: `Sự thật thú vị`,
        text: `Khi tìm hiểu kỹ hơn, ${t} còn có nhiều chi tiết đáng ngạc nhiên.`
      },
      {
        title: `Bạn nghĩ sao?`,
        text: `Nếu thấy thông tin này thú vị, hãy chia sẻ video và theo dõi để xem phần tiếp theo.`
      }
    ],
    knowledge: [
      {
        title: `Tìm hiểu về ${t}`,
        text: `${t} là một chủ đề rất đáng để tìm hiểu vì có nhiều điều thú vị phía sau.`
      },
      {
        title: `Điểm quan trọng`,
        text: `Một trong những điều đáng chú ý nhất khi nói về ${t} là những đặc điểm riêng biệt của nó.`
      },
      {
        title: `Điều ít người biết`,
        text: `Có những thông tin về ${t} thường bị bỏ qua nhưng lại rất đáng chú ý.`
      },
      {
        title: `Kết luận`,
        text: `Đó là một vài điểm thú vị về ${t}. Hãy lưu video để xem lại khi cần.`
      }
    ],
    story: [
      {
        title: `Một câu chuyện`,
        text: `Hãy bắt đầu câu chuyện về ${t} bằng một điều mà có thể bạn chưa từng để ý.`
      },
      {
        title: `Điều xảy ra`,
        text: `Càng tìm hiểu về ${t}, chúng ta càng thấy câu chuyện trở nên thú vị hơn.`
      },
      {
        title: `Điểm bất ngờ`,
        text: `Và đây chính là phần khiến nhiều người bất ngờ nhất khi khám phá ${t}.`
      },
      {
        title: `Bạn sẽ chọn gì?`,
        text: `Nếu bạn muốn biết thêm những câu chuyện như thế này, hãy theo dõi kênh.`
      }
    ]
  };

  const selected =
    sceneSets[style] || sceneSets.viral;

  return selected.map((scene, index) => ({
    ...scene,
    search: `${t} ${index === 0 ? "" : index === 1 ? "nature" : index === 2 ? "detail" : "landscape"}`.trim(),
    videoIndex
  }));
}

async function findImage(search, target) {
  try {
    const api =
      "https://commons.wikimedia.org/w/api.php" +
      "?action=query" +
      "&generator=search" +
      "&gsrsearch=" +
      encodeURIComponent(search) +
      "&gsrnamespace=6" +
      "&gsrlimit=8" +
      "&prop=imageinfo" +
      "&iiprop=url" +
      "&iiurlwidth=1200" +
      "&format=json" +
      "&origin=*";

    const response = await fetch(api, {
      headers: {
        "User-Agent": "FacebookVideoTool/2.0"
      }
    });

    if (!response.ok) {
      throw new Error("Wikimedia API unavailable");
    }

    const data = await response.json();
    const pages = Object.values(data?.query?.pages || {});

    for (const page of pages) {
      const info = page?.imageinfo?.[0];
      const url = info?.thumburl || info?.url;

      if (!url) continue;

      const ext = String(url).toLowerCase();

      if (
        !ext.includes(".jpg") &&
        !ext.includes(".jpeg") &&
        !ext.includes(".png") &&
        !ext.includes(".webp")
      ) {
        continue;
      }

      try {
        await downloadFile(url, target);
        return target;
      } catch {
        continue;
      }
    }
  } catch (error) {
    console.log("IMAGE SEARCH WARNING:", error.message);
  }

  return null;
}

async function makeFallbackImage(file, title, subtitle) {
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280">
  <rect width="720" height="1280" fill="#111827"/>
  <circle cx="120" cy="180" r="150" fill="#1f2937"/>
  <circle cx="650" cy="1050" r="260" fill="#374151"/>
  <text x="360" y="520"
        text-anchor="middle"
        font-family="DejaVu Sans"
        font-size="58"
        font-weight="bold"
        fill="white">${escapeXml(title)}</text>
  <text x="360" y="620"
        text-anchor="middle"
        font-family="DejaVu Sans"
        font-size="30"
        fill="white">${escapeXml(subtitle)}</text>
</svg>`;

  const svgFile = file.replace(/\.[^.]+$/, ".svg");
  fs.writeFileSync(svgFile, svg, "utf8");

  await run("ffmpeg", [
    "-y",
    "-i",
    svgFile,
    "-frames:v",
    "1",
    file
  ]);

  return file;
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function makeVoice(text, wavFile) {
  try {
    await run("espeak-ng", [
      "-v",
      "vi",
      "-s",
      "150",
      "-p",
      "45",
      "-a",
      "170",
      "-w",
      wavFile,
      text
    ]);

    if (fs.existsSync(wavFile) && fs.statSync(wavFile).size > 1000) {
      return true;
    }
  } catch (error) {
    console.log("TTS WARNING:", error.message);
  }

  try {
    await run("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=22050:cl=mono",
      "-t",
      "4",
      "-c:a",
      "pcm_s16le",
      wavFile
    ]);

    return true;
  } catch {
    return false;
  }
}

async function createSceneVideo({
  image,
  audio,
  title,
  caption,
  outputFile,
  sceneNumber
}) {
  const dir = path.dirname(outputFile);

  const titleFile = path.join(
    dir,
    `title-${sceneNumber}-${id()}.txt`
  );

  const captionFile = path.join(
    dir,
    `caption-${sceneNumber}-${id()}.txt`
  );

  fs.writeFileSync(titleFile, safeText(title), "utf8");
  fs.writeFileSync(captionFile, safeText(caption), "utf8");

  const filter =
    "scale=720:1280:force_original_aspect_ratio=increase," +
    "crop=720:1280," +
    "zoompan=" +
    "z='min(zoom+0.0015,1.08)':" +
    "x='iw/2-(iw/zoom/2)':" +
    "y='ih/2-(ih/zoom/2)':" +
    "d=100:s=720x1280:fps=25," +
    "drawtext=" +
    "fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:" +
    `textfile='${titleFile}':` +
    "fontsize=48:" +
    "fontcolor=white:" +
    "borderw=3:" +
    "bordercolor=black:" +
    "x=(w-text_w)/2:" +
    "y=150," +
    "drawtext=" +
    "fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:" +
    `textfile='${captionFile}':` +
    "fontsize=34:" +
    "fontcolor=white:" +
    "borderw=2:" +
    "bordercolor=black:" +
    "x=45:" +
    "y=h-300";

  await run("ffmpeg", [
    "-y",
    "-loop",
    "1",
    "-i",
    image,
    "-i",
    audio,
    "-filter_complex",
    `[0:v]${filter}[v]`,
    "-map",
    "[v]",
    "-map",
    "1:a:0",
    "-t",
    "4",
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
    "-shortest",
    outputFile
  ]);

  try {
    fs.unlinkSync(titleFile);
    fs.unlinkSync(captionFile);
  } catch {}

  return outputFile;
}

async function concatVideos(files, outputFile) {
  const listFile = path.join(
    path.dirname(outputFile),
    `concat-${id()}.txt`
  );

  const content = files
    .map((file) => `file '${file.replace(/'/g, "'\\''")}'`)
    .join("\n");

  fs.writeFileSync(listFile, content, "utf8");

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
    outputFile
  ]);

  try {
    fs.unlinkSync(listFile);
  } catch {}

  return outputFile;
}

async function makeVideo(job, videoIndex) {
  const videoDir = path.join(
    WORK,
    job.id,
    `video-${videoIndex}`
  );

  fs.mkdirSync(videoDir, { recursive: true });

  const scenes = buildScenes(
    job.topic,
    job.style,
    videoIndex
  );

  const sceneFiles = [];

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];

    job.currentVideo = videoIndex;
    job.currentScene = i + 1;
    job.message =
      `Video ${videoIndex}/${job.count} - cảnh ${i + 1}/${scenes.length}`;

    const imageFile = path.join(
      videoDir,
      `image-${i}.jpg`
    );

    let image = await findImage(
      scene.search || job.topic,
      imageFile
    );

    if (!image) {
      image = await makeFallbackImage(
        imageFile,
        scene.title,
        job.topic
      );
    }

    const audioFile = path.join(
      videoDir,
      `audio-${i}.wav`
    );

    await makeVoice(
      `${scene.title}. ${scene.text}`,
      audioFile
    );

    const sceneVideo = path.join(
      videoDir,
      `scene-${i}.mp4`
    );

    await createSceneVideo({
      image,
      audio: audioFile,
      title: scene.title,
      caption: scene.text,
      outputFile: sceneVideo,
      sceneNumber: i
    });

    sceneFiles.push(sceneVideo);
  }

  const finalFile = path.join(
    OUTPUT,
    `${job.id}-video-${videoIndex}.mp4`
  );

  await concatVideos(sceneFiles, finalFile);

  if (
    !fs.existsSync(finalFile) ||
    fs.statSync(finalFile).size < 10000
  ) {
    throw new Error("Không tạo được file MP4 cuối cùng");
  }

  return finalFile;
}

async function processJob(job) {
  if (processing) return;

  processing = true;

  try {
    job.status = "processing";
    job.message = "Đang bắt đầu tạo video...";

    for (let i = 1; i <= job.count; i++) {
      const file = await makeVideo(job, i);

      job.videos.push({
        index: i,
        file: `/api/download/${job.id}/${i}`,
        size: fs.statSync(file).size
      });

      job.completed = i;
      job.message =
        `Đã hoàn thành ${i}/${job.count} video`;
    }

    job.status = "completed";
    job.message = "Tất cả video đã hoàn thành";
  } catch (error) {
    console.error("VIDEO ERROR:", error);

    job.status = "error";
    job.message = error.message || "Có lỗi khi tạo video";
  } finally {
    processing = false;

    if (queue.length > 0) {
      const next = queue.shift();
      setImmediate(() => processJob(next));
    }
  }
}

function addJob(job) {
  queue.push(job);

  if (!processing) {
    const next = queue.shift();
    setImmediate(() => processJob(next));
  }
}

const HTML = [
  "<!doctype html>",
  "<html lang='vi'>",
  "<head>",
  "<meta charset='utf-8'>",
  "<meta name='viewport' content='width=device-width,initial-scale=1'>",
  "<title>Facebook Viral Video Tool V2</title>",
  "<style>",
  "*{box-sizing:border-box}",
  "body{margin:0;background:#0b1020;color:#fff;font-family:Arial,sans-serif}",
  ".wrap{max-width:760px;margin:auto;padding:22px}",
  ".card{background:#151c31;border:1px solid #293451;border-radius:20px;padding:20px;box-shadow:0 10px 30px #0005}",
  "h1{margin:0 0 8px;font-size:27px}",
  ".sub{color:#aab4cc;margin-bottom:22px}",
  "label{display:block;margin:16px 0 8px;font-weight:bold}",
  "input,select{width:100%;padding:15px;border-radius:12px;border:1px solid #394766;background:#0d1426;color:white;font-size:16px}",
  "button{width:100%;padding:16px;margin-top:20px;border:0;border-radius:14px;background:#1877f2;color:#fff;font-size:18px;font-weight:bold}",
  "button:disabled{opacity:.5}",
  ".status{margin-top:20px;padding:15px;border-radius:12px;background:#0d1426;line-height:1.5}",
  ".video{margin-top:14px;padding:14px;background:#0d1426;border-radius:14px}",
  ".video a{display:block;text-align:center;padding:12px;margin-top:10px;border-radius:10px;background:#263b66;color:white;text-decoration:none}",
  ".small{font-size:13px;color:#9da8bf;margin-top:14px}",
  "</style>",
  "</head>",
  "<body>",
  "<div class='wrap'>",
  "<div class='card'>",
  "<h1>🎬 Facebook Viral Video Tool V2</h1>",
  "<div class='sub'>Nhập một chủ đề → tạo 1 đến 3 video dọc tự động.</div>",
  "<label>Chủ đề</label>",
  "<input id='topic' placeholder='Ví dụ: Cá mập, Khủng long, Ai Cập...'/>",
  "<label>Số video</label>",
  "<select id='count'><option value='1'>1 video</option><option value='2'>2 video</option><option value='3'>3 video</option></select>",
  "<label>Phong cách</label>",
  "<select id='style'><option value='viral'>Viral / cuốn hút</option><option value='knowledge'>Kiến thức</option><option value='story'>Kể chuyện</option></select>",
  "<button id='create'>🚀 TẠO VIDEO</button>",
  "<div id='status' class='status' style='display:none'></div>",
  "<div id='videos'></div>",
  "<div class='small'>Video 9:16 • nhiều cảnh • ảnh • chuyển động • phụ đề • giọng đọc tiếng Việt</div>",
  "</div>",
  "</div>",
  "<script>",
  "const create=document.getElementById('create');",
  "const statusBox=document.getElementById('status');",
  "const videosBox=document.getElementById('videos');",
  "let timer=null;",
  "function esc(s){return String(s).replace(/[&<>\\\"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','\\\"':'&quot;',\"'\":'&#39;'}[m]));}",
  "async function poll(jobId){",
  "try{",
  "const r=await fetch('/api/status/'+jobId);",
  "const j=await r.json();",
  "statusBox.style.display='block';",
  "statusBox.innerHTML='<b>'+esc(j.message||'Đang xử lý...')+'</b><br>Tiến độ: '+j.completed+'/'+j.count;",
  "if(j.videos&&j.videos.length){",
  "videosBox.innerHTML=j.videos.map(v=>'<div class=\"video\"><b>🎬 Video '+v.index+'</b><a href=\"'+v.file+'\">⬇️ XEM / TẢI VIDEO</a></div>').join('');",
  "}",
  "if(j.status==='completed'){clearInterval(timer);create.disabled=false;return;}",
  "if(j.status==='error'){clearInterval(timer);create.disabled=false;return;}",
  "}catch(e){statusBox.innerHTML='Đang kết nối lại...';}",
  "}",
  "create.onclick=async()=>{",
  "const topic=document.getElementById('topic').value.trim();",
  "const count=Number(document.getElementById('count').value);",
  "const style=document.getElementById('style').value;",
  "if(!topic){alert('Bạn hãy nhập chủ đề trước');return;}",
  "create.disabled=true;",
  "videosBox.innerHTML='';",
  "statusBox.style.display='block';",
  "statusBox.innerHTML='Đang tạo yêu cầu...';",
  "try{",
  "const r=await fetch('/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({topic,count,style})});",
  "const j=await r.json();",
  "if(!r.ok)throw new Error(j.error||'Không tạo được yêu cầu');",
  "clearInterval(timer);",
  "await poll(j.id);",
  "timer=setInterval(()=>poll(j.id),2500);",
  "}catch(e){",
  "statusBox.innerHTML='<b>Lỗi:</b> '+esc(e.message);",
  "create.disabled=false;",
  "}",
  "};",
  "</script>",
  "</body>",
  "</html>"
].join("\n");

app.get("/", (req, res) => {
  res.type("html").send(HTML);
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "facebook-video-tool-v2",
    status: "running",
    port: PORT,
    host: HOST,
    queue: queue.length,
    processing
  });
});

app.post("/api/generate", (req, res) => {
  const topic = cleanTopic(req.body?.topic);

  let count = Number(req.body?.count);
  if (!Number.isFinite(count)) count = 1;

  count = Math.max(1, Math.min(3, Math.floor(count)));

  const styleList = ["viral", "knowledge", "story"];
  const style = styleList.includes(req.body?.style)
    ? req.body.style
    : "viral";

  const job = {
    id: id(),
    topic,
    count,
    style,
    status: "queued",
    message: "Đang xếp hàng...",
    completed: 0,
    currentVideo: 0,
    currentScene: 0,
    videos: [],
    createdAt: Date.now()
  };

  jobs.set(job.id, job);
  addJob(job);

  res.json({
    ok: true,
    id: job.id,
    status: job.status
  });
});

app.get("/api/status/:id", (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      error: "Không tìm thấy job"
    });
  }

  res.json({
    id: job.id,
    topic: job.topic,
    count: job.count,
    status: job.status,
    message: job.message,
    completed: job.completed,
    currentVideo: job.currentVideo,
    currentScene: job.currentScene,
    videos: job.videos
  });
});

app.get("/api/download/:id/:index", (req, res) => {
  const index = Number(req.params.index);

  if (!Number.isInteger(index) || index < 1 || index > 3) {
    return res.status(400).send("Video không hợp lệ");
  }

  const file = path.join(
    OUTPUT,
    `${req.params.id}-video-${index}.mp4`
  );

  if (!fs.existsSync(file)) {
    return res.status(404).send("Video chưa sẵn sàng");
  }

  res.download(file, `facebook-video-${index}.mp4`);
});

app.use((error, req, res, next) => {
  console.error("SERVER ERROR:", error);

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    error: "Server error"
  });
});

app.listen(PORT, HOST, () => {
  console.log("========================================");
  console.log("FACEBOOK VIDEO TOOL V2");
  console.log("Server: http://" + HOST + ":" + PORT);
  console.log("Node: " + process.version);
  console.log("CPU: " + os.cpus().length);
  console.log("========================================");
});
