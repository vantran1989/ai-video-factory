import "dotenv/config";

import express from "express";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);

const PUBLIC_DIR = path.join(__dirname, "public");
const UPLOAD_DIR = path.join(__dirname, "uploads");
const OUTPUT_DIR = path.join(__dirname, "outputs");
const TEMP_DIR = path.join(__dirname, "temp");

await fs.mkdir(UPLOAD_DIR, { recursive: true });
await fs.mkdir(OUTPUT_DIR, { recursive: true });
await fs.mkdir(TEMP_DIR, { recursive: true });

const app = express();

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

const upload = multer({
  dest: UPLOAD_DIR,
  limits: {
    fileSize: 500 * 1024 * 1024
  }
});

function runCommand(command, args, timeout = 600000) {
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

      reject(new Error("Process timeout."));
    }, timeout);

    child.stdout.on("data", data => {
      stdout += data.toString();
    });

    child.stderr.on("data", data => {
      stderr += data.toString();
    });

    child.on("error", error => {
      if (done) return;

      done = true;
      clearTimeout(timer);
      reject(error);
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
            `FFmpeg/FFprobe error ${code}\n${stderr.slice(-8000)}`
          )
        );
      }
    });
  });
}

async function probe(file) {
  const result = await runCommand(
    ffprobeStatic.path,
    [
      "-v",
      "error",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      file
    ],
    120000
  );

  return JSON.parse(result.stdout);
}

async function inspectMedia(file) {
  const data = await probe(file);
  const streams = data.streams || [];

  const video = streams.find(
    s => s.codec_type === "video"
  );

  const audio = streams.find(
    s => s.codec_type === "audio"
  );

  const width = Number(video?.width || 0);
  const height = Number(video?.height || 0);

  const duration = Number(
    data.format?.duration ||
    video?.duration ||
    audio?.duration ||
    0
  );

  return {
    hasVideo:
      Boolean(video) &&
      width > 0 &&
      height > 0,

    hasAudio:
      Boolean(audio),

    width,
    height,
    duration,

    video: video
      ? {
          codec: video.codec_name,
          pixelFormat: video.pix_fmt,
          fps:
            video.avg_frame_rate ||
            video.r_frame_rate
        }
      : null,

    audio: audio
      ? {
          codec: audio.codec_name,
          sampleRate: audio.sample_rate,
          channels: audio.channels
        }
      : null,

    format:
      data.format?.format_name || null
  };
}

async function testVideoFrame(file) {
  try {
    await runCommand(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        file,
        "-map",
        "0:v:0",
        "-frames:v",
        "3",
        "-f",
        "null",
        "-"
      ],
      120000
    );

    return true;
  } catch {
    return false;
  }
}

async function validateVideo(file) {
  const info = await inspectMedia(file);

  const frameOK = info.hasVideo
    ? await testVideoFrame(file)
    : false;

  return {
    ok:
      info.hasVideo &&
      frameOK,

    info,

    checks: [
      {
        name: "Video",
        ok: info.hasVideo,
        message: info.hasVideo
          ? "Có hình."
          : "KHÔNG có hình."
      },
      {
        name: "Frame",
        ok: frameOK,
        message: frameOK
          ? "FFmpeg đọc được hình."
          : "FFmpeg không đọc được hình."
      },
      {
        name: "Audio",
        ok: true,
        message: info.hasAudio
          ? "Có âm thanh."
          : "Không có âm thanh."
      }
    ]
  };
}

/*
=========================================================
TẠO HÌNH PNG TRỰC TIẾP
=========================================================

KHÔNG tạo SVG.

Đây là phần sửa lỗi:
"Decoding requested, but no decoder found for: svg"
*/

async function createVisual(topic, output) {
  const text = String(
    topic || "AI VIDEO FACTORY"
  )
    .replace(/[\r\n]/g, " ")
    .replace(/'/g, "")
    .replace(/:/g, " ")
    .slice(0, 70);

  await runCommand(
    ffmpegPath,
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",

      "-f",
      "lavfi",

      "-i",
      "color=c=0x11182d:s=720x1280",

      "-vf",

      "drawtext=fontcolor=white:fontsize=52:x=(w-text_w)/2:y=430:text='AI VIDEO FACTORY',drawtext=fontcolor=white:fontsize=36:x=(w-text_w)/2:y=530:text='" +
        text +
        "'",

      "-frames:v",
      "1",

      output
    ],
    120000
  );
}

