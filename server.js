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

await Promise.all([
  fs.mkdir(UPLOAD_DIR, { recursive: true }),
  fs.mkdir(OUTPUT_DIR, { recursive: true }),
  fs.mkdir(TEMP_DIR, { recursive: true })
]);

const app = express();

app.use(express.json({ limit: "10mb" }));
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
    const ext = path
      .extname(file.originalname)
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

function runCommand(command, args, timeout = 300000) {
  return new Promise((resolve, reject) => {
    console.log("");
    console.log("========== COMMAND ==========");
    console.log(command);
    console.log(args.join(" "));
    console.log("=============================");

    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"]
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
        new Error(
          "PROCESS_TIMEOUT: FFmpeg/FFprobe chạy quá lâu."
        )
      );
    }, timeout);

    child.stdout.on("data", data => {
      stdout += data.toString();
    });

    child.stderr.on("data", data => {
      const text = data.toString();

      stderr += text;

      console.log("[FFMPEG]", text.trim());
    });

    child.on("error", error => {
      if (finished) return;

      finished = true;
      clearTimeout(timer);

      console.error(
        "COMMAND ERROR:",
        error
      );

      reject(error);
    });

    child.on("close", code => {
      if (finished) return;

      finished = true;
      clearTimeout(timer);

      if (code === 0) {
        console.log(
          "COMMAND OK - exit code:",
          code
        );

        resolve({
          stdout,
          stderr
        });

        return;
      }

      const message =
        `FFmpeg/FFprobe error ${code}\n` +
        stderr.slice(-15000);

      console.error(
        "COMMAND FAILED:",
        message
      );

      reject(
        new Error(message)
      );
    });
  });
}

/* =========================================================
   PROBE
========================================================= */

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
   INSPECT MEDIA
========================================================= */

