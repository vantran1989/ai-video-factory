import "dotenv/config";
import express from "express";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);

const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const jobs = new Map();

/* =========================
   COMMAND
========================= */

async function run(cmd, args, options = {}) {
  return exec(cmd, args, {
    maxBuffer: 50 * 1024 * 1024,
    ...options
  });
}

/* =========================
   TEXT HELPERS
========================= */

function cleanText(text = "") {
  return String(text)
    .replace(/\s+/g, " ")
    .replace(/[<>]/g, "")
    .trim();
}

function escapeXml(text = "") {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function splitSentences(text, count = 5) {
  const parts = cleanText(text)
    .split(/[.!?。！？]+/)
    .map(x => x.trim())
    .filter(Boolean);

  if (parts.length >= count) {
    return parts.slice(0, count);
  }

  while (parts.length < count) {
    parts.push(parts[parts.length - 1] || text);
  }

  return parts;
}

/* =========================
   SCRIPT GENERATOR
   NO OPENAI
========================= */

function makeScript(topic, style, audience, duration, count) {
  const cleanTopic = cleanText(topic);
  const cleanStyle = cleanText(style || "viral");
  const cleanAudience = cleanText(audience || "người xem Facebook");

  const videos = [];

  for (let i = 0; i < count; i++) {
    const hooks = [
      `Bạn có biết điều ít người nói về ${cleanTopic}?`,
      `5 điều đáng chú ý về ${cleanTopic} mà bạn nên biết.`,
      `Nếu bạn quan tâm đến ${cleanTopic}, đừng bỏ qua video này.`,
      `Sự thật về ${cleanTopic} có thể khiến bạn bất ngờ.`,
      `Đây là cách nhìn đơn giản nhất về ${cleanTopic}.`
    ];

    const hook = hooks[i % hooks.length];

    const scenes = [
      {
        visual_prompt: `Chủ đề ${cleanTopic}`,
        voiceover:
          `${hook} Video này dành cho ${cleanAudience}, theo phong cách ${cleanStyle}.`,
        subtitle: hook
      },
      {
        visual_prompt: `Thông tin nổi bật về ${cleanTopic}`,
        voiceover:
          `Điểm đầu tiên là hãy nhìn vào những điều quan trọng nhất liên quan đến ${cleanTopic}.`,
        subtitle: `Điểm đầu tiên về ${cleanTopic}`
      },
      {
        visual_prompt: `Ví dụ thực tế về ${cleanTopic}`,
        voiceover:
          `Một cách dễ hiểu là nhìn vào ví dụ thực tế. Khi áp dụng đúng, bạn sẽ dễ dàng hình dung vấn đề hơn.`,
        subtitle: `Ví dụ thực tế`
      },
      {
        visual_prompt: `Mẹo hữu ích liên quan đến ${cleanTopic}`,
        voiceover:
          `Mẹo đơn giản là bắt đầu từ một bước nhỏ, kiểm tra kết quả rồi mới tiếp tục.`,
        subtitle: `Một mẹo đơn giản`
      },
      {
        visual_prompt: `Kết luận về ${cleanTopic}`,
        voiceover:
          `Tóm lại, hãy ghi nhớ những điểm chính trong video này và áp dụng phù hợp với hoàn cảnh của bạn.`,
        subtitle: `Hãy nhớ điều này`
      }
    ];

    videos.push({
      title: `${cleanTopic} - Video ${i + 1}`,
      hook,
      scenes,
      cta: `Theo dõi để xem thêm nội dung về ${cleanTopic}.`
    });
  }

  return {
    videos
  };
}

/* =========================
   LOCAL IMAGE GENERATOR
   SVG -> PNG
   NO AI API
========================= */

async function image(prompt, out, sceneNumber = 1) {
  const safe = escapeXml(cleanText(prompt));

  const gradients = [
    ["#172554", "#312e81"],
    ["#0f172a", "#164e63"],
    ["#3b0764", "#701a75"],
    ["#052e16", "#14532d"],
    ["#451a03", "#9a3412"]
  ];

  const colors = gradients[(sceneNumber - 1) % gradients.length];

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg"
     width="1080"
     height="1920"
     viewBox="0 0 1080 1920">

  <defs>
    <linearGradient id="bg"
                    x1="0"
                    y1="0"
                    x2="1"
                    y2="1">
      <stop offset="0%" stop-color="${colors[0]}"/>
      <stop offset="100%" stop-color="${colors[1]}"/>
    </linearGradient>

    <filter id="shadow">
      <feDropShadow dx="0"
                    dy="8"
                    stdDeviation="12"
                    flood-opacity="0.5"/>
    </filter>
  </defs>

  <rect width="1080"
        height="1920"
        fill="url(#bg)"/>

  <circle cx="850"
          cy="300"
          r="260"
          fill="white"
          opacity="0.08"/>

  <circle cx="200"
          cy="1600"
          r="350"
          fill="white"
          opacity="0.06"/>

  <rect x="70"
        y="180"
        width="940"
        height="1560"
        rx="45"
        fill="black"
        opacity="0.20"/>

  <text x="540"
        y="450"
        text-anchor="middle"
        fill="white"
        font-family="Arial, sans-serif"
        font-size="62"
        font-weight="bold"
        filter="url(#shadow)">
        ${safe}
  </text>

  <text x="540"
        y="600"
        text-anchor="middle"
        fill="white"
        opacity="0.9"
        font-family="Arial, sans-serif"
        font-size="34">
        VIDEO NGẮN 9:16
  </text>

  <text x="540"
        y="1780"
        text-anchor="middle"
        fill="white"
        opacity="0.65"
        font-family="Arial, sans-serif"
        font-size="28">
        AI VIDEO FACTORY
  </text>

</svg>
`;

  const svgFile = `${out}.svg`;

  await fs.writeFile(svgFile, svg, "utf8");

  await run("ffmpeg", [
    "-y",
    "-i",
    svgFile,
    "-frames:v",
    "1",
    "-vf",
    "scale=1080:1920",
    out
  ]);

  await fs.unlink(svgFile).catch(() => {});
}

/* =========================
   FREE VIETNAMESE TTS
   EDGE-TTS
========================= */

async function speech(text, out) {
  const voice =
    process.env.TTS_VOICE ||
    "vi-VN-HoaiMyNeural";

  await run("edge-tts", [
    "--voice",
    voice,
    "--text",
    cleanText(text),
    "--write-media",
    out
  ]);
}

/* =========================
   RENDER SCENE
========================= */

async function renderScene(img, audio, out) {
  await run("ffmpeg", [
    "-y",

    "-loop",
    "1",

    "-i",
    img,

    "-i",
    audio,

    "-vf",
    "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,format=yuv420p",

    "-c:v",
    "libx264",

    "-preset",
    "veryfast",

    "-tune",
    "stillimage",

    "-c:a",
    "aac",

    "-shortest",

    "-movflags",
    "+faststart",

    out
  ]);
}

/* =========================
   CONCAT
========================= */

async function concat(parts, out) {
  const list = path.join(
    path.dirname(out),
    "list.txt"
  );

  await fs.writeFile(
    list,
    parts
      .map(p => {
        const safe = p.replaceAll("'", "'\\''");
        return `file '${safe}'`;
      })
      .join("\n")
  );

  await run("ffmpeg", [
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

    out
  ]);
}

/* =========================
   CREATE JOB
========================= */

app.post("/api/jobs", async (req, res) => {
  try {
    const {
      topic,
      count = 1,
      duration = 30,
      style = "viral",
      audience = "người xem Facebook"
    } = req.body;

    const n = Math.min(
      Math.max(Number(count) || 1, 1),
      20
    );

    if (!topic?.trim()) {
      return res.status(400).json({
        error: "Hãy nhập chủ đề."
      });
    }

    const id = crypto.randomUUID();

    jobs.set(id, {
      id,
      status: "queued",
      done: 0,
      total: n,
      message: "Đang chuẩn bị...",
      videos: []
    });

    res.json({ id });

    (async () => {
      try {
        const base = path.join(
          process.cwd(),
          "jobs",
          id
        );

        await fs.mkdir(base, {
          recursive: true
        });

        const job = jobs.get(id);

        job.status = "scripting";
        job.message = "Đang tạo kịch bản miễn phí...";

        const data = makeScript(
          topic,
          style,
          audience,
          duration,
          n
        );

        const videos = data.videos || [];

        for (let i = 0; i < videos.length; i++) {
          const v = videos[i];

          const dir = path.join(
            base,
            String(i + 1)
          );

          await fs.mkdir(dir, {
            recursive: true
          });

          job.status = "rendering";

          job.message =
            `Đang sản xuất video ${i + 1}/${videos.length}`;

          const parts = [];

          for (
            let s = 0;
            s < (v.scenes || []).length;
            s++
          ) {
            const sc = v.scenes[s];

            const img = path.join(
              dir,
              `scene-${s + 1}.png`
            );

            const aud = path.join(
              dir,
              `scene-${s + 1}.mp3`
            );

            const mp4 = path.join(
              dir,
              `scene-${s + 1}.mp4`
            );

            job.message =
              `Video ${i + 1}/${videos.length}: tạo hình ${s + 1}/5...`;

            await image(
              sc.visual_prompt,
              img,
              s + 1
            );

            job.message =
              `Video ${i + 1}/${videos.length}: tạo giọng ${s + 1}/5...`;

            await speech(
              sc.voiceover,
              aud
            );

            job.message =
              `Video ${i + 1}/${videos.length}: ghép cảnh ${s + 1}/5...`;

            await renderScene(
              img,
              aud,
              mp4
            );

            parts.push(mp4);
          }

          const final = path.join(
            base,
            `video-${i + 1}.mp4`
          );

          job.message =
            `Đang ghép video ${i + 1}...`;

          await concat(
            parts,
            final
          );

          job.videos.push({
            number: i + 1,
            title: v.title,
            file:
              `/api/jobs/${id}/files/video-${i + 1}.mp4`
          });

          job.done = i + 1;
        }

        job.status = "done";
        job.message = "Hoàn tất";
      } catch (e) {
        console.error(e);

        const job = jobs.get(id);

        if (job) {
          job.status = "error";
          job.message =
            e.message || String(e);
        }
      }
    })();

  } catch (e) {
    console.error(e);

    res.status(500).json({
      error: e.message || String(e)
    });
  }
});

/* =========================
   JOB STATUS
========================= */

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      error: "Không tìm thấy job"
    });
  }

  res.json(job);
});

/* =========================
   DOWNLOAD VIDEO
========================= */

app.get(
  "/api/jobs/:id/files/:file",
  async (req, res) => {
    try {
      const p = path.join(
        process.cwd(),
        "jobs",
        req.params.id,
        req.params.file
      );

      res.download(p);
    } catch (e) {
      res.status(404).json({
        error: "Không tìm thấy file"
      });
    }
  }
);

/* =========================
   HEALTH
========================= */

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "AI Video Factory",
    mode: "free-no-openai"
  });
});

/* =========================
   START
========================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `AI Video Factory listening on ${PORT}`
    );
  }
);
