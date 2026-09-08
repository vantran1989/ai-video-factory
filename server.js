import "dotenv/config";

import express from "express";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import axios from "axios";

import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import gTTS from "gtts";

import { fileURLToPath } from "url";

/* =====================================================
   AI VIDEO FACTORY
   SERVER.JS - COMPLETE VERSION
   VERSION 9.0.0

   - Express
   - FFmpeg
   - Wikimedia Commons
   - Picsum fallback
   - Vietnamese TTS
   - 9:16 MP4
   - JSON API
   - Low-memory sequential processing
===================================================== */


/* =====================================================
   1. SYSTEM
===================================================== */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT =
  Number(process.env.PORT) || 10000;

if (!ffmpegPath) {
  throw new Error("Không tìm thấy FFmpeg.");
}

ffmpeg.setFfmpegPath(ffmpegPath);


/* =====================================================
   2. FOLDERS
===================================================== */

const DATA_DIR =
  path.join(__dirname, "data");

const OUTPUT_DIR =
  path.join(
    __dirname,
    "public",
    "output"
  );

const TEMP_DIR =
  path.join(
    __dirname,
    "temp"
  );


async function ensureFolders() {
  await fs.mkdir(
    DATA_DIR,
    { recursive: true }
  );

  await fs.mkdir(
    OUTPUT_DIR,
    { recursive: true }
  );

  await fs.mkdir(
    TEMP_DIR,
    { recursive: true }
  );
}


/* =====================================================
   3. EXPRESS
===================================================== */

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
  express.static(
    path.join(
      __dirname,
      "public"
    )
  )
);


/* =====================================================
   4. HELPERS
===================================================== */

function createId() {
  return crypto.randomUUID();
}


function sleep(ms) {
  return new Promise(
    resolve => setTimeout(resolve, ms)
  );
}


function cleanText(value) {
  if (
    value === undefined ||
    value === null
  ) {
    return "";
  }

  return String(value)
    .replace(/\s+/g, " ")
    .trim();
}


function safeFileName(value) {
  return cleanText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "video";
}


function escapeDrawText(value) {
  return cleanText(value)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/%/g, "\\%");
}


function splitIntoLines(
  text,
  maxChars = 28
) {
  const words =
    cleanText(text).split(" ");

  const lines = [];
  let current = "";

  for (const word of words) {
    const test =
      current
        ? `${current} ${word}`
        : word;

    if (
      test.length <= maxChars
    ) {
      current = test;
    } else {
      if (current) {
        lines.push(current);
      }

      current = word;
    }
  }

  if (current) {
    lines.push(current);
  }

  return lines;
}


function clamp(
  value,
  min,
  max
) {
  return Math.max(
    min,
    Math.min(max, value)
  );
}


/* =====================================================
   5. SCRIPT GENERATION
===================================================== */

function createScripts({
  topic,
  count,
  duration,
  style,
  audience
}) {
  const cleanTopic =
    cleanText(topic);

  const cleanStyle =
    cleanText(style) ||
    "viral, cuốn hút";

  const cleanAudience =
    cleanText(audience) ||
    "người xem Facebook";

  const number =
    clamp(
      Number(count) || 1,
      1,
      5
    );

  const seconds =
    clamp(
      Number(duration) || 30,
      10,
      60
    );

  const scripts = [];

  for (
    let i = 1;
    i <= number;
    i++
  ) {
    const title =
      `${cleanTopic} - Video ${i}`;

    const script =
      `Bạn có biết ${cleanTopic}? ` +
      `Đây là điều rất nhiều ${cleanAudience} ` +
      `đang quan tâm. ` +
      `Hãy cùng xem ${cleanTopic} ` +
      `và ghi nhớ những điều quan trọng nhất. ` +
      `Mẹo đơn giản nhưng có thể giúp bạn ` +
      `tiết kiệm thời gian và làm mọi thứ hiệu quả hơn. ` +
      `Nếu thấy hữu ích, hãy lưu lại và chia sẻ cho người cần nhé.`;

    scripts.push({
      index: i,
      title,
      topic: cleanTopic,
      script,
      duration: seconds,
      style: cleanStyle,
      audience: cleanAudience
    });
  }

  return scripts;
}


