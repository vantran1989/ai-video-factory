import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);

const WORK_DIR = path.join(__dirname, "work");
const OUTPUT_DIR = path.join(__dirname, "outputs");

await fs.mkdir(WORK_DIR, { recursive: true });
await fs.mkdir(OUTPUT_DIR, { recursive: true });

const app = express();

app.use(express.json({ limit: "2mb" }));

/* =========================================================
   GIAO DIỆN
   ========================================================= */

const HTML = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Facebook Video Tool</title>

<style>
*{
  box-sizing:border-box
}

body{
  margin:0;
  background:#10172d;
  color:#fff;
  font-family:Arial,sans-serif;
}

main{
  max-width:680px;
  margin:auto;
  padding:22px 16px 50px;
}

.logo{
  font-size:28px;
  font-weight:900;
  text-align:center;
  margin:8px 0;
}

.sub{
  text-align:center;
  color:#b9c2df;
  margin-bottom:22px;
}

label{
  display:block;
  font-weight:700;
  margin:14px 0 7px;
}

input,
select,
button{
  width:100%;
  border:0;
  border-radius:14px;
  padding:15px;
  font-size:17px;
}

input,
select{
  background:#fff;
  color:#111;
}

button{
  margin-top:20px;
  background:#19b85a;
  color:#fff;
  font-weight:900;
  font-size:19px;
}

button:disabled{
  opacity:.55;
}

.card{
  background:#18213e;
  border:1px solid #334066;
  border-radius:20px;
  padding:18px;
  margin-top:18px;
}

.progress{
  line-height:1.8;
  color:#dce4ff;
}

.ok{
  color:#49e58b;
}

.err{
  color:#ff8c8c;
}

.video{
  margin-top:18px;
}

.video a{
  display:block;
  background:#19b85a;
  color:#fff;
  text-decoration:none;
  text-align:center;
  font-weight:900;
  padding:15px;
  border-radius:14px;
}

.note{
  font-size:13px;
  color:#aeb8d7;
  margin-top:12px;
  line-height:1.5;
}
</style>
</head>

<body>

<main>

<div class="logo">🎬 FACEBOOK VIDEO TOOL</div>

<div class="sub">
Chỉ nhập chủ đề — tool tự làm video
</div>

<div class="card">

<label>Chủ đề</label>

<input
  id="topic"
  placeholder="Ví dụ: Cá mập, động vật, bí ẩn Ai Cập..."
>

<label>Số video</label>

<select id="count">
  <option value="1">1 video</option>
  <option value="2">2 video</option>
  <option value="3">3 video</option>
</select>

<label>Thời lượng</label>

<select id="duration">
  <option value="15">15 giây</option>
  <option value="30" selected>30 giây</option>
  <option value="45">45 giây</option>
  <option value="60">60 giây</option>
</select>

<label>Phong cách</label>

<select id="style">
  <option value="viral">Viral / cuốn hút</option>
  <option value="kiến thức">Kiến thức</option>
  <option value="kể chuyện">Kể chuyện</option>
</select>

<button id="go" onclick="generate()">
🚀 TẠO VIDEO
</button>

<div class="note">
Tool tự chia cảnh, tự tìm ảnh minh họa, tạo giọng đọc,
thêm phụ đề/chuyển động và xuất MP4 dọc 9:16.
</div>

</div>

<div id="result"></div>

</main>

<script>

