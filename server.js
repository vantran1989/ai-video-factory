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

const upload = multer({
  dest: UPLOAD_DIR,
  limits: {
    fileSize: 500 * 1024 * 1024
  }
});


/* =========================================================
   COMMAND RUNNER
========================================================= */

function runCommand(command, args, timeout = 600000) {
  return new Promise((resolve, reject) => {
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

      reject(new Error("Process timeout."));
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
            `${command} error ${code}\n${stderr.slice(-12000)}`
          )
        );
      }
    });
  });
}


/* =========================================================
   MEDIA INSPECTION
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

  return JSON.parse(result.stdout);
}


async function inspectMedia(file) {
  const data = await probe(file);

  const streams = data.streams || [];

  const video = streams.find(
    stream => stream.codec_type === "video"
  );

  const audio = streams.find(
    stream => stream.codec_type === "audio"
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

    return {
      ok: true,
      message: "Decode frame: OK"
    };
  } catch (error) {
    return {
      ok: false,
      message: error.message
    };
  }
}


async function testAudio(file) {
  try {
    const info = await inspectMedia(file);

    if (!info.hasAudio) {
      return {
        ok: false,
        hasAudio: false,
        message: "Không có audio."
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
      message: "Audio: OK"
    };
  } catch (error) {
    return {
      ok: false,
      hasAudio: true,
      message: error.message
    };
  }
}


async function validateVideo(file) {
  const info = await inspectMedia(file);

  const checks = [];

  checks.push({
    name: "Video stream",
    ok: info.hasVideo,
    message: info.hasVideo
      ? "Video stream: OK"
      : "Không có video stream."
  });

  if (info.hasVideo) {
    checks.push({
      name: "Decode frame",
      ok: (
        await testVideoFrame(file)
      ).ok,
      message: "Decode frame: OK"
    });
  }

  const audio = await testAudio(file);

  checks.push({
    name: "Audio",
    ok: audio.ok,
    message: audio.message
  });

  return {
    ok: checks.every(check => check.ok),
    info,
    checks
  };
}


/* =========================================================
   DOWNLOAD IMAGE FROM WIKIMEDIA COMMONS
========================================================= */

async function downloadTopicImage(topic, output) {
  const search = `${topic} photo`;

  const params = new URLSearchParams({
    action: "query",
    format: "json",
    generator: "search",
    gsrsearch: search,
    gsrnamespace: "6",
    gsrlimit: "12",
    prop: "imageinfo",
    iiprop: "url|mime",
    iiurlwidth: "900"
  });

  const apiUrl =
    "https://commons.wikimedia.org/w/api.php?" +
    params.toString();

  const response = await fetch(apiUrl, {
    headers: {
      "User-Agent":
        "AI-Video-Factory/8.0"
    }
  });

  if (!response.ok) {
    throw new Error(
      `Wikimedia API HTTP ${response.status}`
    );
  }

  const data = await response.json();

  const pages =
    Object.values(
      data?.query?.pages || {}
    );

  for (const page of pages) {
    const image =
      page?.imageinfo?.[0];

    if (!image) continue;

    const mime =
      String(image.mime || "")
        .toLowerCase();

    if (
      ![
        "image/jpeg",
        "image/png",
        "image/webp"
      ].includes(mime)
    ) {
      continue;
    }

    const imageUrl =
      image.thumburl ||
      image.url;

    if (!imageUrl) continue;

    try {
      const imageResponse =
        await fetch(imageUrl, {
          headers: {
            "User-Agent":
              "AI-Video-Factory/8.0"
          }
        });

      if (!imageResponse.ok) {
        continue;
      }

      const buffer =
        Buffer.from(
          await imageResponse.arrayBuffer()
        );

      if (buffer.length < 5000) {
        continue;
      }

      await fs.writeFile(
        output,
        buffer
      );

      return {
        ok: true,
        title: page.title,
        url: imageUrl
      };
    } catch {
      continue;
    }
  }

  throw new Error(
    "Không tìm được ảnh phù hợp."
  );
}


/* =========================================================
   NORMALIZE IMAGE
   Chuyển mọi ảnh về PNG 720x1280.
========================================================= */

async function normalizeImage(
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

      "-vf",
      "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280",

      "-frames:v",
      "1",

      "-pix_fmt",
      "yuv420p",

      output
    ],
    120000
  );
}


/* =========================================================
   FALLBACK VISUAL
   Nếu Wikimedia không có ảnh thì dùng testsrc2.
========================================================= */