/* =====================================================
   6. WIKIMEDIA IMAGE SEARCH
===================================================== */

async function searchWikimediaImages(
  keyword,
  limit = 5
) {
  const query =
    cleanText(keyword);

  if (!query) {
    return [];
  }

  try {
    const response =
      await axios.get(
        "https://commons.wikimedia.org/w/api.php",
        {
          timeout: 15000,
          params: {
            action: "query",
            format: "json",
            generator: "search",
            gsrsearch: query,
            gsrnamespace: 6,
            gsrlimit: Math.min(
              limit * 3,
              30
            ),
            prop: "imageinfo",
            iiprop: "url|mime",
            iiurlwidth: 1080
          },
          headers: {
            "User-Agent":
              "AI-Video-Factory/9.0"
          }
        }
      );

    const pages =
      response.data?.query?.pages;

    if (!pages) {
      return [];
    }

    const results = [];

    for (
      const key of Object.keys(pages)
    ) {
      const page =
        pages[key];

      const info =
        page.imageinfo?.[0];

      if (!info) {
        continue;
      }

      const url =
        info.thumburl ||
        info.url;

      if (!url) {
        continue;
      }

      const mime =
        info.mime || "";

      if (
        !mime.startsWith("image/")
      ) {
        continue;
      }

      results.push({
        url,
        title:
          page.title || query
      });

      if (
        results.length >= limit
      ) {
        break;
      }
    }

    return results;
  } catch (error) {
    console.error(
      "WIKIMEDIA SEARCH ERROR:",
      error.message
    );

    return [];
  }
}


/* =====================================================
   7. FALLBACK IMAGES
===================================================== */

function fallbackImages(
  keyword,
  count = 5
) {
  const safe =
    encodeURIComponent(
      cleanText(keyword)
    );

  const results = [];

  for (
    let i = 0;
    i < count;
    i++
  ) {
    results.push({
      url:
        `https://picsum.photos/seed/${safe}-${i}/1080/1920`,
      title:
        cleanText(keyword)
    });
  }

  return results;
}


/* =====================================================
   8. DOWNLOAD IMAGE
===================================================== */

async function downloadImage(
  url,
  outputPath
) {
  try {
    const response =
      await axios.get(
        url,
        {
          responseType:
            "arraybuffer",
          timeout:
            30000,
          maxContentLength:
            15 * 1024 * 1024,
          maxBodyLength:
            15 * 1024 * 1024,
          headers: {
            "User-Agent":
              "Mozilla/5.0 AI-Video-Factory"
          }
        }
      );

    const buffer =
      Buffer.from(
        response.data
      );

    if (
      buffer.length < 1000
    ) {
      throw new Error(
        "File ảnh quá nhỏ."
      );
    }

    const contentType =
      String(
        response.headers[
          "content-type"
        ] || ""
      ).toLowerCase();

    const looksLikeImage =
      contentType.includes("image/") ||
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 ||
      buffer.toString(
        "ascii",
        0,
        8
      ).includes("PNG");

    if (!looksLikeImage) {
      throw new Error(
        "URL không trả về ảnh hợp lệ."
      );
    }

    await fs.writeFile(
      outputPath,
      buffer
    );

    return true;
  } catch (error) {
    console.error(
      "IMAGE DOWNLOAD ERROR:",
      error.message
    );

    try {
      await fs.unlink(
        outputPath
      );
    } catch {}

    return false;
  }
}


/* =====================================================
   9. GET REAL IMAGES
===================================================== */

