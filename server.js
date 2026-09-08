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
   SERVER.JS
   PHẦN 1 + PHẦN 2
===================================================== */

const __filename =
  fileURLToPath(import.meta.url);

const __dirname =
  path.dirname(__filename);

const app =
  express();

const PORT =
  Number(process.env.PORT) || 10000;


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
   EXPRESS
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
   THƯ MỤC
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
   TEXT
===================================================== */

function cleanText(text) {

  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();

}


function limitText(
  text,
  max = 5000
) {

  const value =
    cleanText(text);

  if (
    value.length <= max
  ) {
    return value;
  }

  return value
    .slice(0, max)
    .trim();

}


/* =====================================================
   THỜI LƯỢNG
===================================================== */

function getDurationSeconds(
  duration
) {

  const value =
    Number(duration);

  if (
    !Number.isFinite(value)
  ) {
    return 30;
  }

  if (value <= 15) {
    return 15;
  }

  if (value <= 30) {
    return 30;
  }

  if (value <= 60) {
    return 60;
  }

  return 90;

}


/* =====================================================
   PHONG CÁCH
===================================================== */

function getStyleText(
  style
) {

  const styles = {

    viral:
      "viral, cuốn hút, câu mở đầu mạnh, nhịp nhanh",

    educational:
      "giải thích dễ hiểu, rõ ràng, có giá trị",

    storytelling:
      "kể chuyện, tạo tò mò, có cao trào",

    emotional:
      "cảm xúc, gần gũi, dễ đồng cảm",

    professional:
      "chuyên nghiệp, ngắn gọn, đáng tin cậy"

  };

  return (
    styles[
      String(style || "")
        .toLowerCase()
    ]
    || styles.viral
  );

}


/* =====================================================
   HOOK
===================================================== */

function createHook(
  topic,
  style
) {

  const hooks = [

    `Bạn có biết điều này về ${topic} không?`,

    `Có một sự thật về ${topic} mà rất nhiều người chưa biết.`,

    `Nếu bạn quan tâm đến ${topic}, hãy xem đến cuối.`,

    `Đây có thể là điều bạn đang hiểu sai về ${topic}.`,

    `Chỉ vài giây thôi, bạn sẽ hiểu rõ hơn về ${topic}.`

  ];

  const currentStyle =
    String(style || "")
      .toLowerCase();

  if (
    currentStyle ===
    "storytelling"
  ) {

    return (
      `Mọi chuyện bắt đầu từ một điều rất bất ngờ về ${topic}.`
    );

  }

  if (
    currentStyle ===
    "emotional"
  ) {

    return (
      `Có những điều rất nhỏ về ${topic}, nhưng lại khiến chúng ta suy nghĩ rất nhiều.`
    );

  }

  return hooks[
    Math.floor(
      Math.random() *
      hooks.length
    )
  ];

}


/* =====================================================
   TẠO 1 KỊCH BẢN
===================================================== */

function createScript({

  topic,

  duration = 30,

  style = "viral",

  audience =
    "người xem Facebook",

  index = 1

}) {

  const cleanTopic =
    limitText(
      topic,
      500
    );

  const cleanAudience =
    limitText(
      audience,
      200
    );

  const seconds =
    getDurationSeconds(
      duration
    );

  const styleText =
    getStyleText(
      style
    );

  const hook =
    createHook(
      cleanTopic,
      style
    );

  const ending =
    "Nếu thấy thông tin này hữu ích, hãy chia sẻ và theo dõi để xem thêm những nội dung thú vị.";

  const bodyTemplates = [

    `Hãy cùng tìm hiểu ${cleanTopic}. Điều đầu tiên cần biết là đây là một chủ đề rất đáng chú ý. Nhiều người thường bỏ qua những chi tiết nhỏ, nhưng chính chúng lại tạo nên sự khác biệt.`,

    `Điểm đáng chú ý nhất là ${cleanTopic}. Khi hiểu đúng vấn đề, chúng ta sẽ dễ dàng nhận ra những điều trước đây có thể đã bị bỏ qua.`,

    `Một cách đơn giản để hiểu ${cleanTopic} là nhìn vào những điều thực tế và dễ áp dụng trong cuộc sống. Hãy nhớ những điểm quan trọng này để có góc nhìn rõ ràng hơn.`

  ];

  const body =
    bodyTemplates[
      (index - 1) %
      bodyTemplates.length
    ];

  const script = [

    hook,

    body,

    `Nội dung này được trình bày theo phong cách ${styleText}, dành cho ${cleanAudience}.`,

    ending

  ].join(" ");

  return {

    index,

    title:
      `${cleanTopic} - Video ${index}`,

    topic:
      cleanTopic,

    duration:
      seconds,

    style:
      String(style || "viral"),

    audience:
      cleanAudience,

    hook,

    body,

    ending,

    script:
      limitText(
        script,
        5000
      )

  };

}


/* =====================================================
   TẠO NHIỀU KỊCH BẢN
===================================================== */

function createScripts({

  topic,

  count = 3,

  duration = 30,

  style = "viral",

  audience =
    "người xem Facebook"

}) {

  const safeCount =
    Math.min(
      Math.max(
        Number(count) || 1,
        1
      ),
      20
    );

  const scripts = [];

  for (
    let i = 1;
    i <= safeCount;
    i++
  ) {

    scripts.push(
      createScript({

        topic,

        duration,

        style,

        audience,

        index: i

      })
    );

  }

  return scripts;

}


/* =====================================================
   HEALTH
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
   API TẠO KỊCH BẢN
===================================================== */

app.post(
  "/api/scripts",
  async (req, res) => {

    try {

      const {

        topic,

        count = 3,

        duration = 30,

        style = "viral",

        audience =
          "người xem Facebook"

      } = req.body || {};


      if (
        !topic ||
        !cleanText(topic)
      ) {

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


      return res.json({

        ok: true,

        count:
          scripts.length,

        scripts

      });

    } catch (error) {

      console.error(
        "SCRIPT API ERROR:",
        error
      );

      return res
        .status(500)
        .json({

          ok: false,

          error:
            "Không thể tạo kịch bản."

        });

    }

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
          "AI VIDEO FACTORY"
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


ststartServer();