async function createFallbackImage(output) {
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
      "testsrc2=s=720x1280",

      "-frames:v",
      "1",

      output
    ],
    120000
  );
}


/* =========================================================
   VIETNAMESE SCRIPT
========================================================= */

function makeScript(
  topic,
  style,
  audience,
  duration
) {
  const cleanTopic =
    String(topic || "chủ đề thú vị")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 180);

  const cleanStyle =
    String(style || "dễ hiểu")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100);

  const cleanAudience =
    String(audience || "mọi người")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100);

  const paragraphs = [
    `Xin chào bạn. Hôm nay chúng ta cùng khám phá ${cleanTopic}. Đây là một chủ đề rất đáng chú ý và có nhiều điều thú vị để tìm hiểu.`,

    `Trong video này, nội dung được trình bày theo phong cách ${cleanStyle}, phù hợp với ${cleanAudience}.`,

    `Điều đầu tiên cần biết là ${cleanTopic} có những đặc điểm rất đáng quan tâm. Khi hiểu rõ những điểm chính, chúng ta sẽ dễ dàng nhìn nhận chủ đề này một cách rõ ràng hơn.`,

    `Một điều thú vị khác là chủ đề này có thể liên quan đến đời sống, kiến thức và những trải nghiệm mà chúng ta gặp hằng ngày.`,

    `Nếu bạn đang tìm hiểu về ${cleanTopic}, hãy chú ý đến những thông tin quan trọng, so sánh các khía cạnh khác nhau và kiểm tra nguồn thông tin trước khi đưa ra kết luận.`,

    `Hy vọng video ngắn này giúp bạn có thêm một góc nhìn dễ hiểu về ${cleanTopic}. Cảm ơn bạn đã xem video và hẹn gặp lại trong những video tiếp theo.`
  ];

  let target;

  if (duration <= 30) {
    target = 3;
  } else if (duration <= 60) {
    target = 5;
  } else {
    target = 6;
  }

  let text =
    paragraphs
      .slice(0, target)
      .join(" ");

  while (
    text.length < duration * 10 &&
    text.length < 2500
  ) {
    text +=
      " Hãy tiếp tục khám phá chủ đề này để có thêm những thông tin hữu ích và thực tế.";
  }

  return text.slice(0, 2500);
}


/* =========================================================
   EDGE TTS
========================================================= */

async function createVoice(
  text,
  output
) {
  await runCommand(
    "edge-tts",
    [
      "--voice",
      "vi-VN-HoaiMyNeural",

      "--rate",
      "+0%",

      "--volume",
      "+0%",

      "--text",
      text,

      "--write-media",
      output
    ],
    180000
  );

  const stat =
    await fs.stat(output);

  if (stat.size < 1000) {
    throw new Error(
      "Edge-TTS tạo file âm thanh không hợp lệ."
    );
  }
}


/* =========================================================
   IMAGE + VOICE -> MP4
========================================================= */

async function makeVideo(
  image,
  audio,
  output,
  duration
) {
  const audioFilter =
    `[1:a]apad=whole_dur=${duration}[a]`;

  await runCommand(
    ffmpegPath,
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

      "-filter_complex",
      audioFilter,

      "-map",
      "0:v:0",
      "-map",
      "[a]",

      "-t",
      String(duration),

      "-c:v",
      "libx264",

      "-preset",
      "veryfast",

      "-crf",
      "21",

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

      output
    ],
    600000
  );
}


/* =========================================================
   CREATE REAL VIDEO
========================================================= */