async function imageToVideo(
  image,
  audio,
  output,
  duration
) {
  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",

    "-loop",
    "1",

    "-i",
    image
  ];

  if (audio) {
    args.push(
      "-i",
      audio
    );
  }

  args.push(
    "-t",
    String(duration),

    "-map",
    "0:v:0",

    "-c:v",
    "libx264",

    "-preset",
    "medium",

    "-crf",
    "20",

    "-pix_fmt",
    "yuv420p",

    "-r",
    "30"
  );

  if (audio) {
    args.push(
      "-map",
      "1:a:0",

      "-c:a",
      "aac",

      "-b:a",
      "192k",

      "-ar",
      "48000",

      "-ac",
      "2",

      "-shortest"
    );
  }

  args.push(
    "-movflags",
    "+faststart",

    output
  );

  await runCommand(
    ffmpegPath,
    args,
    600000
  );
}

/*
=========================================================
HEALTH
=========================================================
*/

app.get(
  "/api/health",
  async (_req, res) => {
    res.json({
      ok: true,
      service: "AI Video Factory",
      ffmpeg: Boolean(ffmpegPath),
      ffprobe: Boolean(
        ffprobeStatic.path
      ),
      time: new Date().toISOString()
    });
  }
);

/*
=========================================================
API GENERATE
=========================================================
*/

app.post(
  "/api/generate",
  async (req, res) => {
    const topic =
      String(
        req.body?.topic ||
        "Video AI"
      );

    const count = Math.max(
      1,
      Math.min(
        Number(
          req.body?.count ||
          req.body?.quantity ||
          1
        ),
        5
      )
    );

    const duration = Math.max(
      5,
      Math.min(
        Number(
          req.body?.duration ||
          30
        ),
        300
      )
    );

    const videos = [];

    for (
      let i = 1;
      i <= count;
      i++
    ) {
      const id =
        crypto.randomUUID();

      const image =
        path.join(
          TEMP_DIR,
          `${id}.png`
        );

      const output =
        path.join(
          OUTPUT_DIR,
          `${id}.mp4`
        );

      try {
        /*
        Tạo PNG thật.
        Không còn SVG.
        */

        await createVisual(
          `${topic} - Video ${i}`,
          image
        );

        /*
        Tạo MP4 từ PNG.
        */

        await imageToVideo(
          image,
          null,
          output,
          duration
        );

        /*
        Kiểm tra MP4.
        */

        const result =
          await validateVideo(
            output
          );

        if (!result.ok) {
          throw new Error(
            "Video tạo ra không có hình hợp lệ."
          );
        }

        videos.push({
          index: i,
          ok: true,
          title: topic,
          url:
            `/api/download/${id}`,
          file:
            `/api/download/${id}`,
          result
        });

      } catch (error) {
        await fs.rm(
          output,
          { force: true }
        );

        videos.push({
          index: i,
          ok: false,
          title: topic,
          error:
            error.message
        });

      } finally {
        await fs.rm(
          image,
          { force: true }
        );
      }
    }

    const success =
      videos.filter(
        v => v.ok
      ).length;

    res.json({
      ok: success > 0,
      total: videos.length,
      success,
      message:
        `Đã tạo ${success}/${videos.length} video.`,
      videos
    });
  }
);

/*
=========================================================
IMAGE + AUDIO -> MP4
=========================================================
*/

app.post(
  "/api/make-video",

  upload.fields([
    {
      name: "image",
      maxCount: 1
    },
    {
      name: "audio",
      maxCount: 1
    }
  ]),

  async (req, res) => {
    const image =
      req.files?.image?.[0];

    const audio =
      req.files?.audio?.[0];

    if (!image) {
      return res.status(400).json({
        ok: false,
        error:
          "Chưa có hình ảnh."
      });
    }

    const id =
      crypto.randomUUID();

    const output =
      path.join(
        OUTPUT_DIR,
        `${id}.mp4`
      );

    try {
      const duration =
        Math.max(
          1,
          Math.min(
            Number(
              req.body?.duration ||
              30
            ),
            300
          )
        );

      await imageToVideo(
        image.path,
        audio?.path || null,
        output,
        duration
      );

      const result =
        await validateVideo(
          output
        );

      if (!result.ok) {
        throw new Error(
          "MP4 không có hình hợp lệ."
        );
      }

      res.json({
        ok: true,
        id,

        url:
          `/api/download/${id}`,

        file:
          `/api/download/${id}`,

        result
      });

    } catch (error) {
      await fs.rm(
        output,
        { force: true }
      );

      res.status(422).json({
        ok: false,
        error:
          error.message
      });

    } finally {
      await fs.rm(
        image.path,
        { force: true }
      );

      if (audio) {
        await fs.rm(
          audio.path,
          { force: true }
        );
      }
    }
  }
);

