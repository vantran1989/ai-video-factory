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
   PATH
========================================= */

const __filename =
  fileURLToPath(import.meta.url);

const __dirname =
  path.dirname(__filename);


/* =========================================
   APP
========================================= */

const app = express();

const PORT =
  process.env.PORT || 10000;


/* =========================================
   FFMPEG
========================================= */

ffmpeg.setFfmpegPath(
  ffmpegPath
);


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


/* =========================================
   ENSURE FOLDERS
========================================= */

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


  console.log(
    "Folders ready"
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
      /<[^>]*>/g,
      ""
    )

    .replace(
      /\s+/g,
      " "
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
   SAFE FILE NAME
========================================= */

function safeFileName(
  text = ""
) {

  return String(text)

    .replace(
      /[^a-zA-Z0-9]/g,
      "-"
    )

    .substring(
      0,
      50
    );

}


/* =========================================
   ESCAPE DRAWTEXT
========================================= */

function escapeDrawText(
  text = ""
) {

  return String(text)

    .replace(
      /\\/g,
      "\\\\"
    )

    .replace(
      /'/g,
      "\\'"
    )

    .replace(
      /:/g,
      "\\:"
    )

    .replace(
      /,/g,
      "\\,"
    )

    .replace(
      /\[/g,
      "\\["
    )

    .replace(
      /\]/g,
      "\\]"
    )

    .replace(
      /\n/g,
      " "
    );

}


/* =========================================
   SPLIT TEXT
========================================= */

function splitIntoLines(
  text,
  maxLength = 28
) {

  const words =
    cleanText(text)
      .split(" ");


  const lines = [];

  let line = "";


  for (
    const word
    of words
  ) {

    const test =
      line
        ? `${line} ${word}`
        : word;


    if (
      test.length >
      maxLength
    ) {

      if (
        line
      ) {

        lines.push(
          line
        );

      }


      line = word;

    }

    else {

      line = test;

    }

  }


  if (
    line
  ) {

    lines.push(
      line
    );

  }


  return lines;

}


/* =========================================
   CREATE SCRIPT
========================================= */

function createScript(
  topic,
  index
) {

  const cleanTopic =
    cleanText(topic);


  const hooks = [

    `Bạn có biết điều này về ${cleanTopic}?`,

    `Đây là một điều rất thú vị về ${cleanTopic}.`,

    `Ít người biết những điều này về ${cleanTopic}.`,

    `Hãy cùng khám phá ${cleanTopic}.`,

    `Có thể bạn sẽ bất ngờ về ${cleanTopic}.`

  ];


  const hook =
    hooks[
      index %
      hooks.length
    ];


  const text = `

${hook}

${cleanTopic} là một chủ đề có rất nhiều điều thú vị mà chúng ta thường chưa khám phá hết.

Khi tìm hiểu kỹ hơn, bạn sẽ nhận ra rằng mỗi góc nhìn đều mang lại những kiến thức mới.

Điều quan trọng là chúng ta cần quan sát, học hỏi và áp dụng thông tin một cách phù hợp trong cuộc sống.

Nếu bạn thấy thông tin này hữu ích, hãy chia sẻ để nhiều người cùng biết.

Bạn nghĩ sao về ${cleanTopic}?

`;


  return {

    title:
      `${cleanTopic} - Video ${index + 1}`,

    text:
      cleanText(text)

  };

}


/* =========================================
   CREATE MULTIPLE SCRIPTS
========================================= */

function createScripts(
  topic,
  count
) {

  const scripts = [];


  for (
    let i = 0;
    i < count;
    i++
  ) {

    scripts.push(

      createScript(
        topic,
        i
      )

    );

  }


  return scripts;

}


/* =========================================
   WIKIMEDIA IMAGE SEARCH
========================================= */

async function searchImages(
  keyword,
  limit = 5
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
              1920,

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


    if (
      !pages
    ) {

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
                ?.imageinfo
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

  catch (
    error
  ) {

    console.log(
      "Image search error:",
      error.message
    );


    return [];

  }

}


/* =========================================
   FALLBACK IMAGES
========================================= */

function fallbackImages() {

  return [

    "https://picsum.photos/1080/1920?random=1",

    "https://picsum.photos/1080/1920?random=2",

    "https://picsum.photos/1080/1920?random=3",

    "https://picsum.photos/1080/1920?random=4",

    "https://picsum.photos/1080/1920?random=5"

  ];

}


/* =========================================
   DOWNLOAD FILE
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
          30000,

        maxContentLength:
          30 * 1024 * 1024

      }

    );


  await fs.writeFile(

    filePath,

    response.data

  );


  return filePath;

}


/* =========================================
   CREATE VOICE
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

      try {

        const tts =
          new gTTS(

            text,

            "vi"

          );


        tts.save(

          output,

          error => {

            if (
              error
            ) {

              reject(
                error
              );

              return;

            }


            resolve(
              output
            );

          }

        );

      }

      catch (
        error
      ) {

        reject(
          error
        );

      }

    }
  );

}


/* =========================================
   GET MEDIA DURATION
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

          if (
            error
          ) {

            reject(
              error
            );

            return;

          }


          const duration =
            metadata
              ?.format
              ?.duration ||
            10;


          resolve(
            Number(
              duration
            )
          );

        }

      );

    }
  );

}


/* =========================================
   CREATE VIDEO SCENE

   1080 x 1920
   VERTICAL VIDEO
========================================= */

function createScene(
  image,
  output,
  duration,
  subtitle
) {

  return new Promise(
    (
      resolve,
      reject
    ) => {

      const safeSubtitle =
        escapeDrawText(
          subtitle
        );


      /*
        FONT

        Render Linux thường có
        DejaVu Sans
      */

      const fontFile =
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";


      const videoFilter =

        `scale=1080:1920:` +

        `force_original_aspect_ratio=increase,` +

        `crop=1080:1920,` +

        `setsar=1,` +

        `drawtext=` +

        `fontfile='${fontFile}':` +

        `text='${safeSubtitle}':` +

        `fontcolor=white:` +

        `fontsize=48:` +

        `x=(w-text_w)/2:` +

        `y=h-260:` +

        `box=1:` +

        `boxcolor=black@0.65:` +

        `boxborderw=25`;


      ffmpeg()

        .input(
          image
        )

        .inputOptions([
          "-loop 1"
        ])

        .videoFilters(
          videoFilter
        )

        .outputOptions([

          "-t",

          String(duration),

          "-r",

          "30",

          "-c:v",

          "libx264",

          "-preset",

          "veryfast",

          "-pix_fmt",

          "yuv420p",

          "-movflags",

          "+faststart"

        ])

        .noAudio()

        .on(
          "start",
          command => {

            console.log(
              "Creating scene"
            );

          }
        )

        .on(
          "end",

          () => {

            console.log(
              "Scene complete"
            );


            resolve(
              output
            );

          }

        )

        .on(
          "error",

          error => {

            console.error(
              "Scene error:",
              error.message
            );


            reject(
              error
            );

          }

        )

        .save(
          output
        );

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

      if (
        videos.length === 0
      ) {

        reject(
          new Error(
            "Không có cảnh video"
          )
        );


        return;

      }


      if (
        videos.length === 1
      ) {

        fs.copyFile(

          videos[0],

          output

        )

          .then(

            () => {

              resolve(
                output
              );

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

          command.input(
            video
          );

        }
      );


      command

        .on(

          "start",

          () => {

            console.log(
              "Merging scenes..."
            );

          }

        )

        .on(

          "error",

          error => {

            console.error(
              "Concat error:",
              error.message
            );


            reject(
              error
            );

          }

        )

        .on(

          "end",

          () => {

            console.log(
              "Merge complete"
            );


            resolve(
              output
            );

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

      ffmpeg()

        .input(
          video
        )

        .input(
          audio
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

          "192k",

          "-shortest",

          "-movflags",

          "+faststart"

        ])

        .on(

          "end",

          () => {

            resolve(
              output
            );

          }

        )

        .on(

          "error",

          error => {

            reject(
              error
            );

          }

        )

        .save(
          output
        );

    }
  );

}


/* =========================================
   CLEAN TEMP FOLDER
========================================= */

async function removeFolder(
  folder
) {

  try {

    await fs.rm(

      folder,

      {

        recursive:
          true,

        force:
          true

      }

    );

  }

  catch (
    error
  ) {

    console.log(
      "Cleanup error:",
      error.message
    );

  }

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

      recursive:
        true

    }

  );


  console.log(
    "================================"
  );


  console.log(
    "CREATING VIDEO:",
    index
  );


  console.log(
    "TOPIC:",
    topic
  );


  console.log(
    "================================"
  );


  try {


    /* =================================
       SEARCH IMAGES
    ================================= */

    let images =
      await searchImages(

        topic,

        5

      );


    if (
      images.length === 0
    ) {

      console.log(
        "Using fallback images"
      );


      images =
        fallbackImages();

    }


    /* =================================
       DOWNLOAD IMAGES
    ================================= */

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


        console.log(
          `Downloading image ${i + 1}`
        );


        await downloadFile(

          images[i],

          imagePath

        );


        localImages.push(
          imagePath
        );

      }

      catch (
        error
      ) {

        console.log(
          "Image download failed:",
          error.message
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


    /* =================================
       CREATE VOICE
    ================================= */

    console.log(
      "Creating Vietnamese voice..."
    );


    const audioPath =
      path.join(

        workDir,

        "voice.mp3"

      );


    await createVoice(

      text,

      audioPath

    );


    /* =================================
       GET AUDIO DURATION
    ================================= */

    const audioDuration =
      await getDuration(
        audioPath
      );


    console.log(
      "Audio duration:",
      audioDuration
    );


    /* =================================
       SCENE DURATION
    ================================= */

    const sceneDuration =
      Math.max(

        3,

        audioDuration /
        localImages.length

      );


    console.log(
      "Scene duration:",
      sceneDuration
    );


    /* =================================
       CREATE SCENES
    ================================= */

    const scenes = [];


    const subtitles =
      splitIntoLines(

        text,

        32

      );


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


      const subtitleIndex =
        Math.floor(

          (
            i /
            localImages.length
          ) *

          subtitles.length

        );


      const subtitle =
        subtitles[
          subtitleIndex
        ] ||

        topic;


      console.log(
        `Creating scene ${i + 1}/${localImages.length}`
      );


      await createScene(

        localImages[i],

        scenePath,

        sceneDuration,

        subtitle

      );


      scenes.push(
        scenePath
      );

    }


    /* =================================
       MERGE SCENES
    ================================= */

    const mergedPath =
      path.join(

        workDir,

        "merged.mp4"

      );


    await concatVideos(

      scenes,

      mergedPath

    );


    /* =================================
       FINAL FILE
    ================================= */

    const fileName =

      `video-${Date.now()}-${index}.mp4`;


    const finalPath =
      path.join(

        OUTPUT_DIR,

        fileName

      );


    console.log(
      "Adding audio..."
    );


    await addAudio(

      mergedPath,

      audioPath,

      finalPath

    );


    console.log(
      "VIDEO COMPLETE:",
      fileName
    );


    return {

      id:
        videoId,

      title:
        topic,

      file:
        `/output/${fileName}`,

      url:
        `/output/${fileName}`,

      duration:
        Math.round(
          audioDuration
        ),

      status:
        "complete"

    };


  }

  finally {

    /*
      Xóa file tạm
    */

    setTimeout(

      () => {

        removeFolder(
          workDir
        );

      },

      10000

    );

  }

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


      /* =============================
         VALIDATE TOPIC
      ============================= */

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


      /* =============================
         SAFE COUNT
      ============================= */

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
        "================================"
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


      /* =============================
         CREATE SCRIPTS
      ============================= */

      const scripts =
        createScripts(

          topic,

          safeCount

        );


      const videos = [];


      /* =============================
         GENERATE VIDEOS
      ============================= */

      for (
        let i = 0;
        i < scripts.length;
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


          /*
            Nghỉ 1 giây
          */

          await sleep(
            1000
          );


        }

        catch (
          error
        ) {

          console.error(
            "Video error:",
            error.message
          );


          videos.push({

            error:
              true,

            status:
              "failed",

            title:
              scripts[i].title,

            message:
              error.message

          });

        }

      }


      /* =============================
         RESPONSE
      ============================= */

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

      status:
        "running",

      port:
        PORT,

      mode:
        "free"

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

      status:
        "running",

      features: [

        "Free",

        "No OpenAI",

        "Vietnamese TTS",

        "Wikimedia Images",

        "Vertical Video",

        "1080x1920",

        "TikTok",

        "YouTube Shorts",

        "Facebook Reels",

        "MP4 Generator",

        "FFmpeg"

      ]

    });

  }

);