async function generate(){

  const topic =
    document.getElementById("topic").value.trim();

  if(!topic){
    alert("Hãy nhập chủ đề trước nhé.");
    return;
  }

  const btn =
    document.getElementById("go");

  const box =
    document.getElementById("result");

  const count =
    Number(document.getElementById("count").value);

  const duration =
    Number(document.getElementById("duration").value);

  const style =
    document.getElementById("style").value;

  btn.disabled = true;
  btn.textContent = "⏳ ĐANG TẠO VIDEO...";

  box.innerHTML =
    '<div class="card progress">' +
    '⏳ Đang viết nội dung...<br>' +
    '🖼️ Đang tìm nhiều cảnh...<br>' +
    '🔊 Đang tạo giọng đọc...<br>' +
    '🎬 Đang ghép video...<br><br>' +
    'Vui lòng giữ nguyên trang cho đến khi xong.' +
    '</div>';

  try{

    const response = await fetch(
      "/api/generate",
      {
        method:"POST",
        headers:{
          "Content-Type":"application/json"
        },
        body:JSON.stringify({
          topic,
          count,
          duration,
          style
        })
      }
    );

    const data = await response.json();

    if(!response.ok || !data.ok){
      throw new Error(
        data.error || "Không tạo được video."
      );
    }

    box.innerHTML =
      '<div class="card">' +
      '<b class="ok">✅ ' +
      data.message +
      '</b>' +
      '</div>';

    for(const v of data.videos || []){

      if(v.ok){

        const d = v.result || {};

        box.innerHTML +=
          '<div class="card video">' +

          '<b>🎥 ' +
          escapeHtml(v.title) +
          '</b>' +

          '<p class="ok">' +
          'Hình: ' +
          (d.width || 576) +
          '×' +
          (d.height || 1024) +
          '<br>' +

          'Âm thanh: ' +
          (d.audio || "OK") +
          '<br>' +

          'Thời lượng: ' +
          Number(d.duration || 0).toFixed(1) +
          ' giây' +

          '</p>' +

          '<a href="' +
          v.file +
          '" download>' +
          '⬇️ TẢI MP4' +
          '</a>' +

          '</div>';

      }else{

        box.innerHTML +=
          '<div class="card">' +
          '<b class="err">❌ Video lỗi:</b>' +
          '<div class="err">' +
          escapeHtml(
            v.error ||
            "Lỗi không xác định"
          ) +
          '</div>' +
          '</div>';
      }
    }

  }catch(error){

    box.innerHTML =
      '<div class="card">' +
      '<b class="err">❌ ' +
      escapeHtml(error.message) +
      '</b>' +
      '<div class="note">' +
      'Nếu Render vừa khởi động lại, ' +
      'chờ khoảng 1 phút rồi thử lại.' +
      '</div>' +
      '</div>';

  }finally{

    btn.disabled = false;
    btn.textContent = "🚀 TẠO VIDEO";

  }
}

