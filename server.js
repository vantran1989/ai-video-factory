import "dotenv/config";

import express from "express";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";

import { fileURLToPath } from "url";


/* =====================================================
   AI VIDEO FACTORY
   SERVER.JS - PHẦN 1
   KHỞI TẠO HỆ THỐNG
===================================================== */


/* =====================================================
   PATH CỦA SERVER
===================================================== */

const __filename =
  fileURLToPath(import.meta.url);

const __dirname =
  path.dirname(__filename);


/* =====================================================
   EXPRESS
===================================================== */

const app =
  express();


/* =====================================================
   PORT
===================================================== */

const PORT =
  Number(
    process.env.PORT
  ) || 10000;


/* =====================================================
   FFMPEG
===================================================== */

if (!ffmpegPath) {

  throw new Error(
    "Không tìm thấy FFmpeg"
  );

}

ffmpeg.setFfmpegPath(
  ffmpegPath
);


/* =====================================================
   MIDDLEWARE
===================================================== */

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


/* =====================================================
   THƯ MỤC HỆ THỐNG
===================================================== */

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


/* =====================================================
   TẠO THƯ MỤC
===================================================== */

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
    "================================"
  );

  console.log(
    "SYSTEM FOLDERS READY"
  );

  console.log(
    "DATA:",
    DATA_DIR
  );

  console.log(
    "OUTPUT:",
    OUTPUT_DIR
  );

  console.log(
    "TEMP:",
    TEMP_DIR
  );

  console.log(
    "================================"
  );

}


/* =====================================================
   ID
===================================================== */

function createId() {

  return crypto.randomUUID();

}


/* =====================================================
   HEALTH CHECK
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
        "8.0.0"

    });

  }
);


/* =====================================================
   TRANG CHỦ
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
   KHỞI ĐỘNG SERVER
===================================================== */

async function startServer() {

  try {

    await ensureFolders();


    app.listen(
      PORT,
      "0.0.0.0",
      () => {

        console.log("");
        console.log(
          "================================"
        );

        console.log(
          "🎬 AI VIDEO FACTORY"
        );

        console.log(
          "SERVER VERSION: 8.0.0"
        );

        console.log(
          `PORT: ${PORT}`
        );

        console.log(
          "FFMPEG: READY"
        );

        console.log(
          "SERVER: READY"
        );

        console.log(
          "================================"
        );

      }
    );

  }

  catch (error) {

    console.error(
      "SERVER START ERROR:"
    );

    console.error(
      error
    );

    process.exit(
      1
    );

  }

}


/* =====================================================
   START
===================================================== */

startServer();
