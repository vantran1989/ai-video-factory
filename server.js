import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const WORK = path.join(__dirname, "work");
const OUTPUT = path.join(__dirname, "outputs");

await fs.mkdir(WORK, { recursive: true });
await fs.mkdir(OUTPUT, { recursive: true });

const app = express();

app.use(express.json({ limit: "1mb" }));

const HTML = [
"<!doctype html>",
"<html lang='vi'>",
"<head>",
"<meta charset='utf-8'>",
"<meta name='viewport' content='width=device-width,initial-scale=1'>",
"<title>Facebook Video Tool</title>",
"<style>",
"*{box-sizing:border-box}",
"body{margin:0;background:#10172d;color:white;font-family:Arial,sans-serif}",
"main{max-width:680px;margin:auto;padding:20px 15px 50px}",
"h1{text-align:center;font-size:28px;margin:10px 0}",
".sub{text-align:center;color:#b9c2df;margin-bottom:20px}",
".box{background:#192341;border-radius:18px;padding:18px;margin-bottom:18px}",
"label{display:block;font-weight:bold;margin:13px 0 7px}",
"input,select,button{width:100%;padding:15px;border:0;border-radius:13px;font-size:17px}",
"input,select{background:white;color:#111}",
"button{margin-top:20px;background:#19b85a;color:white;font-weight:bold;font-size:19px}",
"button:disabled{opacity:.5}",
".progress{line-height:1.9}",
".ok{color:#4ee58b}",
".err{color:#ff8d8d}",
"a{display:block;text-align:center;text-decoration:none;background:#19b85a;color:white;padding:15px;border-radius:13px;font-weight:bold;margin-top:12px}",
".small{font-size:13px;color:#aeb8d7;line-height:1.5;margin-top:12px}",
"</style>",
"</head>",
"<body>",
"<main>",
"<h1>🎬 FACEBOOK VIDEO TOOL</h1>",
"<div class='sub'>Nhập bất kỳ chủ đề nào → tự tạo video</div>",
"<div class='box'>",
"<label>Chủ đề</label>",
"<input id='topic' placeholder='Ví dụ: Cá mập, khủng long, Ai Cập...'>",
"<label>Số video</label>",
"<select id='count'><option value='1'>1 video</option><option value='2'>2 video</option><option value='3'>3 video</option></select>",
"<label>Thời lượng</label>",
"<select id='duration'><option value='15'>15 giây</option><option value='30' selected>30 giây</option><option value='45'>45 giây</option><option value='60'>60 giây</option></select>",
"<label>Phong cách</label>",
"<select id='style'><option value='viral'>Viral / cuốn hút</option><option value='knowledge'>Kiến thức</option><option value='story'>Kể chuyện</option></select>",
"<button id='btn' onclick='makeVideo()'>🚀 TẠO VIDEO</button>",
"<div class='small'>Video dọc 9:16, nhiều cảnh, ảnh minh họa, chuyển động, giọng đọc và phụ đề.</div>",
"</div>",
"<div id='result'></div>",
"</main>",
"<script>",
"async function makeVideo(){",
"var topic=document.getElementById('topic').value.trim();",
"var btn=document.getElementById('btn');",
"var result=document.getElementById('result');",
"if(!topic){alert('Hãy nhập chủ đề.');return;}",
"btn.disabled=true;",
"btn.textContent='⏳ ĐANG TẠO...';",
"result.innerHTML='<div class=\"box progress\">⏳ Đang chuẩn bị nội dung...<br>🖼️ Đang tìm ảnh cho từng cảnh...<br>🔊 Đang tạo giọng đọc...<br>🎬 Đang dựng video...<br>⌛ Vui lòng chờ...</div>';",
"try{",
"var response=await fetch('/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({topic:topic,count:Number(document.getElementById('count').value),duration:Number(document.getElementById('duration').value),style:document.getElementById('style').value})});",
"var data=await response.json();",
"if(!response.ok || !data.ok) throw new Error(data.error || 'Không tạo được video');",
"result.innerHTML='<div class=\"box ok\">✅ Đã tạo '+data.success+'/'+data.total+' video.</div>';",
"for(var i=0;i<data.videos.length;i++){",
"var v=data.videos[i];",
"if(v.ok){",
"var r=v.result;",
"result.innerHTML=result.innerHTML+'<div class=\"box\"><b>🎥 Video '+v.index+'</b><br><br>📐 '+r.width+' × '+r.height+'<br>🔊 '+r.audio+'<br>⏱️ '+r.duration.toFixed(1)+' giây<a href=\"'+v.file+'\">⬇️ TẢI MP4</a></div>';",
"}else{",
"result.innerHTML=result.innerHTML+'<div class=\"box err\">❌ Video '+v.index+': '+v.error+'</div>';",
"}",
"}",
"}catch(error){",
"result.innerHTML='<div class=\"box err\">❌ '+error.message+'</div>';",
"}",
"btn.disabled=false;",
"btn.textContent='🚀 TẠO VIDEO';",
"}",
"</script>",
"</body>",
"</html>"
].join("\n");

