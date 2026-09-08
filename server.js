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

/* =========================================================
   PATH
========================================================= */

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

/* =========================================================
   EXPRESS
========================================================= */

const app = express();

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(PUBLIC_DIR));

/* =========================================================
   MULTER
========================================================= */

const upload = multer({

  dest: UPLOAD_DIR,

  limits: {
    fileSize: 500 * 1024 * 1024
  },

  fileFilter: (_req, file, cb) => {

    const ext =
      path.extname(file.originalname)
        .toLowerCase();

    const allowed = [
      ".mp4",
      ".mov",
      ".mkv",
      ".webm",
      ".m4v",
      ".avi",
      ".mp3",
      ".wav",
      ".m4a",
      ".jpg",
      ".jpeg",
      ".png",
      ".webp"
    ];

    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          "Định dạng file không được hỗ trợ."
        )
      );
    }
  }

});

/* =========================================================
   RUN COMMAND
========================================================= */

function runCommand(
  command,
  args,
  timeout = 300000
) {

  return new Promise(
    (resolve, reject) => {

      const child = spawn(
        command,
        args,
        {
          stdio: [
            "ignore",
            "pipe",
            "pipe"
          ]
        }
      );

      let stdout = "";
      let stderr = "";

      let finished = false;

      const timer =
        setTimeout(() => {

          if (finished) return;

          finished = true;

          try {
            child.kill("SIGKILL");
          } catch {}

          reject(
            new Error(
              "Process timeout."
            )
          );

        }, timeout);

      child.stdout.on(
        "data",
        data => {
          stdout += data.toString();
        }
      );

      child.stderr.on(
        "data",
        data => {
          stderr += data.toString();
        }
      );

      child.on(
        "error",
        error => {

          if (finished) return;

          finished = true;

          clearTimeout(timer);

          reject(error);
        }
      );

      child.on(
        "close",
        code => {

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
                `FFmpeg/FFprobe error ${code}\n${stderr.slice(-8000)}`
              )
            );
          }
        }
      );

    }
  );
}

/* =========================================================
   FFPROBE
========================================================= */

async function probe(file) {

  const result =
    await runCommand(
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

  try {

    return JSON.parse(
      result.stdout
    );

  } catch {

    throw new Error(
      "Không đọc được thông tin media."
    );
  }
}

/* =========================================================
   MEDIA INSPECTION
========================================================= */

async function inspectMedia(file) {

  const data =
    await probe(file);

  const streams =
    data.streams || [];

  const video =
    streams.find(
      stream =>
        stream.codec_type ===
        "video"
    );

  const audio =
    streams.find(
      stream =>
        stream.codec_type ===
        "audio"
    );

  const width =
    Number(video?.width || 0);

  const height =
    Number(video?.height || 0);

  const duration =
    Number(
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
          codec:
            video.codec_name,

          pixelFormat:
            video.pix_fmt,

          fps:
            video.avg_frame_rate ||
            video.r_frame_rate,

          frames:
            Number(
              video.nb_frames || 0
            )
        }
      : null,

    audio: audio
      ? {
          codec:
            audio.codec_name,

          sampleRate:
            audio.sample_rate,

          channels:
            audio.channels
        }
      : null,

    format:
      data.format?.format_name ||
      null
  };
}

/* =========================================================
   VIDEO FRAME TEST
=========================================================

   Không chỉ kiểm tra "có video stream".

   FFmpeg phải giải mã được frame thật.

========================================================= */

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

    return {
      ok: true,
      message:
        "Giải mã frame hình thành công."
    };

  } catch (error) {

    return {
      ok: false,
      message:
        error.message
    };
  }
}

/* =========================================================
   AUDIO TEST
========================================================= */

async function testAudio(file) {

  try {

    const info =
      await inspectMedia(file);

    if (!info.hasAudio) {

      return {
        ok: true,
        hasAudio: false
      };

    }

    await runCommand(
      ffmpegPath,
      [

        "-hide_banner",

        "-loglevel",
        "error",

        "-i",
        file,

        "-map",
        "0:a:0",

        "-t",
        "2",

        "-f",
        "null",

        "-"
      ],
      120000
    );

    return {
      ok: true,
      hasAudio: true
    };

  } catch (error) {

    return {
      ok: false,
      hasAudio: true,
      message:
        error.message
    };
  }
}

/* =========================================================
   VALIDATE VIDEO
========================================================= */