async function getImagesForTopic(
  topic,
  workDir
) {
  let sources =
    await searchWikimediaImages(
      topic,
      6
    );

  if (
    sources.length < 3
  ) {
    sources = [
      ...sources,
      ...fallbackImages(
        topic,
        6 - sources.length
      )
    ];
  }

  const downloaded = [];

  for (
    let i = 0;
    i < sources.length;
    i++
  ) {
    const source =
      sources[i];

    const filePath =
      path.join(
        workDir,
        `image-${i}.jpg`
      );

    const ok =
      await downloadImage(
        source.url,
        filePath
      );

    if (ok) {
      downloaded.push(
        filePath
      );
    }

    if (
      downloaded.length >= 5
    ) {
      break;
    }

    await sleep(150);
  }

  return downloaded;
}


/* =====================================================
   10. VIETNAMESE TTS
===================================================== */

async function createVoice(
  text,
  outputPath
) {
  return new Promise(
    (resolve, reject) => {
      try {
        const speech =
          new gTTS(
            cleanText(text),
            "vi"
          );

        speech.save(
          outputPath,
          error => {
            if (error) {
              reject(error);
            } else {
              resolve(
                outputPath
              );
            }
          }
        );
      } catch (error) {
        reject(error);
      }
    }
  );
}


/* =====================================================
   11. FFMPEG DURATION
===================================================== */

function getDuration(
  filePath
) {
  return new Promise(
    (resolve, reject) => {
      ffmpeg.ffprobe(
        filePath,
        (error, data) => {
          if (error) {
            reject(error);
            return;
          }

          const duration =
            Number(
              data?.format?.duration
            );

          if (
            !Number.isFinite(
              duration
            )
          ) {
            reject(
              new Error(
                "Không đọc được thời lượng."
              )
            );

            return;
          }

          resolve(duration);
        }
      );
    }
  );
}


/* =====================================================
   12. CREATE SCENE
===================================================== */

function createScene({
  imagePath,
  outputPath,
  duration,
  title
}) {
  return new Promise(
    (resolve, reject) => {
      const safeTitle =
        escapeDrawText(
          title
        );

      const lines =
        splitIntoLines(
          title,
          25
        );

      const drawText =
        lines
          .map(
            (line, index) => {
              const text =
                escapeDrawText(
                  line
                );

              return (
                `drawtext=text='${text}'` +
                `:fontcolor=white` +
                `:fontsize=58` +
                `:borderw=3` +
                `:bordercolor=black` +
                `:x=(w-text_w)/2` +
                `:y=${1450 + index * 70}`
              );
            }
          )
          .join(",");

      ffmpeg()
        .input(imagePath)
        .inputOptions([
          "-loop 1"
        ])
        .videoFilters([
          "scale=1080:1920:force_original_aspect_ratio=increase",
          "crop=1080:1920",
          "setsar=1",
          drawText
        ])
        .outputOptions([
          "-t",
          String(duration),
          "-r",
          "25",
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "28",
          "-pix_fmt",
          "yuv420p",
          "-movflags",
          "+faststart",
          "-an"
        ])
        .output(
          outputPath
        )
        .on(
          "start",
          command => {
            console.log(
              "FFMPEG SCENE:"
            );

            console.log(
              command
            );
          }
        )
        .on(
          "error",
          error => {
            reject(error);
          }
        )
        .on(
          "end",
          () => {
            resolve(
              outputPath
            );
          }
        )
        .run();
    }
  );
}


/* =====================================================
   13. CONCAT SCENES
===================================================== */

function concatScenes(
  scenePaths,
  outputPath
) {
  return new Promise(
    (resolve, reject) => {
      if (
        !scenePaths.length
      ) {
        reject(
          new Error(
            "Không có scene để ghép."
          )
        );

        return;
      }

      let command =
        ffmpeg();

      for (
        const scene of scenePaths
      ) {
        command =
          command.input(
            scene
          );
      }

      const filter =
        scenePaths
          .map(
            (_, index) =>
              `[${index}:v:0]`
          )
          .join("") +
        `concat=n=${scenePaths.length}:v=1:a=0[outv]`;

      command
        .complexFilter(
          [filter]
        )
        .outputOptions([
          "-map",
          "[outv]",
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "28",
          "-pix_fmt",
          "yuv420p",
          "-movflags",
          "+faststart"
        ])
        .output(
          outputPath
        )
        .on(
          "error",
          error => {
            reject(error);
          }
        )
        .on(
          "end",
          () => {
            resolve(
              outputPath
            );
          }
        )
        .run();
    }
  );
}