/*
=========================================================
INSPECT VIDEO
=========================================================
*/

app.post(
  "/api/inspect",

  upload.single("video"),

  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error:
          "Chưa chọn video."
      });
    }

    try {
      const result =
        await validateVideo(
          req.file.path
        );

      res.json(result);

    } catch (error) {
      res.status(422).json({
        ok: false,
        error:
          error.message
      });

    } finally {
      await fs.rm(
        req.file.path,
        { force: true }
      );
    }
  }
);

/*
=========================================================
REPAIR VIDEO
=========================================================
*/

app.post(
  "/api/repair",

  upload.single("video"),

  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error:
          "Chưa chọn video."
      });
    }

    const id =
      crypto.randomUUID();

    const output =
      path.join(
        OUTPUT_DIR,
        `${id}.mp4`
      );

    try {
      const info =
        await inspectMedia(
          req.file.path
        );

      if (!info.hasVideo) {
        throw new Error(
          "AUDIO_ONLY: File chỉ có âm thanh, không có hình."
        );
      }

      const frameOK =
        await testVideoFrame(
          req.file.path
        );

      if (!frameOK) {
        throw new Error(
          "VIDEO_DECODE_ERROR: Không đọc được frame hình."
        );
      }

      await runCommand(
        ffmpegPath,
        [
          "-y",
          "-hide_banner",
          "-loglevel",
          "error",

          "-i",
          req.file.path,

          "-map",
          "0:v:0",

          "-map",
          "0:a:0?",

          "-c:v",
          "libx264",

          "-preset",
          "medium",

          "-crf",
          "20",

          "-pix_fmt",
          "yuv420p",

          "-c:a",
          "aac",

          "-b:a",
          "192k",

          "-ar",
          "48000",

          "-ac",
          "2",

          "-movflags",
          "+faststart",

          output
        ],
        600000
      );

      const result =
        await validateVideo(
          output
        );

      if (!result.ok) {
        throw new Error(
          "Video sau khi sửa không hợp lệ."
        );
      }

      res.json({
        ok: true,
        id,

        url:
          `/api/download/${id}`,

        file:
          `/api/download/${id}`,

        result
      });

    } catch (error) {
      await fs.rm(
        output,
        { force: true }
      );

      res.status(422).json({
        ok: false,
        error:
          error.message
      });

    } finally {
      await fs.rm(
        req.file.path,
        { force: true }
      );
    }
  }
);

/*
=========================================================
DOWNLOAD
=========================================================
*/

app.get(
  "/api/download/:id",
  async (req, res) => {
    const id =
      req.params.id;

    if (
      !/^[a-f0-9-]{36}$/i.test(
        id
      )
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "ID không hợp lệ."
      });
    }

    const file =
      path.join(
        OUTPUT_DIR,
        `${id}.mp4`
      );

    try {
      await fs.access(file);

      res.download(
        file,
        "AI-VIDEO-FACTORY.mp4"
      );

    } catch {
      res.status(404).json({
        ok: false,
        error:
          "Video không tồn tại."
      });
    }
  }
);

/*
=========================================================
ERROR
=========================================================
*/

app.use(
  (error, _req, res, _next) => {
    console.error(error);

    res.status(500).json({
      ok: false,
      error:
        error?.message ||
        "Lỗi server."
    });
  }
);

/*
=========================================================
START
=========================================================
*/

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "================================"
    );

    console.log(
      "AI VIDEO FACTORY"
    );

    console.log(
      "Server running on port:",
      PORT
    );

    console.log(
      "FFmpeg:",
      ffmpegPath
    );

    console.log(
      "FFprobe:",
      ffprobeStatic.path
    );

    console.log(
      "================================"
    );
  }
);
