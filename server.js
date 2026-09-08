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

import { EdgeTTS } from "@travisvn/edge-tts";


/* =========================================================
   BASIC CONFIG
========================================================= */

const __filename =
  fileURLToPath(import.meta.url);

const __dirname =
  path.dirname(__filename);

const PORT =
  Number(process.env.PORT || 3000);

const PUBLIC_DIR =
  path.join(__dirname, "public");

const OUTPUT_DIR =
  path.join(__dirname, "outputs");

const TEMP_DIR =
  path.join(__dirname, "temp");


await fs.mkdir(
  OUTPUT_DIR,
  { recursive: true }
);

await fs.mkdir(
  TEMP_DIR,
  { recursive: true }
);


const app = express();

app.use(
  express.json({
    limit: "2mb"
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "2mb"
  })
);

app.use(
  express.static(PUBLIC_DIR)
);


const upload =
  multer({
    dest: TEMP_DIR,
    limits: {
      fileSize:
        300 * 1024 * 1024
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
  return new Promise(
    (resolve, reject) => {

      const child =
        spawn(
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
            child.kill(
              "SIGKILL"
            );
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
          stdout +=
            data.toString();
        }
      );


      child.stderr.on(
        "data",
        data => {
          stderr +=
            data.toString();
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
                `${command} exited with code ${code}\n${stderr.slice(-8000)}`
              )
            );
          }
        }
      );
    }
  );
}


/* =========================================================
   JSON SAFE RESPONSE
========================================================= */

function sendJson(
  res,
  status,
  data
) {
  res
    .status(status)
    .type("application/json")
    .json(data);
}


/* =========================================================
   MEDIA PROBE
========================================================= */

async function probe(
  file
) {

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

  return JSON.parse(
    result.stdout
  );
}


/* =========================================================
   INSPECT VIDEO
========================================================= */

async function inspectVideo(
  file
) {

  const data =
    await probe(file);

  const streams =
    data.streams || [];

  const video =
    streams.find(
      s =>
        s.codec_type ===
        "video"
    );

  const audio =
    streams.find(
      s =>
        s.codec_type ===
        "audio"
    );

  return {

    hasVideo:
      Boolean(video),

    hasAudio:
      Boolean(audio),

    width:
      Number(
        video?.width || 0
      ),

    height:
      Number(
        video?.height || 0
      ),

    duration:
      Number(
        data.format?.duration ||
        0
      ),

    videoCodec:
      video?.codec_name ||
      null,

    audioCodec:
      audio?.codec_name ||
      null
  };
}


/* =========================================================
   DECODE TEST
========================================================= */