/* =====================================================
   14. ADD AUDIO
===================================================== */

function addAudio(
  videoPath,
  audioPath,
  outputPath
) {
  return new Promise(
    (resolve, reject) => {
      ffmpeg()
        .input(
          videoPath
        )
        .input(
          audioPath
        )
        .outputOptions([
          "-map",
          "0:v:0",
          "-map",
          "1:a:0",
          "-c:v",
          "copy",
          "-c:a",
          "aac",
          "-b:a",
          "96k",
          "-shortest",
          "-movflags",
          "+faststart"
        ])
        .output(
          outputPath
        )
        .on(
          "error",
          error => {
            reject(error);
          }
        )
        .on(
          "end",
          () => {
            resolve(
              outputPath
            );
          }
        )
        .run();
    }
  );
}


/* =====================================================
   15. VALIDATE VIDEO
===================================================== */

async function validateVideo(
  filePath
) {
  const stat =
    await fs.stat(
      filePath
    );

  if (
    stat.size < 10000
  ) {
    throw new Error(
      "Video tạo ra quá nhỏ."
    );
  }

  return new Promise(
    (resolve, reject) => {
      ffmpeg.ffprobe(
        filePath,
        (error, data) => {
          if (error) {
            reject(error);
            return;
          }

          const streams =
            data?.streams || [];

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

          if (!video) {
            reject(
              new Error(
                "MP4 không có video stream."
              )
            );

            return;
          }

          if (!audio) {
            reject(
              new Error(
                "MP4 không có audio stream."
              )
            );

            return;
          }

          resolve({
            size: stat.size,
            width:
              video.width,
            height:
              video.height,
            videoCodec:
              video.codec_name,
            audioCodec:
              audio.codec_name,
            duration:
              Number(
                data?.format?.duration ||
                0
              )
          });
        }
      );
    }
  );
}


/* =====================================================
   16. CLEAN WORK DIRECTORY
===================================================== */

async function removeDir(
  dir
) {
  try {
    await fs.rm(
      dir,
      {
        recursive: true,
        force: true
      }
    );
  } catch {}
}


/* =====================================================
   17. CREATE ONE VIDEO
===================================================== */