async function createRealVideo(
  topic,
  style,
  audience,
  duration,
  output
) {
  const id =
    crypto.randomUUID();

  const rawImage =
    path.join(
      TEMP_DIR,
      `${id}-raw-image`
    );

  const image =
    path.join(
      TEMP_DIR,
      `${id}-image.png`
    );

  const audio =
    path.join(
      TEMP_DIR,
      `${id}-voice.mp3`
    );

  try {
    let imageInfo;

    try {
      imageInfo =
        await downloadTopicImage(
          topic,
          rawImage
        );

      await normalizeImage(
        rawImage,
        image
      );
    } catch (error) {
      console.log(
        "IMAGE SEARCH FALLBACK:",
        error.message
      );

      await createFallbackImage(
        image
      );

      imageInfo = {
        ok: false,
        title: "Fallback visual"
      };
    }

    const script =
      makeScript(
        topic,
        style,
        audience,
        duration
      );

    console.log(
      "TTS script:",
      script
    );

    await createVoice(
      script,
      audio
    );

    await makeVideo(
      image,
      audio,
      output,
      duration
    );

    return {
      image: imageInfo,
      script
    };
  } finally {
    await Promise.all([
      fs.rm(
        rawImage,
        { force: true }
      ),
      fs.rm(
        image,
        { force: true }
      ),
      fs.rm(
        audio,
        { force: true }
      )
    ]);
  }
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
      version: "8.0.0",
      ffmpeg:
        Boolean(ffmpegPath),
      ffprobe:
        Boolean(ffprobeStatic.path),
      tts: "Edge-TTS",
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
        error: "Chưa chọn video."
      });
    }

    try {
      const result =
        await validateVideo(
          req.file.path
        );

      res.json(result);
    } catch (error) {
      console.error(error);

      res.status(422).json({
        ok: false,
        error: error.message
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
        error: "Chưa chọn video."
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
          "AUDIO_ONLY: File chỉ có âm thanh, không có video."
        );
      }

      const frame =
        await testVideoFrame(
          req.file.path
        );

      if (!frame.ok) {
        throw new Error(
          "VIDEO_DECODE_ERROR: Không giải mã được frame."
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
          "veryfast",

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

      const final =
        await validateVideo(
          output
        );

      if (!final.ok) {
        throw new Error(
          "MP4 sau khi sửa không vượt qua kiểm tra."
        );
      }

      res.json({
        ok: true,
        id,
        file:
          `/api/download/${id}`,
        url:
          `/api/download/${id}`,
        result: final
      });
    } catch (error) {
      console.error(
        "REPAIR ERROR:",
        error
      );

      await fs.rm(
        output,
        { force: true }
      );

      res.status(422).json({
        ok: false,
        error: error.message
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
   GENERATE
========================================================= */

app.post(
  "/api/generate",
  async (req, res) => {
    const topic =
      String(
        req.body?.topic ||
        "Khám phá thế giới"
      ).trim();

    const style =
      String(
        req.body?.style ||
        req.body?.phongcach ||
        "dễ hiểu"
      ).trim();

    const audience =
      String(
        req.body?.audience ||
        req.body?.doituong ||
        "mọi người"
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
        Math.min(count, 5)
      );

    duration =
      Math.max(
        30,
        Math.min(
          duration,
          90
        )
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
          "================================"
        );

        console.log(
          `CREATE VIDEO ${i + 1}/${count}`
        );

        console.log(
          "Topic:",
          topic
        );

        console.log(
          "Style:",
          style
        );

        console.log(
          "Audience:",
          audience
        );

        console.log(
          "Duration:",
          duration
        );

        await createRealVideo(
          topic,
          style,
          audience,
          duration,
          output
        );

        const final =
          await validateVideo(
            output
          );

        if (!final.ok) {
          throw new Error(
            "OUTPUT_VALIDATION_FAILED: MP4 không vượt qua kiểm tra hình/tiếng."
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
          "VIDEO SUCCESS:",
          file
        );
      } catch (error) {
        console.error(
          "VIDEO GENERATION ERROR:",
          error
        );

        await fs.rm(
          output,
          { force: true }
        );

        videos.push({
          index: i + 1,
          ok: false,
          title: topic,
          error: error.message
        });
      }
    }

    const successful =
      videos.filter(
        video => video.ok
      );

    const firstFile =
      successful[0]?.file ||
      null;

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

      videos
    });
  }
);


/* =========================================================
   MAKE VIDEO FROM UPLOADED IMAGE + AUDIO
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
              req.body?.duration || 30
            ),
            300
          )
        );

      if (!audio) {
        throw new Error(
          "Chưa có file âm thanh."
        );
      }

      await makeVideo(
        image.path,
        audio.path,
        output,
        duration
      );

      const final =
        await validateVideo(
          output
        );

      if (!final.ok) {
        throw new Error(
          "MP4 tạo ra không vượt qua kiểm tra."
        );
      }

      res.json({
        ok: true,
        id,
        file:
          `/api/download/${id}`,
        url:
          `/api/download/${id}`,
        result: final
      });
    } catch (error) {
      console.error(
        "MAKE VIDEO ERROR:",
        error
      );

      await fs.rm(
        output,
        { force: true }
      );

      res.status(422).json({
        ok: false,
        error: error.message
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
          "File vượt quá 500 MB."
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
      " AI VIDEO FACTORY 8.0"
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
      " Vietnamese TTS: Edge-TTS"
    );

    console.log(
      "================================"
    );
  }
);
