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


/* =========================================
   SETUP
========================================= */

const __filename = fileURLToPath(import.meta.url);

const __dirname =
  path.dirname(__filename);


const app = express();


const PORT =
  process.env.PORT || 10000;


/* =========================================
   FFMPEG
========================================= */

if (ffmpegPath) {

  ffmpeg.setFfmpegPath(
    ffmpegPath
  );

}


/* =========================================
   MIDDLEWARE
========================================= */

app.use(
  express.json({
    limit: "10mb"
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


/* =========================================
   FOLDERS
========================================= */

const DATA_DIR =
  path.join(
    __dirname,
    "data"
  );


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
    {
      recursive: true
    }
  );


  await fs.mkdir(
    OUTPUT_DIR,
    {
      recursive: true
    }
  );


  await fs.mkdir(
    TEMP_DIR,
    {
      recursive: true
    }
  );


}


/* =========================================
   HELPERS
========================================= */

function id() {

  return crypto.randomUUID();

}


function cleanText(
  text = ""
) {

  return String(text)

    .replace(
      /\s+/g,
      " "
    )

    .replace(
      /[<>]/g,
      ""
    )

    .trim();

}


function sleep(ms) {

  return new Promise(
    resolve => {

      setTimeout(
        resolve,
        ms
      );

    }
  );

}


/* =========================================
   CREATE SCRIPT
========================================= */

function splitTopic(
  topic,
  count
) {

  const cleanTopic =
    cleanText(topic);


  const scripts = [];


  const hooks = [

    `Bạn có biết điều này về ${cleanTopic}?`,

    `Ít người biết sự thật này về ${cleanTopic}.`,

    `Đây là điều thú vị về ${cleanTopic}.`,

    `Hãy cùng khám phá ${cleanTopic}.`,

    `Có một điều đáng chú ý về ${cleanTopic}.`

  ];


  for (
    let i = 0;
    i < count;
    i++
  ) {

    const hook =
      hooks[
        i % hooks.length
      ];


    const text =
      `${hook}

${cleanTopic} là một chủ đề có nhiều điều thú vị.

Khi tìm hiểu kỹ hơn, chúng ta có thể khám phá thêm nhiều thông tin hữu ích.

Điều quan trọng là luôn tìm hiểu thông tin một cách cẩn thận.

Bạn nghĩ sao về ${cleanTopic}?`;


    scripts.push({

      title:
        `${cleanTopic} - Video ${i + 1}`,

      text:
        cleanText(text)

    });

  }


  return scripts;

}


/* =========================================
   SEARCH WIKIMEDIA IMAGES
========================================= */

async function searchImages(
  keyword,
  limit = 3
) {

  try {

    console.log(
      "Searching images:",
      keyword
    );


    const response =
      await axios.get(

        "https://commons.wikimedia.org/w/api.php",

        {

          params: {

            action:
              "query",

            generator:
              "search",

            gsrsearch:
              keyword,

            gsrnamespace:
              6,

            gsrlimit:
              limit,

            prop:
              "imageinfo",

            iiprop:
              "url",

            iiurlwidth:
              1280,

            format:
              "json",

            origin:
              "*"

          },

          timeout:
            20000

        }

      );


    const pages =
      response.data
        ?.query
        ?.pages;


    if (!pages) {

      console.log(
        "No Wikimedia images"
      );

      return [];

    }


    const images =
      Object.values(pages)

        .map(
          page => {

            const info =
              page
                .imageinfo
                ?.[0];


            return (

              info?.thumburl ||

              info?.url ||

              null

            );

          }
        )

        .filter(Boolean);


    console.log(
      "Images found:",
      images.length
    );


    return images;

  }

  catch (error) {

    console.log(
      "Image search error:",
      error.message
    );


    return [];

  }

}


/* =========================================
   DOWNLOAD IMAGE
========================================= */

async function downloadFile(
  url,
  filePath
) {

  console.log(
    "Downloading image..."
  );


  const response =
    await axios.get(

      url,

      {

        responseType:
          "arraybuffer",

        timeout:
          30000,

        headers: {

          "User-Agent":
            "Mozilla/5.0"

        }

      }

    );


  await fs.writeFile(
    filePath,
    response.data
  );


  return filePath;

}


/* =========================================
   CREATE FALLBACK IMAGE
========================================= */

async function createFallbackImage(
  filePath
) {

  console.log(
    "Creating fallback image"
  );


  const width = 1280;

  const height = 720;


  const header =
    `P6\n${width} ${height}\n255\n`;


  const pixels =
    Buffer.alloc(
      width *
      height *
      3
    );


  for (
    let y = 0;
    y < height;
    y++
  ) {

    for (
      let x = 0;
      x < width;
      x++
    ) {

      const index =
        (
          y *
          width +
          x
        ) * 3;


      pixels[index] =
        35 + Math.floor(
          x / width * 30
        );


      pixels[index + 1] =
        45 + Math.floor(
          y / height * 30
        );


      pixels[index + 2] =
        90 + Math.floor(
          x / width * 50
        );

    }

  }


  await fs.writeFile(
    filePath,

    Buffer.concat([

      Buffer.from(header),

      pixels

    ])

  );


  return filePath;

}


/* =========================================
   CREATE VIETNAMESE VOICE
========================================= */

function createVoice(
  text,
  output
) {

  return new Promise(
    (
      resolve,
      reject
    ) => {

      console.log(
        "Creating Vietnamese voice..."
      );


      const tts =
        new gTTS(
          text,
          "vi"
        );


      tts.save(

        output,

        error => {

          if (error) {

            console.log(
              "TTS error:",
              error.message
            );


            reject(error);

            return;

          }


          resolve(output);

        }

      );

    }
  );

}


/* =========================================
   GET AUDIO DURATION
========================================= */

function getDuration(
  file
) {

  return new Promise(
    (
      resolve,
      reject
    ) => {

      ffmpeg.ffprobe(

        file,

        (
          error,
          metadata
        ) => {

          if (error) {

            reject(error);

            return;

          }


          const duration =
            metadata
              ?.format
              ?.duration ||
            10;


          resolve(duration);

        }

      );

    }
  );

}


/* =========================================
   CREATE VIDEO SCENE
========================================= */

function createScene(
  image,
  output,
  duration
) {

  return new Promise(
    (
      resolve,
      reject
    ) => {

      console.log(
        "Creating scene..."
      );


      ffmpeg()

        .input(image)

        .inputOptions([
          "-loop 1"
        ])

        .outputOptions([

          "-t " + duration,

          "-vf",

          "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720",

          "-c:v",

          "libx264",

          "-preset",

          "veryfast",

          "-pix_fmt",

          "yuv420p",

          "-r",

          "25",

          "-movflags",

          "+faststart",

          "-an"

        ])

        .on(
          "start",

          commandLine => {

            console.log(
              "FFmpeg scene started"
            );

          }
        )

        .on(
          "end",

          () => {

            console.log(
              "Scene created"
            );


            resolve(output);

          }
        )

        .on(
          "error",

          error => {

            console.log(
              "Scene error:",
              error.message
            );


            reject(error);

          }
        )

        .save(output);

    }
  );

}


/* =========================================
   CONCAT VIDEO SCENES
========================================= */

function concatVideos(
  videos,
  output
) {

  return new Promise(
    (
      resolve,
      reject
    ) => {

      console.log(
        "Merging scenes:",
        videos.length
      );


      if (
        videos.length === 1
      ) {

        fs.copyFile(
          videos[0],
          output
        )

          .then(
            () => {

              resolve(output);

            }
          )

          .catch(
            reject
          );


        return;

      }


      const command =
        ffmpeg();


      videos.forEach(
        video => {

          command.input(video);

        }
      );


      command

        .on(
          "end",

          () => {

            console.log(
              "Scenes merged"
            );


            resolve(output);

          }
        )

        .on(
          "error",

          error => {

            console.log(
              "Merge error:",
              error.message
            );


            reject(error);

          }
        )

        .mergeToFile(
          output,
          TEMP_DIR
        );

    }
  );

}


/* =========================================
   ADD AUDIO TO VIDEO
========================================= */

function addAudio(
  video,
  audio,
  output
) {

  return new Promise(
    (
      resolve,
      reject
    ) => {

      console.log(
        "Adding audio..."
      );


      ffmpeg()

        .input(video)

        .input(audio)

        .outputOptions([

          "-c:v copy",

          "-c:a aac",

          "-shortest",

          "-movflags +faststart"

        ])

        .on(
          "end",

          () => {

            console.log(
              "Audio added"
            );


            resolve(output);

          }
        )

        .on(
          "error",

          error => {

            console.log(
              "Audio error:",
              error.message
            );


            reject(error);

          }
        )

        .save(output);

    }
  );

}


/* =========================================
   CREATE ONE VIDEO
========================================= */

async function generateOneVideo(
  options
) {

  const {

    topic,

    index,

    text

  } = options;


  console.log(
    "=========================="
  );


  console.log(
    "GENERATING VIDEO:",
    index
  );


  console.log(
    "Topic:",
    topic
  );


  const videoId =
    id();


  const workDir =
    path.join(
      TEMP_DIR,
      videoId
    );


  await fs.mkdir(
    workDir,
    {
      recursive: true
    }
  );


  /* =====================================
     SEARCH IMAGES
  ===================================== */

  let images =
    await searchImages(
      topic,
      3
    );


  console.log(
    "Image URLs:",
    images.length
  );


  /* =====================================
     DOWNLOAD IMAGES
  ===================================== */

  const localImages = [];


  for (
    let i = 0;
    i < images.length;
    i++
  ) {

    try {

      const imagePath =
        path.join(
          workDir,
          `image-${i}.jpg`
        );


      await downloadFile(
        images[i],
        imagePath
      );


      localImages.push(
        imagePath
      );


      console.log(
        "Image downloaded:",
        i + 1
      );

    }

    catch (error) {

      console.log(
        "Image download failed:",
        error.message
      );

    }

  }


  /* =====================================
     FALLBACK IMAGE
  ===================================== */

  if (
    localImages.length === 0
  ) {

    console.log(
      "No images downloaded"
    );


    const fallbackPath =
      path.join(
        workDir,
        "fallback.ppm"
      );


    await createFallbackImage(
      fallbackPath
    );


    localImages.push(
      fallbackPath
    );

  }


  /* =====================================
     CREATE AUDIO
  ===================================== */

  const audioPath =
    path.join(
      workDir,
      "voice.mp3"
    );


  await createVoice(
    text,
    audioPath
  );


  console.log(
    "Voice created"
  );


  /* =====================================
     GET DURATION
  ===================================== */

  const duration =
    await getDuration(
      audioPath
    );


  console.log(
    "Audio duration:",
    duration
  );


  /* =====================================
     CALCULATE SCENE DURATION
  ===================================== */

  const sceneDuration =
    Math.max(

      4,

      duration /
      localImages.length

    );


  console.log(
    "Scene duration:",
    sceneDuration
  );


  /* =====================================
     CREATE SCENES
  ===================================== */

  const scenes = [];


  for (
    let i = 0;
    i < localImages.length;
    i++
  ) {

    const scenePath =
      path.join(
        workDir,
        `scene-${i}.mp4`
      );


    await createScene(

      localImages[i],

      scenePath,

      sceneDuration

    );


    scenes.push(
      scenePath
    );

  }


  /* =====================================
     MERGE SCENES
  ===================================== */

  const mergedVideo =
    path.join(
      workDir,
      "merged.mp4"
    );


  await concatVideos(

    scenes,

    mergedVideo

  );


  /* =====================================
     FINAL VIDEO
  ===================================== */

  const fileName =
    `video-${Date.now()}-${index}.mp4`;


  const finalPath =
    path.join(
      OUTPUT_DIR,
      fileName
    );


  await addAudio(

    mergedVideo,

    audioPath,

    finalPath

  );


  console.log(
    "VIDEO COMPLETE:",
    finalPath
  );


  /* =====================================
     CLEAN TEMP LATER
  ===================================== */

  setTimeout(

    async () => {

      try {

        await fs.rm(
          workDir,
          {
            recursive: true,
            force: true
          }
        );

      }

      catch (error) {

        console.log(
          "Temp cleanup error"
        );

      }

    },

    60000

  );


  return {

    id:
      videoId,

    title:
      topic,

    file:
      `/output/${fileName}`,

    duration:
      Math.round(
        duration
      )

  };

}


/* =========================================
   GENERATE API
========================================= */

app.post(

  "/api/generate",

  async (
    req,
    res
  ) => {

    try {

      const {

        topic,

        count = 1,

        duration = 30,

        style = "viral",

        audience = "người xem Facebook"

      } = req.body;


      /* ===============================
         VALIDATE
      =============================== */

      if (
        !topic ||
        !cleanText(topic)
      ) {

        return res
          .status(400)
          .json({

            ok:
              false,

            error:
              "Vui lòng nhập chủ đề"

          });

      }


      /* ===============================
         SAFE COUNT
      =============================== */

      const safeCount =
        Math.min(

          Math.max(

            Number(count) || 1,

            1

          ),

          5

        );


      console.log(
        ""
      );


      console.log(
        "================================"
      );


      console.log(
        "AI VIDEO FACTORY"
      );


      console.log(
        "Topic:",
        topic
      );


      console.log(
        "Videos:",
        safeCount
      );


      console.log(
        "Duration:",
        duration
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
        "================================"
      );


      /* ===============================
         CREATE SCRIPTS
      =============================== */

      const scripts =
        splitTopic(

          topic,

          safeCount

        );


      const videos = [];


      /* ===============================
         GENERATE VIDEOS
      =============================== */

      for (
        let i = 0;
        i < scripts.length;
        i++
      ) {

        try {

          const result =
            await generateOneVideo({

              topic:
                topic,

              index:
                i + 1,

              text:
                scripts[i].text

            });


          videos.push(
            result
          );


          console.log(
            "Video success:",
            i + 1
          );


          await sleep(
            1000
          );

        }

        catch (error) {

          console.error(
            "Video failed:",
            error.message
          );


          videos.push({

            error:
              true,

            title:
              scripts[i].title,

            message:
              error.message

          });

        }

      }


      /* ===============================
         RESPONSE
      =============================== */

      return res.json({

        ok:
          true,

        topic,

        style,

        audience,

        requestedDuration:
          duration,

        videos

      });

    }

    catch (error) {

      console.error(
        "Generate API error:",
        error
      );


      return res
        .status(500)
        .json({

          ok:
            false,

          error:
            error.message

        });

    }

  }

);


/* =========================================
   HEALTH CHECK
========================================= */

app.get(

  "/health",

  (
    req,
    res
  ) => {

    res.json({

      ok:
        true,

      service:
        "AI Video Factory",

      version:
        "6.0.0",

      ffmpeg:
        !!ffmpegPath

    });

  }

);


/* =========================================
   API INFO
========================================= */

app.get(

  "/api",

  (
    req,
    res
  ) => {

    res.json({

      name:
        "AI Video Factory",

      version:
        "6.0.0",

      features: [

        "Free",

        "No OpenAI",

        "Wikimedia Images",

        "Fallback Image",

        "Vietnamese Voice",

        "FFmpeg",

        "MP4 Generator"

      ]

    });

  }

);


/* =========================================
   START SERVER
========================================= */

ensureFolders()

  .then(
    () => {

      app.listen(

        PORT,

        "0.0.0.0",

        () => {

          console.log(
            ""
          );


          console.log(
            "================================"
          );


          console.log(
            "AI VIDEO FACTORY STARTED"
          );


          console.log(
            "PORT:",
            PORT
          );


          console.log(
            "================================"
          );


        }

      );

    }
  )

  .catch(
    error => {

      console.error(
        "Startup error:",
        error
      );

    }
  );