async function validateVideo(file) {

  const info =
    await inspectMedia(file);

  const checks = [];

  checks.push({

    name:
      "Video stream",

    ok:
      info.hasVideo,

    message:
      info.hasVideo
        ? "Có video stream."
        : "KHÔNG có video stream."

  });

  if (info.hasVideo) {

    checks.push({

      name:
        "Kích thước",

      ok:
        info.width > 0 &&
        info.height > 0,

      message:
        `${info.width} x ${info.height}`

    });

    checks.push({

      name:
        "Thời lượng",

      ok:
        info.duration > 0,

      message:
        `${info.duration.toFixed(2)} giây`

    });

    checks.push({

      name:
        "Codec",

      ok:
        Boolean(info.video?.codec),

      message:
        info.video?.codec ||
        "Không xác định"

    });

    const frame =
      await testVideoFrame(file);

    checks.push({

      name:
        "Decode frame",

      ok:
        frame.ok,

      message:
        frame.message

    });

  }

  const audio =
    await testAudio(file);

  checks.push({

    name:
      "Audio",

    ok:
      audio.ok,

    message:
      audio.hasAudio
        ? "Audio OK."
        : "Không có audio."

  });

  return {

    ok:
      checks.every(
        check => check.ok
      ),

    info,

    checks
  };
}

/* =========================================================
   RE-ENCODE VIDEO
========================================================= */

async function encodeVideo(
  input,
  output
) {

  await runCommand(
    ffmpegPath,
    [

      "-y",

      "-hide_banner",

      "-loglevel",
      "error",

      "-i",
      input,

      /*
       * BẮT BUỘC lấy video stream
       */

      "-map",
      "0:v:0",

      /*
       * Audio nếu có
       */

      "-map",
      "0:a:0?",

      /*
       * VIDEO
       */

      "-c:v",
      "libx264",

      "-preset",
      "medium",

      "-crf",
      "20",

      "-pix_fmt",
      "yuv420p",

      "-profile:v",
      "high",

      "-level",
      "4.1",

      /*
       * AUDIO
       */

      "-c:a",
      "aac",

      "-b:a",
      "192k",

      "-ar",
      "48000",

      "-ac",
      "2",

      /*
       * MP4
       */

      "-movflags",
      "+faststart",

      "-map_metadata",
      "-1",

      output
    ],
    600000
  );

}

/* =========================================================
   IMAGE -> VIDEO
=========================================================

   Nếu AI tạo ra ảnh + audio thay vì video,
   server vẫn có thể dựng MP4 CÓ HÌNH.

========================================================= */