async function generateOneVideo(
  script,
  index
) {
  const id =
    createId();

  const workDir =
    path.join(
      TEMP_DIR,
      id
    );

  await fs.mkdir(
    workDir,
    {
      recursive: true
    }
  );

  try {
    console.log("");
    console.log(
      "================================"
    );

    console.log(
      `VIDEO ${index}`
    );

    console.log(
      "TOPIC:",
      script.topic
    );

    console.log(
      "================================"
    );


    /* -----------------------------------------------
       IMAGES
    ------------------------------------------------ */

    const images =
      await getImagesForTopic(
        script.topic,
        workDir
      );

    if (
      !images.length
    ) {
      throw new Error(
        "Không tải được ảnh."
      );
    }

    console.log(
      "IMAGES:",
      images.length
    );


    /* -----------------------------------------------
       VOICE
    ------------------------------------------------ */

    const voicePath =
      path.join(
        workDir,
        "voice.mp3"
      );

    await createVoice(
      script.script,
      voicePath
    );

    console.log(
      "VOICE READY"
    );


    /* -----------------------------------------------
       REAL AUDIO DURATION
    ------------------------------------------------ */

    let audioDuration =
      await getDuration(
        voicePath
      );

    if (
      !Number.isFinite(
        audioDuration
      ) ||
      audioDuration <= 0
    ) {
      audioDuration =
        script.duration;
    }

    audioDuration =
      Math.max(
        5,
        audioDuration
      );

    console.log(
      "AUDIO DURATION:",
      audioDuration
    );


    /* -----------------------------------------------
       CREATE SCENES
    ------------------------------------------------ */

    const scenePaths = [];

    const sceneDuration =
      audioDuration /
      images.length;

    for (
      let i = 0;
      i < images.length;
      i++
    ) {
      const scenePath =
        path.join(
          workDir,
          `scene-${i}.mp4`
        );

      await createScene({
        imagePath:
          images[i],
        outputPath:
          scenePath,
        duration:
          sceneDuration,
        title:
          script.title
      });

      scenePaths.push(
        scenePath
      );

      console.log(
        `SCENE ${i + 1}/${images.length} READY`
      );
    }


    /* -----------------------------------------------
       CONCAT
    ------------------------------------------------ */

    const joinedPath =
      path.join(
        workDir,
        "joined.mp4"
      );

    await concatScenes(
      scenePaths,
      joinedPath
    );

    console.log(
      "SCENES JOINED"
    );


    /* -----------------------------------------------
       FINAL OUTPUT
    ------------------------------------------------ */

    const fileName =
      `${safeFileName(
        script.topic
      )}-${index}-${Date.now()}.mp4`;

    const finalPath =
      path.join(
        OUTPUT_DIR,
        fileName
      );

    await addAudio(
      joinedPath,
      voicePath,
      finalPath
    );

    console.log(
      "AUDIO ADDED"
    );


    /* -----------------------------------------------
       VALIDATE
    ------------------------------------------------ */

    const info =
      await validateVideo(
        finalPath
      );

    console.log(
      "VIDEO VALID:",
      info
    );

    return {
      ok: true,
      index,
      title:
        script.title,
      url:
        `/output/${fileName}`,
      fileName,
      duration:
        info.duration,
      width:
        info.width,
      height:
        info.height,
      size:
        info.size
    };
  } finally {
    await removeDir(
      workDir
    );
  }
}


/* =====================================================
   18. HEALTH
===================================================== */

app.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,
      service:
        "AI Video Factory",
      status:
        "running",
      version:
        "9.0.0"
    });
  }
);


/* =====================================================
   19. API INFO
===================================================== */

app.get(
  "/api",
  (req, res) => {
    res.json({
      ok: true,
      service:
        "AI Video Factory",
      version:
        "9.0.0",
      endpoints: {
        health:
          "/health",
        generate:
          "/api/generate",
        videos:
          "/api/videos"
      }
    });
  }
);


/* =====================================================
   20. GENERATE API
===================================================== */

app.post(
  "/api/generate",
  async (req, res) => {
    console.log("");
    console.log(
      "================================"
    );

    console.log(
      "GENERATE REQUEST"
    );

    console.log(
      req.body
    );

    console.log(
      "================================"
    );

    try {
      const body =
        req.body || {};

      const topic =
        cleanText(
          body.topic ||
          body.subject ||
          body.prompt
        );

      const count =
        clamp(
          Number(
            body.count ||
            body.number ||
            body.videoCount ||
            1
          ),
          1,
          5
        );

      const duration =
        clamp(
          Number(
            body.duration ||
            body.videoDuration ||
            30
          ),
          10,
          60
        );

      const style =
        cleanText(
          body.style ||
          body.tone ||
          "viral, cuốn hút"
        );

      const audience =
        cleanText(
          body.audience ||
          body.target ||
          "người xem Facebook"
        );

      if (!topic) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Vui lòng nhập chủ đề."
          });
      }

      const scripts =
        createScripts({
          topic,
          count,
          duration,
          style,
          audience
        });

      const results = [];

      /*
         QUAN TRỌNG:
         xử lý tuần tự để giảm RAM
      */

      for (
        let i = 0;
        i < scripts.length;
        i++
      ) {
        try {
          const result =
            await generateOneVideo(
              scripts[i],
              i + 1
            );

          results.push(
            result
          );
        } catch (error) {
          console.error(
            `VIDEO ${i + 1} ERROR:`,
            error
          );

          results.push({
            ok: false,
            index:
              i + 1,
            title:
              scripts[i].title,
            error:
              error.message ||
              "Không thể tạo video."
          });
        }

        /*
           Cho Node/FFmpeg nghỉ một chút
           giữa các video
        */

        await sleep(500);
      }

      const success =
        results.filter(
          item => item.ok
        );

      const failed =
        results.filter(
          item => !item.ok
        );

      return res.json({
        ok:
          success.length > 0,
        message:
          success.length > 0
            ? `Đã tạo ${success.length}/${scripts.length} video.`
            : "Không tạo được video nào.",
        total:
          scripts.length,
        success:
          success.length,
        failed:
          failed.length,
        videos:
          results
      });
    } catch (error) {
      console.error(
        "GENERATE API ERROR:"
      );

      console.error(
        error
      );

      /*
         LUÔN trả JSON.
         Đây là phần sửa lỗi:
         Unexpected token '<'
      */

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error.message ||
            "Lỗi máy chủ khi tạo video."
        });
    }
  }
);