function escapeHtml(text){

  return String(text)
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;")
    .replace(/'/g,"&#039;");

}

</script>

</body>
</html>`;


/* =========================================================
   TRANG CHỦ
   ========================================================= */

app.get("/", (_req, res) => {
  res.type("html").send(HTML);
});


/* =========================================================
   CHẠY LỆNH
   ========================================================= */

function run(command, args, timeout = 120000){

  return new Promise((resolve,reject)=>{

    const child = spawn(
      command,
      args,
      {
        stdio:["ignore","pipe","pipe"]
      }
    );

    let stdout = "";
    let stderr = "";
    let done = false;

    const timer = setTimeout(()=>{

      if(done) return;

      done = true;

      try{
        child.kill("SIGKILL");
      }catch{}

      reject(
        new Error(
          `Timeout khi chạy ${command}`
        )
      );

    },timeout);

    child.stdout.on(
      "data",
      data=>{
        stdout += data.toString();
      }
    );

    child.stderr.on(
      "data",
      data=>{
        stderr += data.toString();
      }
    );

    child.on(
      "error",
      error=>{

        if(done) return;

        done = true;

        clearTimeout(timer);

        reject(error);

      }
    );

    child.on(
      "close",
      code=>{

        if(done) return;

        done = true;

        clearTimeout(timer);

        if(code === 0){

          resolve({
            stdout,
            stderr
          });

        }else{

          reject(
            new Error(
              `${command} lỗi ${code}: ${stderr.slice(-5000)}`
            )
          );

        }

      }
    );

  });

}


/* =========================================================
   XỬ LÝ CHỦ ĐỀ
   ========================================================= */

const STOPWORDS = new Set([
  "và",
  "là",
  "của",
  "cho",
  "với",
  "một",
  "những",
  "các",
  "trong",
  "khi",
  "được",
  "này",
  "đó",
  "từ",
  "đến",
  "về",
  "có",
  "hay",
  "như",
  "the",
  "and"
]);


function cleanTopic(topic){

  return String(topic || "")
    .replace(/[\r\n]+/g," ")
    .trim()
    .slice(0,100);

}


function topicWords(topic){

  return topic
    .split(/\s+/)
    .filter(
      word =>
        word &&
        !STOPWORDS.has(
          word.toLowerCase()
        )
    )
    .slice(0,5);

}


/* =========================================================
   TẠO NỘI DUNG CÁC CẢNH
   ========================================================= */

function makeScenes(topic,style){

  const t = topic;

  const words = topicWords(topic);

  const core =
    words.join(" ") || t;

  let tone =
    "Điều khiến nhiều người bất ngờ là";

  if(style === "kiến thức"){
    tone = "Theo góc nhìn kiến thức";
  }

  if(style === "kể chuyện"){
    tone = "Hãy thử tưởng tượng";
  }

  return [

    {
      title:t,
      text:
        `Bạn có biết ${t} có những điều rất thú vị mà không phải ai cũng biết?`,
      q:
        `${core} photo`
    },

    {
      title:"Điều bất ngờ",
      text:
        `${tone}, ${t} có một đặc điểm khiến chúng ta phải nhìn nó theo một cách hoàn toàn khác.`,
      q:
        `${core} nature`
    },

    {
      title:"Điểm đặc biệt",
      text:
        `Điểm đáng chú ý nhất là cách ${t} thích nghi và tồn tại trong môi trường của mình.`,
      q:
        `${core} close up`
    },

    {
      title:"Một sự thật thú vị",
      text:
        `Một sự thật thú vị: những chi tiết nhỏ về ${t} thường lại là phần đáng nhớ nhất.`,
      q:
        `${core} detail`
    },

    {
      title:"Bạn nghĩ sao?",
      text:
        `Nếu phải chọn một điều ấn tượng nhất về ${t}, bạn sẽ chọn điều gì? Hãy để lại bình luận nhé!`,
      q:
        `${core} landscape`
    },

    {
      title:"Kết",
      text:
        `Lưu video này và chia sẻ cho người cũng thích ${t}. Hẹn gặp lại ở video tiếp theo!`,
      q:
        `${core} beautiful`
    }

  ];

}


/* =========================================================
   ESCAPE CHỮ CHO FFMPEG
   ========================================================= */

function escapeText(text){

  return String(text)
    .replace(/\\/g,"\\\\")
    .replace(/:/g,"\\:")
    .replace(/'/g,"\\'")
    .replace(/,/g,"\\,");

}


/* =========================================================
   GỌI API
   ========================================================= */

async function fetchJson(url){

  const controller =
    new AbortController();

  const timer =
    setTimeout(
      ()=>controller.abort(),
      12000
    );

  try{

    const response =
      await fetch(
        url,
        {
          signal:controller.signal,
          headers:{
            "User-Agent":
              "FacebookVideoTool/Final"
          }
        }
      );

    if(!response.ok){

      throw new Error(
        `HTTP ${response.status}`
      );

    }

    return await response.json();

  }finally{

    clearTimeout(timer);

  }

}


/* =========================================================
   TÌM ẢNH WIKIMEDIA
   ========================================================= */

async function findWikimediaImage(query){

  const params =
    new URLSearchParams({

      action:"query",

      generator:"search",

      gsrsearch:query,

      gsrnamespace:"6",

      gsrlimit:"8",

      prop:"imageinfo",

      iiprop:"url|mime",

      iiurlwidth:"900",

      format:"json",

      origin:"*"

    });

  try{

    const data =
      await fetchJson(
        `https://commons.wikimedia.org/w/api.php?${params}`
      );

    const pages =
      Object.values(
        data?.query?.pages || {}
      );

    const good =
      pages.find(page=>{

        const info =
          page.imageinfo?.[0];

        return (
          info?.thumburl &&
          /^image\/(jpeg|png|webp)$/i.test(
            info.mime || ""
          )
        );

      });

    return (
      good?.imageinfo?.[0]?.thumburl ||
      null
    );

  }catch(error){

    console.log(
      "IMAGE SEARCH FALLBACK:",
      error.message
    );

    return null;

  }

}


/* =========================================================
   TẢI ẢNH
   ========================================================= */

async function downloadImage(url,out){

  if(!url) return false;

  const controller =
    new AbortController();

  const timer =
    setTimeout(
      ()=>controller.abort(),
      12000
    );

  try{

    const response =
      await fetch(
        url,
        {
          signal:controller.signal,
          headers:{
            "User-Agent":
              "FacebookVideoTool/Final"
          }
        }
      );

    if(!response.ok){
      return false;
    }

    const type =
      response.headers.get(
        "content-type"
      ) || "";

    if(!type.startsWith("image/")){
      return false;
    }

    const buffer =
      Buffer.from(
        await response.arrayBuffer()
      );

    if(
      buffer.length < 5000 ||
      buffer.length > 8 * 1024 * 1024
    ){
      return false;
    }

    await fs.writeFile(
      out,
      buffer
    );

    return true;

  }catch(error){

    console.log(
      "IMAGE DOWNLOAD FALLBACK:",
      error.message
    );

    return false;

  }finally{

    clearTimeout(timer);

  }

}


/* =========================================================
   ẢNH DỰ PHÒNG
   ========================================================= */