async function testFrame(
  file
) {

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
        "2",

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


/* =========================================================
   AUDIO TEST
========================================================= */

async function testAudio(
  file
) {

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
        "0:a:0",

        "-t",
        "2",

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


/* =========================================================
   VALIDATE MP4
========================================================= */

async function validateVideo(
  file
) {

  const info =
    await inspectVideo(
      file
    );

  const decodeOk =
    info.hasVideo
      ? await testFrame(file)
      : false;

  const audioOk =
    info.hasAudio
      ? await testAudio(file)
      : false;

  return {

    ok:
      info.hasVideo &&
      decodeOk &&
      info.hasAudio &&
      audioOk,

    videoStream:
      info.hasVideo,

    decodeFrame:
      decodeOk,

    audio:
      audioOk,

    info
  };
}


/* =========================================================
   DOWNLOAD IMAGE
========================================================= */

async function getImage(
  topic,
  output
) {

  const params =
    new URLSearchParams({

      action:
        "query",

      format:
        "json",

      generator:
        "search",

      gsrsearch:
        `${topic} photo`,

      gsrnamespace:
        "6",

      gsrlimit:
        "10",

      prop:
        "imageinfo",

      iiprop:
        "url|mime",

      iiurlwidth:
        "720"
    });


  const apiUrl =
    "https://commons.wikimedia.org/w/api.php?" +
    params.toString();


  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () =>
        controller.abort(),
      20000
    );


  try {

    const response =
      await fetch(
        apiUrl,
        {
          signal:
            controller.signal,

          headers: {
            "User-Agent":
              "AI-Video-Factory/9.0"
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


    for (
      const page of pages
    ) {

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


      if (!imageUrl) {
        continue;
      }


      try {

        const imageResponse =
          await fetch(
            imageUrl,
            {
              signal:
                controller.signal,

              headers: {
                "User-Agent":
                  "AI-Video-Factory/9.0"
              }
            }
          );


        if (
          !imageResponse.ok
        ) {
          continue;
        }


        const buffer =
          Buffer.from(
            await imageResponse.arrayBuffer()
          );


        if (
          buffer.length <
          5000
        ) {
          continue;
        }


        await fs.writeFile(
          output,
          buffer
        );


        return {
          ok: true,
          title:
            page.title,
          url:
            imageUrl
        };

      } catch {

        continue;
      }
    }


    throw new Error(
      "Không tìm được ảnh."
    );

  } finally {

    clearTimeout(
      timeout
    );
  }
}


/* =========================================================
   NORMALIZE IMAGE
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
   FALLBACK IMAGE
========================================================= */

async function createFallbackImage(
  output
) {

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
      "color=c=0x17213b:s=576x1024",

      "-frames:v",
      "1",

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
  audience,
  duration
) {

  const t =
    String(topic || "")
      .trim()
      .slice(0, 150);

  const s =
    String(style || "")
      .trim()
      .slice(0, 80);

  const a =
    String(audience || "")
      .trim()
      .slice(0, 80);


  let text =

    `Xin chào bạn. ` +

    `Hôm nay chúng ta cùng khám phá ${t}. ` +

    `Đây là một chủ đề rất thú vị và đáng tìm hiểu. ` +

    `Video được trình bày theo phong cách ${s}, ` +

    `phù hợp với ${a}. ` +

    `Điều đầu tiên cần biết là ${t} ` +

    `có nhiều đặc điểm đáng chú ý. ` +

    `Khi hiểu những điểm chính, ` +

    `chúng ta sẽ có góc nhìn rõ ràng hơn. ` +

    `Một điều thú vị khác là chủ đề này ` +

    `có thể liên quan đến những điều chúng ta gặp ` +

    `trong cuộc sống hằng ngày. ` +

    `Nếu bạn đang tìm hiểu về ${t}, ` +

    `hãy chú ý đến những thông tin quan trọng ` +

    `và luôn kiểm tra nguồn thông tin. ` +

    `Hy vọng video ngắn này giúp bạn ` +

    `hiểu rõ hơn về ${t}. ` +

    `Cảm ơn bạn đã xem video.`;


  /*
    30 giây không cần văn bản quá dài.
    TTS sẽ được kéo dài/đệm khi ghép video.
  */

  const maxChars =
    duration <= 30
      ? 1300
      : duration <= 60
        ? 2200
        : 3000;


  return text.slice(
    0,
    maxChars
  );
}


/* =========================================================
   NODE EDGE TTS
========================================================= */

async function createVoice(
  text,
  output
) {

  console.log(
    "TTS START"
  );


  const tts =
    new EdgeTTS(
      text,
      "vi-VN-HoaiMyNeural",
      {
        rate: "+0%",
        volume: "+0%",
        pitch: "+0Hz"
      }
    );


  const result =
    await Promise.race([

      tts.synthesize(),

      new Promise(
        (_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  "TTS timeout sau 90 giây."
                )
              ),
            90000
          )
      )

    ]);


  const buffer =
    Buffer.from(
      await result.audio.arrayBuffer()
    );


  if (
    buffer.length <
    1000
  ) {

    throw new Error(
      "TTS không tạo được audio."
    );
  }


  await fs.writeFile(
    output,
    buffer
  );


  console.log(
    "TTS SUCCESS:",
    buffer.length,
    "bytes"
  );
}


/* =========================================================
   CREATE MP4
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
    ffmpegPath,
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
   COMPLETE VIDEO CREATION
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
      `${id}.mp3`
    );


  try {

    console.log(
      "IMAGE START"
    );


    try {

      const imageInfo =
        await getImage(
          topic,
          rawImage
        );


      console.log(
        "IMAGE FOUND:",
        imageInfo.title
      );


      await normalizeImage(
        rawImage,
        image
      );

    } catch (error) {

      console.log(
        "IMAGE FALLBACK:",
        error.message
      );


      await createFallbackImage(
        image
      );
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


    await renderVideo(
      image,
      audio,
      output,
      duration
    );


    const validation =
      await validateVideo(
        output
      );


    console.log(
      "VALIDATION:",
      JSON.stringify(
        validation
      )
    );


    if (!validation.ok) {

      throw new Error(
        "MP4 không vượt qua kiểm tra hình/tiếng."
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
        version: "9.0.0",
        tts:
          "@travisvn/edge-tts",
        ffmpeg:
          Boolean(ffmpegPath),
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


        try {

          console.log(
            `CREATE VIDEO ${i + 1}/${count}`
          );


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
            url: file,
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
            error
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


      const successful =
        videos.filter(
          v => v.ok
        );


      const first =
        successful[0] || null;


      return sendJson(
        res,
        200,
        {
          ok:
            successful.length > 0,

          total:
            videos.length,

          success:
            successful.length,

          message:
            `Đã tạo ${successful.length}/${videos.length} video.`,

          file:
            first?.file || null,

          url:
            first?.file || null,

          videos
        }
      );

    } catch (error) {

      console.error(
        "GENERATE FATAL ERROR:",
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

      await fs.access(
        file
      );


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
   INSPECT UPLOADED VIDEO
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

      console.error(
        "INSPECT ERROR:",
        error
      );


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
   404 API
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
   ERROR HANDLER
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

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "================================"
    );

    console.log(
      "AI VIDEO FACTORY 9.0"
    );

    console.log(
      "Port:",
      PORT
    );

    console.log(
      "TTS:",
      "@travisvn/edge-tts"
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
