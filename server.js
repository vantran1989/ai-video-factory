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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = process.env.PORT || 3000;

ffmpeg.setFfmpegPath(ffmpegPath);

app.use(express.json({ limit: "10mb" }));

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);


/* =========================================
   FOLDERS
========================================= */

const DATA_DIR = path.join(
  __dirname,
  "data"
);

const OUTPUT_DIR = path.join(
  __dirname,
  "public",
  "output"
);

const TEMP_DIR = path.join(
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


ensureFolders();


/* =========================================
   HELPERS
========================================= */

function id() {

  return crypto
    .randomUUID();

}


function cleanText(text = "") {

  return String(text)

    .replace(/\s+/g, " ")

    .replace(
      /[<>]/g,
      ""
    )

    .trim();

}


function escapeText(text = "") {

  return String(text)

    .replace(/'/g, "\\'")

    .replace(/:/g, "\\:")

    .replace(/,/g, "\\,")

    .replace(/\[/g, "\\[")

    .replace(/\]/g, "\\]");

}


function sleep(ms) {

  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );

}


/* =========================================
   CREATE SCRIPT
   KHÔNG DÙNG OPENAI
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

    `Đây là điều đáng chú ý về ${cleanTopic}.`,

    `Hãy cùng khám phá một góc nhìn khác về ${cleanTopic}.`,

    `Có một điều rất thú vị liên quan đến ${cleanTopic}.`

  ];


  for (
    let i = 0;
    i < count;
    i++
  ) {

    const hook =
      hooks[
        i %
        hooks.length
      ];


    const text =
      `${hook}

${cleanTopic} có nhiều khía cạnh thú vị mà chúng ta thường bỏ qua.

Khi tìm hiểu kỹ hơn, bạn sẽ thấy rằng kiến thức về ${cleanTopic} có thể giúp chúng ta hiểu vấn đề tốt hơn.

Điều quan trọng là hãy luôn quan sát, tìm hiểu và áp dụng thông tin một cách phù hợp.

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
   WIKIMEDIA IMAGE SEARCH
   MIỄN PHÍ
========================================= */

async function searchImages(
  keyword,
  limit = 3
) {

  try {

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
            15000

        }
      );


    const pages =
      response.data
        ?.query
        ?.pages;


    if (!pages) {

      return [];

    }


    const images =
      Object.values(pages)

        .map(page => {

          const info =
            page
              .imageinfo
              ?.[0];


          return (
            info?.thumburl ||
            info?.url ||
            null
          );

        })

        .filter(Boolean);


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

  const response =
    await axios.get(
      url,
      {
        responseType:
          "arraybuffer",

        timeout:
          30000
      }
    );


  await fs.writeFile(
    filePath,
    response.data
  );


  return filePath;

}