async function imageToVideo(
  image,
  audio,
  output,
  duration = 30
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

/* =========================================================
   CREATE DEMO VISUAL
=========================================================

   Dùng khi cần kiểm tra pipeline mà chưa nối AI API.
   Không bao giờ tạo file audio-only.

========================================================= */

async function createVisual(
  topic,
  output
) {

  const safeTopic =
    String(topic || "AI VIDEO")
      .replace(
        /[\\/:*?"<>|]/g,
        " "
      )
      .slice(0, 100);

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg"
     width="1280"
     height="720"
     viewBox="0 0 1280 720">

  <rect
    width="1280"
    height="720"
    fill="#11182d"/>

  <rect
    x="70"
    y="70"
    width="1140"
    height="580"
    rx="40"
    fill="#1d2745"/>

  <text
    x="640"
    y="300"
    text-anchor="middle"
    font-family="Arial"
    font-size="54"
    font-weight="bold"
    fill="white">
    AI VIDEO FACTORY
  </text>

  <text
    x="640"
    y="390"
    text-anchor="middle"
    font-family="Arial"
    font-size="38"
    fill="white">
    ${escapeXml(safeTopic)}
  </text>

  <text
    x="640"
    y="500"
    text-anchor="middle"
    font-family="Arial"
    font-size="28"
    fill="#b8c2e5">
    Video đã được kiểm tra hình ảnh
  </text>

</svg>
`;

  const file =
    path.join(
      TEMP_DIR,
      `${crypto.randomUUID()}.svg`
    );

  await fs.writeFile(
    file,
    svg,
    "utf8"
  );

  try {

    await runCommand(
      ffmpegPath,
      [
        "-y",

        "-hide_banner",

        "-loglevel",
        "error",

        "-i",
        file,

        "-frames:v",
        "1",

        output
      ]
    );

  } finally {

    await fs.rm(
      file,
      { force: true }
    );

  }

}

/* =========================================================
   XML ESCAPE
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

/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/api/health",
  async (_req, res) => {

    res.json({

      ok: true,

      service:
        "AI Video Factory",

      ffmpeg:
        Boolean(ffmpegPath),

      ffprobe:
        Boolean(ffprobeStatic.path),

      time:
        new Date().toISOString()

    });

  }
);

/* =========================================================
   INSPECT
========================================================= */

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

/* =========================================================
   REPAIR
========================================================= */

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

      const input =
        await inspectMedia(
          req.file.path
        );

      /*
       * CHỐNG LỖI AUDIO-ONLY
       */

      if (!input.hasVideo) {

        throw new Error(

          "AUDIO_ONLY: File/API chỉ có âm thanh, không có video stream. Server đã CHẶN xuất MP4 để tránh video có tiếng nhưng mất hình."

        );

      }

      /*
       * Kiểm tra frame đầu vào
       */

      const frame =
        await testVideoFrame(
          req.file.path
        );

      if (!frame.ok) {

        throw new Error(

          "VIDEO_DECODE_ERROR: Có video stream nhưng FFmpeg không giải mã được frame."

        );

      }

      /*
       * Encode lại chuẩn điện thoại/Facebook
       */

      await encodeVideo(
        req.file.path,
        output
      );

      /*
       * KIỂM TRA OUTPUT
       */

      const final =
        await validateVideo(
          output
        );

      if (!final.ok) {

        throw new Error(

          "OUTPUT_VALIDATION_FAILED: MP4 sau khi xuất không vượt qua kiểm tra hình ảnh."

        );

      }

      res.json({

        ok: true,

        id,

        file:
          `/api/download/${id}`,

        result:
          final

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

/* =========================================================
   IMAGE + AUDIO -> VIDEO
========================================================= */

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
        Number(
          req.body.duration || 30
        );

      await imageToVideo(

        image.path,

        audio?.path || null,

        output,

        Math.max(
          1,
          Math.min(
            duration,
            300
          )
        )

      );

      const final =
        await validateVideo(
          output
        );

      if (!final.ok) {

        throw new Error(

          "MP4 tạo từ hình/audio không vượt qua kiểm tra."

        );

      }

      res.json({

        ok: true,

        id,

        file:
          `/api/download/${id}`,

        result:
          final

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

      if (image) {

        await fs.rm(
          image.path,
          { force: true }
        );

      }

      if (audio) {

        await fs.rm(
          audio.path,
          { force: true }
        );

      }

    }

  }

);

/* =========================================================
   DEMO GENERATOR
========================================================= */

app.post(
  "/api/generate",

  async (req, res) => {

    const topic =
      req.body?.topic ||
      "Video AI";

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
       * Tạo hình kiểm tra pipeline.
       */

      await createVisual(
        topic,
        image
      );

      /*
       * Chuyển hình thành video thật.
       */

      await runCommand(
        ffmpegPath,
        [

          "-y",

          "-loop",
          "1",

          "-i",
          image,

          "-t",
          "30",

          "-r",
          "30",

          "-c:v",
          "libx264",

          "-preset",
          "medium",

          "-crf",
          "20",

          "-pix_fmt",
          "yuv420p",

          "-movflags",
          "+faststart",

          output

        ],
        600000
      );

      /*
       * BẮT BUỘC kiểm tra output.
       */

      const final =
        await validateVideo(
          output
        );

      if (!final.ok) {

        throw new Error(

          "Video tạo ra không có hình hợp lệ."

        );

      }

      res.json({

        ok: true,

        id,

        file:
          `/api/download/${id}`,

        result:
          final

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
        image,
        { force: true }
      );

    }

  }
);

/* =========================================================
   DOWNLOAD
========================================================= */

app.get(
  "/api/download/:id",
  async (req, res) => {

    const id =
      req.params.id;

    if (
      !/^[a-f0-9-]{36}$/i.test(id)
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

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  (error, _req, res, _next) => {

    console.error(
      error
    );

    if (
      error?.code ===
      "LIMIT_FILE_SIZE"
    ) {

      return res.status(413).json({

        ok: false,

        error:
          "File vượt quá giới hạn 500 MB."

      });

    }

    res.status(500).json({

      ok: false,

      error:
        error?.message ||
        "Lỗi server."

    });

  }
);

/* =========================================================
   START
========================================================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "================================"
    );

    console.log(
      " AI VIDEO FACTORY"
    );

    console.log(
      " Server running on port:",
      PORT
    );

    console.log(
      " FFmpeg:",
      ffmpegPath
    );

    console.log(
      " FFprobe:",
      ffprobeStatic.path
    );

    console.log(
      "================================"
    );

  }
);