app.get("/", function(req, res) {
  res.type("html").send(HTML);
});

function run(command, args, timeout) {
  return new Promise(function(resolve, reject) {
    var child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    var stdout = "";
    var stderr = "";
    var finished = false;

    var timer = setTimeout(function() {
      if (finished) return;
      finished = true;
      try {
        child.kill("SIGKILL");
      } catch (e) {}
      reject(new Error("Timeout khi chạy " + command));
    }, timeout || 120000);

    child.stdout.on("data", function(data) {
      stdout += data.toString();
    });

    child.stderr.on("data", function(data) {
      stderr += data.toString();
    });

    child.on("error", function(error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", function(code) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      if (code === 0) {
        resolve({
          stdout: stdout,
          stderr: stderr
        });
      } else {
        reject(
          new Error(
            command +
            " lỗi " +
            code +
            ": " +
            stderr.slice(-2500)
          )
        );
      }
    });
  });
}

function cleanTopic(value) {
  return String(value || "")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 100);
}

function makeScenes(topic, style) {
  var styleText = "Điều thú vị là";

  if (style === "knowledge") {
    styleText = "Một điều đáng chú ý là";
  }

  if (style === "story") {
    styleText = "Hãy thử tưởng tượng";
  }

  return [
    {
      title: topic,
      text: "Bạn có biết " + topic + " có những điều rất thú vị mà không phải ai cũng biết?",
      query: topic + " photo"
    },
    {
      title: "Điều bất ngờ",
      text: styleText + " " + topic + " có những đặc điểm khiến chúng ta rất tò mò.",
      query: topic + " nature"
    },
    {
      title: "Điểm đặc biệt",
      text: "Điểm đáng chú ý về " + topic + " nằm ở những chi tiết nhỏ nhưng rất đặc biệt.",
      query: topic + " close up"
    },
    {
      title: "Sự thật thú vị",
      text: "Một điều thú vị khác về " + topic + " là có rất nhiều điều chúng ta thường không để ý.",
      query: topic + " detail"
    },
    {
      title: "Bạn nghĩ sao?",
      text: "Nếu bạn thích " + topic + ", hãy bình luận điều bạn thấy ấn tượng nhất.",
      query: topic + " landscape"
    },
    {
      title: "Kết",
      text: "Lưu video này và chia sẻ cho người cũng quan tâm đến " + topic + ".",
      query: topic + " beautiful"
    }
  ];
}

async function getJson(url) {
  var controller = new AbortController();

  var timer = setTimeout(function() {
    controller.abort();
  }, 12000);

  try {
    var response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "FacebookVideoTool/12.0"
      }
    });

    if (!response.ok) {
      throw new Error("HTTP " + response.status);
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function findImage(query) {
  var params = new URLSearchParams();

  params.set("action", "query");
  params.set("generator", "search");
  params.set("gsrsearch", query);
  params.set("gsrnamespace", "6");
  params.set("gsrlimit", "10");
  params.set("prop", "imageinfo");
  params.set("iiprop", "url|mime");
  params.set("iiurlwidth", "900");
  params.set("format", "json");
  params.set("origin", "*");

  try {
    var data = await getJson(
      "https://commons.wikimedia.org/w/api.php?" +
      params.toString()
    );

    var pages = Object.values(
      data.query && data.query.pages
        ? data.query.pages
        : {}
    );

    for (var i = 0; i < pages.length; i++) {
      var info =
        pages[i].imageinfo &&
        pages[i].imageinfo[0];

      if (
        info &&
        info.thumburl &&
        /^image\/(jpeg|png|webp)$/i.test(
          info.mime || ""
        )
      ) {
        return info.thumburl;
      }
    }
  } catch (error) {
    console.log("IMAGE SEARCH:", error.message);
  }

  return null;
}

async function downloadImage(url, file) {
  if (!url) return false;

  var controller = new AbortController();

  var timer = setTimeout(function() {
    controller.abort();
  }, 12000);

  try {
    var response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "FacebookVideoTool/12.0"
      }
    });

    if (!response.ok) return false;

    var type =
      response.headers.get("content-type") || "";

    if (type.indexOf("image/") !== 0) {
      return false;
    }

    var buffer =
      Buffer.from(await response.arrayBuffer());

    if (
      buffer.length < 5000 ||
      buffer.length > 8 * 1024 * 1024
    ) {
      return false;
    }

    await fs.writeFile(file, buffer);

    return true;
  } catch (error) {
    console.log("IMAGE DOWNLOAD:", error.message);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function fallbackImage(text, file) {
  await run(
    "ffmpeg",
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
      file
    ],
    30000
  );
}