async function inspectMedia(file) {
  const data = await probe(file);

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
   TEST VIDEO FRAME
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
   TEST AUDIO
========================================================= */

async function testAudio(file) {
  try {
    const info =
      await inspectMedia(file);

    if (!info.hasAudio) {
      return {
        ok: false,
        hasAudio: false,
        message:
          "Không có audio stream."
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
      hasAudio: true,
      message:
        "Audio giải mã thành công."
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
    name: "Video stream",

    ok:
      info.hasVideo,

    message:
      info.hasVideo
        ? "Có video stream."
        : "KHÔNG có video stream."
  });

  if (info.hasVideo) {
    checks.push({
      name: "Kích thước",

      ok:
        info.width > 0 &&
        info.height > 0,

      message:
        `${info.width} x ${info.height}`
    });

    checks.push({
      name: "Thời lượng",

      ok:
        info.duration > 0,

      message:
        `${info.duration.toFixed(2)} giây`
    });

    checks.push({
      name: "Codec",

      ok:
        Boolean(
          info.video?.codec
        ),

      message:
        info.video?.codec ||
        "Không xác định"
    });

    const frame =
      await testVideoFrame(file);

    checks.push({
      name: "Decode frame",

      ok:
        frame.ok,

      message:
        frame.message
    });
  }

  const audio =
    await testAudio(file);

  checks.push({
    name: "Audio",

    ok:
      audio.ok,

    message:
      audio.message
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
   ENCODE / REPAIR VIDEO
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

      "-map",
      "0:v:0",

      "-map",
      "0:a:0?",

      "-c:v",
      "libx264",

      "-preset",
      "veryfast",

      "-crf",
      "20",

      "-pix_fmt",
      "yuv420p",

      "-r",
      "30",

      "-c:a",
      "aac",

      "-b:a",
      "128k",

      "-ar",
      "48000",

      "-ac",
      "2",

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
   IMAGE + AUDIO -> VIDEO
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
    "veryfast",

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
      "128k",

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
   CREATE TEST VIDEO
=========================================================

   QUAN TRỌNG:

   KHÔNG:
   - SVG
   - drawtext
   - font
   - PNG trung gian

   TEST VIDEO DÙNG:
   - nền hình ảnh màu
   - H264
   - AAC
   - MP4

   Mục đích:
   kiểm tra chắc chắn pipeline
   hình + tiếng hoạt động.
========================================================= */

async function createTestVideo(
  topic,
  output,
  duration = 30
) {
  console.log("");
  console.log(
    "========================================"
  );

  console.log(
    "CREATE TEST VIDEO"
  );

  console.log(
    "TOPIC:",
    topic
  );

  console.log(
    "DURATION:",
    duration
  );

  console.log(
    "OUTPUT:",
    output
  );

  console.log(
    "========================================"
  );

  await runCommand(
    ffmpegPath,
    [
      "-y",

      "-hide_banner",
      "-loglevel",
      "error",

      /*
       * VIDEO INPUT
       * Nền màu 720x1280
       */
      "-f",
      "lavfi",

      "-i",
      "color=c=0x11182d:s=720x1280:r=30",

      /*
       * AUDIO INPUT
       * Âm thanh test 440Hz
       */
      "-f",
      "lavfi",

      "-i",
      "sine=frequency=440:sample_rate=48000",

      /*
       * THỜI LƯỢNG
       */
      "-t",
      String(duration),

      /*
       * VIDEO
       */
      "-map",
      "0:v:0",

      "-c:v",
      "libx264",

      "-preset",
      "veryfast",

      "-crf",
      "20",

      "-pix_fmt",
      "yuv420p",

      "-r",
      "30",

      /*
       * AUDIO
       */
      "-map",
      "1:a:0",

      "-c:a",
      "aac",

      "-b:a",
      "128k",

      "-ar",
      "48000",

      "-ac",
      "2",

      /*
       * MP4
       */
      "-movflags",
      "+faststart",

      output
    ],
    600000
  );

  console.log(
    "CREATE TEST VIDEO: DONE"
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
        Boolean(
          ffprobeStatic.path
        ),

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
      console.error(
        "INSPECT ERROR:",
        error
      );

      res.status(422).json({
        ok: false,

        error:
          error.message
      });
    } finally {
      await fs.rm(
        req.file.path,
        {
          force: true
        }
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

      if (!input.hasVideo) {
        throw new Error(
          "AUDIO_ONLY: File chỉ có âm thanh, không có hình."
        );
      }

      const frame =
        await testVideoFrame(
          req.file.path
        );

      if (!frame.ok) {
        throw new Error(
          "VIDEO_DECODE_ERROR: FFmpeg không giải mã được hình."
        );
      }

      await encodeVideo(
        req.file.path,
        output
      );

      const final =
        await validateVideo(
          output
        );

      if (!final.ok) {
        throw new Error(
          "OUTPUT_VALIDATION_FAILED: MP4 sau khi xuất không hợp lệ."
        );
      }

      res.json({
        ok: true,

        id,

        file:
          `/api/download/${id}`,

        url:
          `/api/download/${id}`,

        result:
          final
      });

    } catch (error) {
      console.error(
        "REPAIR ERROR:",
        error
      );

      await fs.rm(
        output,
        {
          force: true
        }
      );

      res.status(422).json({
        ok: false,

        error:
          error.message
      });

    } finally {
      await fs.rm(
        req.file.path,
        {
          force: true
        }
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

        url:
          `/api/download/${id}`,

        result:
          final
      });

    } catch (error) {
      console.error(
        "MAKE VIDEO ERROR:",
        error
      );

      await fs.rm(
        output,
        {
          force: true
        }
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
          {
            force: true
          }
        );
      }

      if (audio) {
        await fs.rm(
          audio.path,
          {
            force: true
          }
        );
      }
    }
  }
);

/* =========================================================
   GENERATE
========================================================= */

app.post(
  "/api/generate",

  async (req, res) => {
    const topic =
      String(
        req.body?.topic ||
        "Video AI"
      ).trim();

    let count =
      Number(
        req.body?.count ||
        req.body?.quantity ||
        1
      );

    let duration =
      Number(
        req.body?.duration ||
        30
      );

    count =
      Math.max(
        1,
        Math.min(
          Number.isFinite(count)
            ? count
            : 1,
          5
        )
      );

    duration =
      Math.max(
        1,
        Math.min(
          Number.isFinite(duration)
            ? duration
            : 30,
          300
        )
      );

    console.log("");
    console.log(
      "========================================"
    );

    console.log(
      "API GENERATE"
    );

    console.log(
      "TOPIC:",
      topic
    );

    console.log(
      "COUNT:",
      count
    );

    console.log(
      "DURATION:",
      duration
    );

    console.log(
      "========================================"
    );

    const videos = [];

    for (
      let i = 0;
      i < count;
      i++
    ) {
      const id =
        crypto.randomUUID();

      const output =
        path.join(
          OUTPUT_DIR,
          `${id}.mp4`
        );

      try {
        console.log(
          `START VIDEO ${i + 1}/${count}`
        );

        await createTestVideo(
          topic,
          output,
          duration
        );

        console.log(
          "Checking output..."
        );

        const final =
          await validateVideo(
            output
          );

        console.log(
          "VALIDATION:",
          JSON.stringify(
            final,
            null,
            2
          )
        );

        if (!final.info.hasVideo) {
          throw new Error(
            "Video không có video stream."
          );
        }

        if (!final.info.hasAudio) {
          throw new Error(
            "Video không có audio stream."
          );
        }

        if (!final.ok) {
          throw new Error(
            "MP4 không vượt qua kiểm tra hình + tiếng."
          );
        }

        const file =
          `/api/download/${id}`;

        videos.push({
          index: i + 1,

          ok: true,

          title: topic,

          id,

          file,

          url: file,

          result: final
        });

        console.log(
          `VIDEO ${i + 1} SUCCESS`
        );

      } catch (error) {
        console.error("");
        console.error(
          "========================================"
        );

        console.error(
          `VIDEO ${i + 1} FAILED`
        );

        console.error(
          error
        );

        console.error(
          "========================================"
        );

        await fs.rm(
          output,
          {
            force: true
          }
        );

        videos.push({
          index: i + 1,

          ok: false,

          title: topic,

          error:
            error?.message ||
            String(error)
        });
      }
    }

    const successful =
      videos.filter(
        video =>
          video.ok === true
      );

    const firstFile =
      successful[0]?.file ||
      null;

    const firstError =
      videos.find(
        video =>
          !video.ok
      )?.error ||
      null;

    console.log("");
    console.log(
      "GENERATE FINISHED"
    );

    console.log(
      "SUCCESS:",
      successful.length
    );

    console.log(
      "TOTAL:",
      videos.length
    );

    if (firstError) {
      console.error(
        "FIRST ERROR:",
        firstError
      );
    }

    res.json({
      ok:
        successful.length > 0,

      total:
        videos.length,

      success:
        successful.length,

      message:
        `Đã tạo ${successful.length}/${videos.length} video.`,

      file:
        firstFile,

      url:
        firstFile,

      error:
        successful.length > 0
          ? null
          : firstError,

      videos
    });
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

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  (
    error,
    _req,
    res,
    _next
  ) => {
    console.error(
      "SERVER ERROR:",
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
   START SERVER
========================================================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log("");
    console.log(
      "========================================"
    );

    console.log(
      "       AI VIDEO FACTORY"
    );

    console.log(
      "       SERVER STARTED"
    );

    console.log(
      "       PORT:",
      PORT
    );

    console.log(
      "       FFMPEG:",
      ffmpegPath
    );

    console.log(
      "       FFPROBE:",
      ffprobeStatic.path
    );

    console.log(
      "========================================"
    );
  }
);
