import "dotenv/config";

import express from "express";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";


/* =========================================================
   CONFIG
========================================================= */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);

const PUBLIC_DIR = path.join(__dirname, "public");
const OUTPUT_DIR = path.join(__dirname, "outputs");
const TEMP_DIR = path.join(__dirname, "temp");

const FFMPEG = "ffmpeg";
const FFPROBE = "ffprobe";
const ESPEAK = "espeak-ng";


await fs.mkdir(OUTPUT_DIR, { recursive: true });
await fs.mkdir(TEMP_DIR, { recursive: true });


/* =========================================================
   EXPRESS
========================================================= */

const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({
  extended: true,
  limit: "2mb"
}));

app.use(express.static(PUBLIC_DIR));


const upload = multer({
  dest: TEMP_DIR,
  limits: {
    fileSize: 300 * 1024 * 1024
  }
});


/* =========================================================
   COMMAND RUNNER
========================================================= */

function runCommand(
  command,
  args,
  timeout = 300000
) {
  return new Promise((resolve, reject) => {

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

    const timer = setTimeout(() => {

      if (finished) return;

      finished = true;

      try {
        child.kill("SIGKILL");
      } catch {}

      reject(
        new Error(
          `${command} timeout sau ${timeout / 1000} giây.`
        )
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
            `${command} exited with code ${code}\n${stderr.slice(-6000)}`
          )
        );
      }
    });
  });
}


/* =========================================================
   JSON
========================================================= */

function sendJson(
  res,
  status,
  data
) {
  return res
    .status(status)
    .type("application/json")
    .json(data);
}


/* =========================================================
   DOWNLOAD IMAGE FROM WIKIMEDIA
========================================================= */

async function downloadTopicImage(
  topic,
  output
) {

  const params = new URLSearchParams({
    action: "query",
    format: "json",
    generator: "search",
    gsrsearch: `${topic} photo`,
    gsrnamespace: "6",
    gsrlimit: "10",
    prop: "imageinfo",
    iiprop: "url|mime",
    iiurlwidth: "720"
  });


  const apiUrl =
    "https://commons.wikimedia.org/w/api.php?" +
    params.toString();


  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () => controller.abort(),
      15000
    );


  try {

    const response =
      await fetch(
        apiUrl,
        {
          signal: controller.signal,
          headers: {
            "User-Agent":
              "AI-Video-Factory/10.0"
          }
        }
      );


    if (!response.ok) {
      throw new Error(
        `Wikimedia HTTP ${response.status}`
      );
    }


    const data =
      await response.json();


    const pages =
      Object.values(
        data?.query?.pages || {}
      );


    for (const page of pages) {

      const info =
        page?.imageinfo?.[0];

      if (!info) continue;


      const mime =
        String(
          info.mime || ""
        ).toLowerCase();


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
        info.thumburl ||
        info.url;


      if (!imageUrl) continue;


      const imageResponse =
        await fetch(
          imageUrl,
          {
            signal: controller.signal,
            headers: {
              "User-Agent":
                "AI-Video-Factory/10.0"
            }
          }
        );


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


      console.log(
        "IMAGE FOUND:",
        page.title
      );


      return true;
    }


    throw new Error(
      "Không tìm thấy ảnh."
    );

  } finally {

    clearTimeout(timer);
  }
}


/* =========================================================
   FALLBACK IMAGE
========================================================= */

async function createFallbackImage(
  output
) {

  console.log(
    "IMAGE FALLBACK"
  );


  await runCommand(
    FFMPEG,
    [
      "-y",

      "-hide_banner",
      "-loglevel",
      "error",

      "-f",
      "lavfi",

      "-i",
      "testsrc2=size=576x1024:rate=1",

      "-frames:v",
      "1",

      output
    ],
    120000
  );
}


/* =========================================================
   NORMALIZE IMAGE
========================================================= */