async function prepareImage(input, output) {
  await run(
    "ffmpeg",
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
      output
    ],
    30000
  );
}

async function makeVoice(text, output) {
  await run(
    "espeak-ng",
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
    30000
  );
}

async function makeScene(
  image,
  audio,
  scene,
  seconds,
  output,
  index,
  directory
) {
  var titleFile =
    path.join(
      directory,
      "title-" + index + ".txt"
    );

  var captionFile =
    path.join(
      directory,
      "caption-" + index + ".txt"
    );

  await fs.writeFile(
    titleFile,
    scene.title,
    "utf8"
  );

  await fs.writeFile(
    captionFile,
    scene.text,
    "utf8"
  );

  var frames =
    Math.max(
      1,
      Math.round(seconds * 30)
    );

  var zoom;

  if (index % 2 === 0) {
    zoom =
      "zoompan=z='min(zoom+0.0012,1.12)':d=" +
      frames +
      ":s=576x1024:fps=30";
  } else {
    zoom =
      "zoompan=z='if(lte(zoom,1.0),1.12,max(zoom-0.0012,1.0))':d=" +
      frames +
      ":s=576x1024:fps=30";
  }

  var filter =
    "scale=576:1024:force_original_aspect_ratio=increase," +
    "crop=576:1024," +
    zoom +
    "," +
    "drawbox=x=0:y=0:w=iw:h=170:color=black@0.35:t=fill," +
    "drawbox=x=0:y=ih-290:w=iw:h=290:color=black@0.50:t=fill," +
    "drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:" +
    "fontcolor=white:fontsize=40:x=(w-text_w)/2:y=55:" +
    "textfile=" + titleFile + "," +
    "drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:" +
    "fontcolor=white:fontsize=25:line_spacing=7:" +
    "x=28:y=h-245:textfile=" + captionFile;

  await run(
    "ffmpeg",
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-loop",
      "1",
      "-i",
      image,
      "-i",
      audio,
      "-t",
      String(seconds),
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-vf",
      filter,
      "-r",
      "30",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "30",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      "-ar",
      "44100",
      "-ac",
      "1",
      "-af",
      "apad",
      "-movflags",
      "+faststart",
      output
    ],
    Math.max(60000, seconds * 15000)
  );
}

async function concatScenes(files, output) {
  var list =
    path.join(
      path.dirname(output),
      "list.txt"
    );

  var content = "";

  for (var i = 0; i < files.length; i++) {
    content +=
      "file '" +
      files[i].replace(/'/g, "'\\''") +
      "'\n";
  }

  await fs.writeFile(
    list,
    content,
    "utf8"
  );

  try {
    await run(
      "ffmpeg",
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        list,
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        output
      ],
      120000
    );
  } finally {
    await fs.rm(list, { force: true });
  }
}

async function validate(file) {
  var result = await run(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      file
    ],
    30000
  );

  var data = JSON.parse(result.stdout);

  var video = data.streams
    ? data.streams.find(function(stream) {
        return stream.codec_type === "video";
      })
    : null;

  var audio = data.streams
    ? data.streams.find(function(stream) {
        return stream.codec_type === "audio";
      })
    : null;

  if (!video || !audio) {
    throw new Error(
      "MP4 không có đủ hình và âm thanh."
    );
  }

  return {
    width: Number(video.width || 0),
    height: Number(video.height || 0),
    duration: Number(
      data.format && data.format.duration
        ? data.format.duration
        : 0
    ),
    video: video.codec_name || "unknown",
    audio: audio.codec_name || "unknown"
  };
}