/* =========================================
   CREATE TTS
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

      const tts =
        new gTTS(
          text,
          "vi"
        );


      tts.save(
        output,
        error => {

          if (error) {

            reject(error);

          }

          else {

            resolve(output);

          }

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

      ffmpeg
        .ffprobe(
          file,
          (
            error,
            metadata
          ) => {

            if (error) {

              reject(error);

              return;

            }


            resolve(
              metadata
                .format
                .duration ||
              10
            );

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
  audio,
  output,
  duration,
  subtitle
) {

  return new Promise(
    (
      resolve,
      reject
    ) => {

      const text =
        escapeText(
          subtitle
        );


      ffmpeg()

        .input(image)

        .inputOptions([
          "-loop 1"
        ])

        .input(audio)

        .complexFilter([

          {
            filter:
              "scale",

            options:
              {

                w:
                  1280,

                h:
                  720,

                force_original_aspect_ratio:
                  "increase"

              },

            outputs:
              "scaled"

          },

          {
            filter:
              "crop",

            options:
              {

                w:
                  1280,

                h:
                  720

              },

            inputs:
              "scaled",

            outputs:
              "video"

          }

        ])

        .outputOptions([

          "-map 0:v",

          "-map 1:a",

          "-c:v libx264",

          "-preset veryfast",

          "-pix_fmt yuv420p",

          "-c:a aac",

          "-shortest",

          `-t ${duration}`,

          `-vf drawtext=text='${text}':fontcolor=white:fontsize=34:x=(w-text_w)/2:y=h-100:box=1:boxcolor=black@0.6:boxborderw=20`

        ])

        .save(output)

        .on(
          "end",
          () => {

            resolve(output);

          }
        )

        .on(
          "error",
          error => {

            reject(error);

          }
        );

    }
  );

}


/* =========================================
   CONCAT VIDEOS
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

      if (
        videos.length === 1
      ) {

        fs.copyFile(
          videos[0],
          output
        )

          .then(
            () =>
              resolve(output)
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
          "error",
          reject
        )

        .on(
          "end",
          () =>
            resolve(output)
        )

        .mergeToFile(
          output,
          TEMP_DIR
        );

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


  console.log(
    "Creating video:",
    index
  );


  /* -------------------------------
     SEARCH IMAGE
  -------------------------------- */

  let images =
    await searchImages(
      topic,
      3
    );


  /*
    FALLBACK
  */

  if (
    images.length === 0
  ) {

    images = [

      "https://picsum.photos/1280/720"

    ];

  }


  /* -------------------------------
     DOWNLOAD IMAGES
  -------------------------------- */

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

    }

    catch (error) {

      console.log(
        "Download image failed"
      );

    }

  }


  if (
    localImages.length === 0
  ) {

    throw new Error(
      "Không tải được hình ảnh"
    );

  }


  /* -------------------------------
     CREATE AUDIO
  -------------------------------- */

  const audioPath =
    path.join(
      workDir,
      "voice.mp3"
    );


  await createVoice(
    text,
    audioPath
  );


  const duration =
    await getDuration(
      audioPath
    );


  /* -------------------------------
     CREATE SCENES
  -------------------------------- */

  const sceneDuration =
    Math.max(
      5,
      duration /
      localImages.length
    );


  const scenes = [];


  for (
    let i = 0;
    i <
    localImages.length;
    i++
  ) {

    const scene =
      path.join(
        workDir,
        `scene-${i}.mp4`
      );


    await createScene(

      localImages[i],

      audioPath,

      scene,

      sceneDuration,

      topic

    );


    scenes.push(scene);

  }


  /* -------------------------------
     FINAL VIDEO
  -------------------------------- */

  const fileName =
    `video-${Date.now()}-${index}.mp4`;


  const finalPath =
    path.join(
      OUTPUT_DIR,
      fileName
    );


  await concatVideos(
    scenes,
    finalPath
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

      } =
        req.body;


      if (
        !topic ||
        !cleanText(topic)
      ) {

        return res.status(400)
          .json({

            ok:
              false,

            error:
              "Vui lòng nhập chủ đề"

          });

      }


      const safeCount =
        Math.min(
          Math.max(
            Number(count) || 1,
            1
          ),
          5
        );


      console.log(
        "=========================="
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
        "Style:",
        style
      );

      console.log(
        "Audience:",
        audience
      );

      console.log(
        "=========================="
      );


      const scripts =
        splitTopic(
          topic,
          safeCount
        );


      const videos =
        [];


      for (
        let i = 0;
        i <
        scripts.length;
        i++
      ) {

        try {

          const result =
            await generateOneVideo({

              topic:
                scripts[i].title,

              index:
                i + 1,

              text:
                scripts[i].text

            });


          videos.push(
            result
          );


          await sleep(
            1000
          );

        }

        catch (
          error
        ) {

          console.error(
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

    catch (
      error
    ) {

      console.error(
        "Generate error:",
        error
      );


      return res.status(500)
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

      mode:
        "free-no-openai"

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
        "5.0.0",

      features: [

        "Free",

        "No OpenAI",

        "Image Search",

        "Vietnamese Voice",

        "MP4 Generator",

        "FFmpeg"

      ]

    });

  }
);


/* =========================================
   START SERVER
========================================= */

app.listen(

  PORT,

  "0.0.0.0",

  () => {

    console.log(
      `AI Video Factory listening on ${PORT}`
    );

  }

);