async function normalizeImage(
  input,
  output
) {

  await runCommand(
    FFMPEG,
    [
      "-y",

      "-hide_banner",
      "-loglevel",
      "error",

      "-i",
      input,

      "-vf",
      "scale=576:1024:force_original_aspect_ratio=increase,crop=576:1024",

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
   SCRIPT
========================================================= */

function makeScript(
  topic,
  style,
  audience
) {

  return (
    `Xin chào bạn. ` +

    `Hôm nay chúng ta cùng khám phá ${topic}. ` +

    `Đây là một chủ đề rất thú vị và đáng tìm hiểu. ` +

    `Video được trình bày theo phong cách ${style}, ` +

    `dành cho ${audience}. ` +

    `Điều đầu tiên cần biết là ${topic} ` +

    `có nhiều đặc điểm đáng chú ý. ` +

    `Một điều thú vị khác là chủ đề này ` +

    `có thể mang đến cho chúng ta nhiều thông tin mới. ` +

    `Nếu bạn đang tìm hiểu về ${topic}, ` +

    `hãy chú ý đến những thông tin quan trọng ` +

    `và luôn kiểm tra nguồn thông tin. ` +

    `Hy vọng video ngắn này giúp bạn ` +

    `hiểu rõ hơn về ${topic}. ` +

    `Cảm ơn bạn đã xem video.`
  );
}


/* =========================================================
   OFFLINE VIETNAMESE TTS
========================================================= */

async function createVoice(
  text,
  output
) {

  console.log(
    "TTS START - OFFLINE eSpeak NG"
  );


  /*
    vi = Vietnamese Northern
    vi-vn-x-central = Central Vietnam
    vi-vn-x-south = Southern Vietnam
  */

  await runCommand(
    ESPEAK,
    [
      "-v",
      "vi",

      "-s",
      "145",

      "-p",
      "45",

      "-a",
      "160",

      "-w",
      output,

      text
    ],
    60000
  );


  const stat =
    await fs.stat(output);


  if (stat.size < 1000) {

    throw new Error(
      "eSpeak NG không tạo được file âm thanh."
    );
  }


  console.log(
    "TTS SUCCESS:",
    stat.size,
    "bytes"
  );
}


/* =========================================================
   CREATE VIDEO
========================================================= */

async function renderVideo(
  image,
  audio,
  output,
  duration
) {

  console.log(
    "FFMPEG START"
  );


  await runCommand(
    FFMPEG,
    [
      "-y",

      "-hide_banner",
      "-loglevel",
      "error",

      "-loop",
      "1",

      "-framerate",
      "24",

      "-i",
      image,

      "-i",
      audio,

      "-filter_complex",
      `[1:a]apad=whole_dur=${duration}[a]`,

      "-map",
      "0:v:0",

      "-map",
      "[a]",

      "-t",
      String(duration),

      "-c:v",
      "libx264",

      "-preset",
      "ultrafast",

      "-crf",
      "28",

      "-pix_fmt",
      "yuv420p",

      "-r",
      "24",

      "-c:a",
      "aac",

      "-b:a",
      "96k",

      "-ar",
      "44100",

      "-ac",
      "2",

      "-movflags",
      "+faststart",

      output
    ],
    300000
  );


  console.log(
    "FFMPEG SUCCESS"
  );
}


/* =========================================================
   PROBE
========================================================= */

async function probeVideo(
  file
) {

  const result =
    await runCommand(
      FFPROBE,
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


  return JSON.parse(
    result.stdout
  );
}


/* =========================================================
   VALIDATE
========================================================= */

async function validateVideo(
  file
) {

  const data =
    await probeVideo(file);


  const streams =
    data.streams || [];


  const video =
    streams.find(
      stream =>
        stream.codec_type === "video"
    );


  const audio =
    streams.find(
      stream =>
        stream.codec_type === "audio"
    );


  let decodeVideo = false;
  let decodeAudio = false;


  if (video) {

    try {

      await runCommand(
        FFMPEG,
        [
          "-hide_banner",
          "-loglevel",
          "error",

          "-i",
          file,

          "-map",
          "0:v:0",

          "-frames:v",
          "2",

          "-f",
          "null",

          "-"
        ],
        120000
      );

      decodeVideo = true;

    } catch {}
  }


  if (audio) {

    try {

      await runCommand(
        FFMPEG,
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

      decodeAudio = true;

    } catch {}
  }


  return {

    ok:
      Boolean(video) &&
      decodeVideo &&
      Boolean(audio) &&
      decodeAudio,

    videoStream:
      Boolean(video),

    audioStream:
      Boolean(audio),

    decodeVideo,

    decodeAudio,

    width:
      Number(video?.width || 0),

    height:
      Number(video?.height || 0),

    duration:
      Number(
        data.format?.duration || 0
      ),

    videoCodec:
      video?.codec_name || null,

    audioCodec:
      audio?.codec_name || null
  };
}


/* =========================================================
   CREATE ONE VIDEO
========================================================= */

async function createVideo(
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
      `${id}-raw`
    );


  const image =
    path.join(
      TEMP_DIR,
      `${id}.png`
    );


  const audio =
    path.join(
      TEMP_DIR,
      `${id}.wav`
    );


  try {

    /* ---------- IMAGE ---------- */

    console.log(
      "IMAGE START"
    );


    try {

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
        "IMAGE ERROR:",
        error.message
      );


      await createFallbackImage(
        image
      );
    }


    /* ---------- SCRIPT ---------- */

    const script =
      makeScript(
        topic,
        style,
        audience
      );


    console.log(
      "TTS script:",
      script
    );


    /* ---------- TTS ---------- */

    await createVoice(
      script,
      audio
    );


    /* ---------- VIDEO ---------- */

    await renderVideo(
      image,
      audio,
      output,
      duration
    );


    /* ---------- VALIDATION ---------- */

    const validation =
      await validateVideo(
        output
      );


    console.log(
      "VALIDATION:",
      JSON.stringify(validation)
    );


    if (!validation.ok) {

      throw new Error(
        "MP4 không vượt qua kiểm tra hình và tiếng."
      );
    }


    return {
      script,
      validation
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
  (_req, res) => {

    sendJson(
      res,
      200,
      {
        ok: true,

        version:
          "10.0.0",

        tts:
          "eSpeak NG offline",

        ffmpeg:
          FFMPEG,

        time:
          new Date().toISOString()
      }
    );
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
        "viral, cuốn hút"
      ).trim();


    const audience =
      String(
        req.body?.audience ||
        "mọi người"
      ).trim();


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
        30,
        Math.min(
          Number(
            req.body?.duration || 30
          ),
          90
        )
      );


    console.log(
      "================================"
    );

    console.log(
      "CREATE REQUEST"
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


    const videos = [];


    try {

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


        console.log(
          `CREATE VIDEO ${i + 1}/${count}`
        );


        try {

          const result =
            await createVideo(
              topic,
              style,
              audience,
              duration,
              output
            );


          const file =
            `/api/download/${id}`;


          videos.push({

            ok: true,

            index:
              i + 1,

            id,

            file,

            url:
              file,

            validation:
              result.validation

          });


          console.log(
            "VIDEO SUCCESS:",
            file
          );


        } catch (error) {

          console.error(
            "VIDEO ERROR:",
            error.message
          );


          await fs.rm(
            output,
            { force: true }
          );


          videos.push({

            ok: false,

            index:
              i + 1,

            error:
              error.message

          });
        }
      }


      const success =
        videos.filter(
          video => video.ok
        );


      const first =
        success[0] || null;


      return sendJson(
        res,
        200,
        {

          ok:
            success.length > 0,

          total:
            videos.length,

          success:
            success.length,

          message:
            `Đã tạo ${success.length}/${videos.length} video.`,

          file:
            first?.file || null,

          url:
            first?.file || null,

          videos

        }
      );


    } catch (error) {

      console.error(
        "GENERATE FATAL:",
        error
      );


      return sendJson(
        res,
        500,
        {
          ok: false,
          error:
            error.message
        }
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

      return sendJson(
        res,
        400,
        {
          ok: false,
          error:
            "ID không hợp lệ."
        }
      );
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

      sendJson(
        res,
        404,
        {
          ok: false,
          error:
            "Video không tồn tại."
        }
      );
    }
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

      return sendJson(
        res,
        400,
        {
          ok: false,
          error:
            "Chưa chọn video."
        }
      );
    }


    try {

      const result =
        await validateVideo(
          req.file.path
        );


      sendJson(
        res,
        200,
        result
      );


    } catch (error) {

      sendJson(
        res,
        422,
        {
          ok: false,
          error:
            error.message
        }
      );


    } finally {

      await fs.rm(
        req.file.path,
        { force: true }
      );
    }
  }
);


/* =========================================================
   API 404
========================================================= */

app.use(
  "/api",
  (req, res) => {

    sendJson(
      res,
      404,
      {
        ok: false,
        error:
          `API không tồn tại: ${req.method} ${req.path}`
      }
    );
  }
);


/* =========================================================
   SERVER ERROR
========================================================= */

app.use(
  (error, _req, res, _next) => {

    console.error(
      "SERVER ERROR:",
      error
    );


    sendJson(
      res,
      500,
      {
        ok: false,
        error:
          error.message ||
          "Server error."
      }
    );
  }
);


/* =========================================================
   START
========================================================= */

const server =
  app.listen(
    PORT,
    "0.0.0.0",
    () => {

      console.log(
        "================================"
      );

      console.log(
        "AI VIDEO FACTORY 10.0"
      );

      console.log(
        "Port:",
        PORT
      );

      console.log(
        "TTS: eSpeak NG OFFLINE"
      );

      console.log(
        "FFmpeg:",
        FFMPEG
      );

      console.log(
        "FFprobe:",
        FFPROBE
      );

      console.log(
        "================================"
      );
    }
  );


/*
  Cho phép request tạo video chạy lâu
  mà Node không tự timeout quá sớm.
*/

server.requestTimeout = 0;
server.timeout = 0;