app.get("/api/health", function(req, res) {
  res.json({
    ok: true,
    service: "Facebook Video Tool 12.0"
  });
});

app.post("/api/generate", async function(req, res) {
  var topic = cleanTopic(
    req.body && req.body.topic
  );

  if (!topic) {
    return res.status(400).json({
      ok: false,
      error: "Hãy nhập chủ đề."
    });
  }

  var count = Number(
    req.body && req.body.count
      ? req.body.count
      : 1
  );

  var duration = Number(
    req.body && req.body.duration
      ? req.body.duration
      : 30
  );

  var style =
    req.body && req.body.style
      ? String(req.body.style)
      : "viral";

  count = Math.max(
    1,
    Math.min(3, count)
  );

  duration = Math.max(
    15,
    Math.min(60, duration)
  );

  var sceneCount;

  if (duration <= 20) {
    sceneCount = 4;
  } else if (duration <= 35) {
    sceneCount = 5;
  } else {
    sceneCount = 6;
  }

  var sceneSeconds =
    duration / sceneCount;

  var videos = [];

  for (var n = 1; n <= count; n++) {
    var id = crypto.randomUUID();

    var directory =
      path.join(WORK, id);

    var output =
      path.join(
        OUTPUT,
        id + ".mp4"
      );

    await fs.mkdir(
      directory,
      { recursive: true }
    );

    try {
      console.log(
        "VIDEO " +
        n +
        "/" +
        count +
        " " +
        topic
      );

      var scenes =
        makeScenes(
          topic,
          style
        ).slice(0, sceneCount);

      var sceneFiles = [];

      for (
        var i = 0;
        i < scenes.length;
        i++
      ) {
        var scene = scenes[i];

        console.log(
          "SCENE " +
          (i + 1) +
          "/" +
          scenes.length
        );

        var downloaded =
          path.join(
            directory,
            "download-" +
            i +
            ".img"
          );

        var image =
          path.join(
            directory,
            "image-" +
            i +
            ".jpg"
          );

        var audio =
          path.join(
            directory,
            "audio-" +
            i +
            ".wav"
          );

        var sceneVideo =
          path.join(
            directory,
            "scene-" +
            i +
            ".mp4"
          );

        var imageUrl =
          await findImage(
            scene.query
          );

        var ok =
          await downloadImage(
            imageUrl,
            downloaded
          );

        if (!ok) {
          await fallbackImage(
            scene.title,
            downloaded
          );
        }

        await prepareImage(
          downloaded,
          image
        );

        await makeVoice(
          scene.text,
          audio
        );

        await makeScene(
          image,
          audio,
          scene,
          sceneSeconds,
          sceneVideo,
          i,
          directory
        );

        sceneFiles.push(
          sceneVideo
        );
      }

      await concatScenes(
        sceneFiles,
        output
      );

      var info =
        await validate(output);

      videos.push({
        index: n,
        ok: true,
        file:
          "/api/download/" +
          id,
        result: {
          width: info.width,
          height: info.height,
          duration: info.duration,
          audio: info.audio
        }
      });

      console.log(
        "VIDEO SUCCESS " + n
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
        index: n,
        ok: false,
        error: error.message
      });
    } finally {
      await fs.rm(
        directory,
        {
          recursive: true,
          force: true
        }
      );
    }
  }

  var success =
    videos.filter(function(video) {
      return video.ok;
    }).length;

  res.json({
    ok: success > 0,
    total: videos.length,
    success: success,
    videos: videos
  });
});

app.get(
  "/api/download/:id",
  async function(req, res) {
    var id = req.params.id;

    if (
      !/^[a-f0-9-]{36}$/i.test(id)
    ) {
      return res
        .status(400)
        .send("ID không hợp lệ");
    }

    var file =
      path.join(
        OUTPUT,
        id + ".mp4"
      );

    try {
      await fs.access(file);

      res.download(
        file,
        "facebook-video-" +
        id +
        ".mp4"
      );
    } catch (error) {
      res
        .status(404)
        .send(
          "Video không tồn tại."
        );
    }
  }
);

app.listen(
  PORT,
  "0.0.0.0",
  function() {
    console.log(
      "================================"
    );
    console.log(
      " FACEBOOK VIDEO TOOL 12.0"
    );
    console.log(
      " MULTI SCENE + IMAGE + VOICE"
    );
    console.log(
      "================================"
    );
  }
);