async function makeFallbackImage(text,out){

  const safe =
    escapeText(
      text.slice(0,70)
    );

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

      "-vf",

      `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:fontcolor=white:fontsize=46:x=(w-text_w)/2:y=(h-text_h)/2:text='${safe}'`,

      "-frames:v",
      "1",

      out
    ],
    30000
  );

}


/* =========================================================
   CHUẨN HÓA ẢNH 576x1024
   ========================================================= */

async function prepareImage(source,out){

  await run(
    "ffmpeg",
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",

      "-i",
      source,

      "-vf",
      "scale=576:1024:force_original_aspect_ratio=increase,crop=576:1024",

      "-frames:v",
      "1",

      out
    ],
    30000
  );

}


/* =========================================================
   TẠO GIỌNG ĐỌC OFFLINE
   ========================================================= */

async function makeVoice(text,out){

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
      out,

      text
    ],
    30000
  );

}


/* =========================================================
   TẠO VIDEO TỪNG CẢNH
   ========================================================= */

async function makeScene(
  image,
  audio,
  scene,
  seconds,
  out,
  index
){

  const caption =
    escapeText(
      scene.text.slice(0,150)
    );

  const title =
    escapeText(
      scene.title.slice(0,45)
    );

  const frames =
    Math.max(
      1,
      Math.round(seconds * 30)
    );

  const zoom =
    index % 2 === 0

      ? `zoompan=z='min(zoom+0.0012,1.12)':d=${frames}:s=576x1024:fps=30`

      : `zoompan=z='if(lte(zoom,1.0),1.12,max(zoom-0.0012,1.0))':d=${frames}:s=576x1024:fps=30`;

  const vf = [

    "scale=576:1024:force_original_aspect_ratio=increase",

    "crop=576:1024",

    zoom,

    "drawbox=x=0:y=0:w=iw:h=180:color=black@0.32:t=fill",

    "drawbox=x=0:y=ih-300:w=iw:h=300:color=black@0.48:t=fill",

    `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:fontcolor=white:fontsize=42:x=(w-text_w)/2:y=60:text='${title}'`,

    `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:fontcolor=white:fontsize=27:line_spacing=8:x=34:y=h-260:text='${caption}'`

  ].join(",");

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
      vf,

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

      out

    ],
    Math.max(
      60000,
      seconds * 15000
    )
  );

}


/* =========================================================
   GHÉP CÁC CẢNH
   ========================================================= */

async function concatScenes(
  sceneFiles,
  output
){

  const list =
    path.join(
      path.dirname(output),
      "concat.txt"
    );

  await fs.writeFile(
    list,
    sceneFiles
      .map(
        file =>
          `file '${file.replace(
            /'/g,
            "'\\''"
          )}'`
      )
      .join("\n")
  );

  try{

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

  }finally{

    await fs.rm(
      list,
      {
        force:true
      }
    );

  }

}


/* =========================================================
   KIỂM TRA VIDEO
   ========================================================= */

async function validate(output){

  const result =
    await run(
      "ffprobe",
      [
        "-v",
        "error",

        "-show_streams",

        "-show_format",

        "-of",
        "json",

        output
      ],
      30000
    );

  const data =
    JSON.parse(
      result.stdout
    );

  const video =
    data.streams?.find(
      stream =>
        stream.codec_type === "video"
    );

  const audio =
    data.streams?.find(
      stream =>
        stream.codec_type === "audio"
    );

  return {

    ok:
      Boolean(video && audio),

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
        data.format?.duration || 0
      ),

    video:
      video?.codec_name || null,

    audio:
      audio?.codec_name || null

  };

}


/* =========================================================
   HEALTH CHECK
   ========================================================= */

app.get(
  "/api/health",
  (_req,res)=>{
    res.json({
      ok:true,
      service:"Facebook Video Tool Final"
    });
  }
);


/* =========================================================
   TẠO VIDEO
   ========================================================= */