/* =====================================================
   21. VIDEO LIST
===================================================== */

app.get(
  "/api/videos",
  async (req, res) => {
    try {
      await ensureFolders();

      const files =
        await fs.readdir(
          OUTPUT_DIR
        );

      const videos = [];

      for (
        const file of files
      ) {
        if (
          !file
            .toLowerCase()
            .endsWith(".mp4")
        ) {
          continue;
        }

        try {
          const stat =
            await fs.stat(
              path.join(
                OUTPUT_DIR,
                file
              )
            );

          videos.push({
            fileName:
              file,
            url:
              `/output/${file}`,
            size:
              stat.size,
            created:
              stat.mtime
          });
        } catch {}
      }

      videos.sort(
        (a, b) =>
          new Date(b.created) -
          new Date(a.created)
      );

      return res.json({
        ok: true,
        videos
      });
    } catch (error) {
      return res
        .status(500)
        .json({
          ok: false,
          error:
            error.message
        });
    }
  }
);


/* =====================================================
   22. FRONTEND
===================================================== */

app.get(
  "/",
  (req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        "public",
        "index.html"
      )
    );
  }
);


/* =====================================================
   23. 404 JSON FOR API
===================================================== */

app.use(
  "/api",
  (req, res) => {
    res
      .status(404)
      .json({
        ok: false,
        error:
          "API không tồn tại."
      });
  }
);


/* =====================================================
   24. GLOBAL ERROR
===================================================== */

app.use(
  (error, req, res, next) => {
    console.error(
      "GLOBAL ERROR:",
      error
    );

    if (
      res.headersSent
    ) {
      return next(error);
    }

    res
      .status(500)
      .json({
        ok: false,
        error:
          error.message ||
          "Server error."
      });
  }
);


/* =====================================================
   25. START SERVER
===================================================== */

async function startServer() {
  try {
    await ensureFolders();

    console.log("");
    console.log(
      "================================"
    );

    console.log(
      "🎬 AI VIDEO FACTORY"
    );

    console.log(
      "SERVER VERSION: 9.0.0"
    );

    console.log(
      "PORT:",
      PORT
    );

    console.log(
      "FFMPEG:",
      ffmpegPath
        ? "READY"
        : "ERROR"
    );

    console.log(
      "OUTPUT:",
      OUTPUT_DIR
    );

    console.log(
      "SERVER: READY"
    );

    console.log(
      "================================"
    );

    app.listen(
      PORT,
      "0.0.0.0",
      () => {
        console.log(
          `Server listening on port ${PORT}`
        );
      }
    );
  } catch (error) {
    console.error(
      "SERVER START ERROR:"
    );

    console.error(
      error
    );

    process.exit(1);
  }
}


stastartServer();
