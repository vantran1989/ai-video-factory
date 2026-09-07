import "dotenv/config";
import express from "express";
import OpenAI from "openai";
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

function client() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Chưa cấu hình OPENAI_API_KEY trên máy chủ.");
  }

  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });
}

async function run(cmd, args) {
  return exec(cmd, args, {
    maxBuffer: 20 * 1024 * 1024
  });
}

async function makeScript(topic, style, audience, duration, count) {
  const c = client();

  const prompt = `Bạn là biên kịch video ngắn tiếng Việt.

Tạo ${count} video độc lập về chủ đề "${topic}".

Phong cách: ${style}.
Đối tượng: ${audience}.
Mỗi video khoảng ${duration} giây.

Mỗi video có 5 cảnh.

Lời thoại tự nhiên, hấp dẫn, không bịa số liệu.

Mỗi cảnh gồm:
- visual_prompt bằng tiếng Anh để tạo ảnh dọc 9:16
- voiceover bằng tiếng Việt
- subtitle ngắn bằng tiếng Việt

Trả về JSON hợp lệ, KHÔNG markdown, theo đúng dạng:

{
  "videos": [
    {
      "title": "",
      "hook": "",
      "scenes": [
        {
          "visual_prompt": "",
          "voiceover": "",
          "subtitle": ""
        }
      ],
      "cta": ""
    }
  ]
}`;

  const r = await c.responses.create({
    model: process.env.TEXT_MODEL || "gpt-5.6-luna",
    input: prompt
  });

  const text = r.output_text
    .trim()
    .replace(/^```json\s*/, "")
    .replace(/```$/, "");

  return JSON.parse(text);
}

async function image(prompt, out) {
  const c = client();

  const r = await c.images.generate({
    model: process.env.IMAGE_MODEL || "gpt-image-2",
    prompt: `Vertical 9:16 social media illustration. ${prompt}`,
    size: "1024x1536",
    quality: "low"
  });

  const b64 = r.data?.[0]?.b64_json;

  if (!b64) {
    throw new Error("API không trả ảnh dạng base64.");
  }

  await fs.writeFile(
    out,
    Buffer.from(b64, "base64")
  );
}

async function speech(text, out) {
  const c = client();

  const r = await c.audio.speech.create({
    model: process.env.TTS_MODEL || "gpt-4o-mini-tts",
    voice: process.env.TTS_VOICE || "marin",
    input: text,
    instructions:
      "Đọc tiếng Việt tự nhiên, rõ ràng, giàu cảm xúc, tốc độ vừa phải.",
    response_format: "mp3"
  });

  await fs.writeFile(
    out,
    Buffer.from(await r.arrayBuffer())
  );
}

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

async function concat(parts, out) {
  const list = path.join(
    path.dirname(out),
    "list.txt"
  );

  await fs.writeFile(
    list,
    parts
      .map(p => `file '${p.replaceAll("'", "'\\''")}'`)
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
      100
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

        jobs.get(id).status = "scripting";
        jobs.get(id).message =
          "Đang tạo kịch bản...";

        const data = await makeScript(
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

          jobs.get(id).status = "rendering";
          jobs.get(id).message =
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

            await image(
              sc.visual_prompt,
              img
            );

            await speech(
              sc.voiceover,
              aud
            );

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

          await concat(parts, final);

          jobs.get(id).videos.push({
            number: i + 1,
            title: v.title,
            file:
              `/api/jobs/${id}/files/video-${i + 1}.mp4`
          });

          jobs.get(id).done = i + 1;
        }

        jobs.get(id).status = "done";
        jobs.get(id).message = "Hoàn tất";

      } catch (e) {
        jobs.get(id).status = "error";
        jobs.get(id).message =
          e.message || String(e);
      }
    })();

  } catch (e) {
    res.status(500).json({
      error: e.message
    });
  }
});

app.get("/api/jobs/:id", (req, res) => {
  const j = jobs.get(req.params.id);

  if (!j) {
    return res.status(404).json({
      error: "Không tìm thấy job"
    });
  }

  res.json(j);
});

app.get(
  "/api/jobs/:id/files/:file",
  (req, res) => {
    const p = path.join(
      process.cwd(),
      "jobs",
      req.params.id,
      req.params.file
    );

    res.download(p);
  }
);

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "AI Video Factory"
  });
});

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `AI Video Factory listening on ${PORT}`
    );
  }
);