app.post(
  "/api/generate",
  async(req,res)=>{

    const topic =
      cleanTopic(
        req.body?.topic
      );

    if(!topic){

      return res
        .status(400)
        .json({
          ok:false,
          error:"Hãy nhập chủ đề."
        });

    }

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
        15,
        Math.min(
          Number(
            req.body?.duration || 30
          ),
          60
        )
      );

    const style =
      String(
        req.body?.style ||
        "viral"
      );

    const sceneCount =
      duration <= 20
        ? 4
        : duration <= 35
          ? 5
          : 6;

    const seconds =
      duration / sceneCount;

    const videos = [];


    for(
      let n = 1;
      n <= count;
      n++
    ){

      const id =
        crypto.randomUUID();

      const dir =
        path.join(
          WORK_DIR,
          id
        );

      const output =
        path.join(
          OUTPUT_DIR,
          `${id}.mp4`
        );

      await fs.mkdir(
        dir,
        {
          recursive:true
        }
      );

      const scenes =
        makeScenes(
          topic,
          style
        ).slice(
          0,
          sceneCount
        );

      const sceneFiles = [];


      try{

        console.log(
          `VIDEO ${n}/${count}: ${topic}`
        );


        for(
          let i = 0;
          i < scenes.length;
          i++
        ){

          const scene =
            scenes[i];

          console.log(
            `SCENE ${i + 1}/${scenes.length}: ${scene.title}`
          );

          const source =
            path.join(
              dir,
              `source-${i}.img`
            );

          const image =
            path.join(
              dir,
              `image-${i}.jpg`
            );

          const audio =
            path.join(
              dir,
              `audio-${i}.wav`
            );

          const sceneOut =
            path.join(
              dir,
              `scene-${i}.mp4`
            );


          const imageUrl =
            await findWikimediaImage(
              scene.q
            );


          let got =
            await downloadImage(
              imageUrl,
              source
            );


          if(!got){

            await makeFallbackImage(
              scene.title,
              source
            );

          }


          await prepareImage(
            source,
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
            seconds,
            sceneOut,
            i
          );


          sceneFiles.push(
            sceneOut
          );

        }


        console.log(
          "CONCAT START"
        );


        await concatScenes(
          sceneFiles,
          output
        );


        console.log(
          "VALIDATE START"
        );


        const result =
          await validate(
            output
          );


        if(!result.ok){

          throw new Error(
            "MP4 không có đủ hình và âm thanh."
          );

        }


        console.log(
          "VIDEO SUCCESS",
          result
        );


        const fileUrl =
          `/api/download/${id}`;


        videos.push({

          index:n,

          ok:true,

          title:topic,

          file:fileUrl,

          url:fileUrl,

          result

        });


      }catch(error){

        console.error(
          "VIDEO ERROR:",
          error
        );


        await fs.rm(
          output,
          {
            force:true
          }
        );


        videos.push({

          index:n,

          ok:false,

          title:topic,

          error:
            error?.message ||
            "Lỗi không xác định."

        });


      }finally{

        await fs.rm(
          dir,
          {
            recursive:true,
            force:true
          }
        );

      }

    }


    const success =
      videos.filter(
        video => video.ok
      ).length;


    const firstSuccessful =
      videos.find(
        video => video.ok
      );


    /*
      QUAN TRỌNG:
      file/url được trả ra ở cấp ngoài
      để giao diện cũ không còn /undefined.
    */

    res.json({

      ok:
        success > 0,

      total:
        videos.length,

      success,

      message:
        success
          ? `Đã tạo ${success}/${videos.length} video.`
          : "Không tạo được video.",

      file:
        firstSuccessful?.file ||
        null,

      url:
        firstSuccessful?.url ||
        null,

      videos

    });

  }
);


/* =========================================================
   DOWNLOAD MP4
   ========================================================= */

app.get(
  "/api/download/:id",
  async(req,res)=>{

    const id =
      req.params.id;


    if(
      !/^[a-f0-9-]{36}$/i.test(id)
    ){

      return res
        .status(400)
        .send(
          "ID không hợp lệ"
        );

    }


    const file =
      path.join(
        OUTPUT_DIR,
        `${id}.mp4`
      );


    try{

      await fs.access(
        file
      );


      res.download(
        file,
        `facebook-video-${id}.mp4`
      );


    }catch{

      res
        .status(404)
        .send(
          "Video không tồn tại hoặc Render đã khởi động lại."
        );

    }

  }
);


/* =========================================================
   404
   ========================================================= */

app.use(
  (_req,res)=>{
    res
      .status(404)
      .json({
        ok:false,
        error:
          "Không tìm thấy đường dẫn."
      });
  }
);


/* =========================================================
   START SERVER
   ========================================================= */

const server =
  app.listen(
    PORT,
    "0.0.0.0",
    ()=>{
      console.log(
        "========================================"
      );

      console.log(
        " FACEBOOK VIDEO TOOL FINAL"
      );

      console.log(
        " Chủ đề bất kỳ + nhiều video"
      );

      console.log(
        " Ảnh + giọng đọc + phụ đề + chuyển động"
      );

      console.log(
        " MP4 dọc 9:16"
      );

      console.log(
        " TTS: eSpeak NG OFFLINE"
      );

      console.log(
        "========================================"
      );
    }
  );


server.requestTimeout = 0;
server.timeout = 0;