/* =========================================
   OUTPUT LIST
========================================= */

app.get(

  "/api/videos",

  async (
    req,
    res
  ) => {

    try {

      const files =
        await fs.readdir(
          OUTPUT_DIR
        );


      const videos =
        files

          .filter(

            file =>

              file.endsWith(
                ".mp4"
              )

          )

          .map(

            file => ({

              file,

              url:
                `/output/${file}`

            })

          );


      res.json({

        ok:
          true,

        videos

      });

    }

    catch (
      error
    ) {

      res.status(500)

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
   HOME
========================================= */

app.get(

  "/",

  (
    req,
    res
  ) => {

    res.sendFile(

      path.join(

        __dirname,

        "public",

        "index.html"

      )

    );

  }

);


/* =========================================
   START SERVER
========================================= */

async function startServer() {

  try {

    await ensureFolders();


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
          "AI VIDEO FACTORY"
        );


        console.log(
          "================================"
        );


        console.log(
          `AI Video Factory listening on ${PORT}`
        );


        console.log(
          `http://0.0.0.0:${PORT}`
        );


        console.log(
          "================================"
        );


      }

    );

  }

  catch (
    error
  ) {

    console.error(
      "Server startup error:",
      error
    );


    process.exit(
      1
    );

  }

}


startServer();
