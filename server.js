<!doctype html>
<html lang="vi">

<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">

<title>AI Video Factory</title>

<style>

*{
  box-sizing:border-box;
}

body{
  margin:0;
  background:#0b1020;
  color:#fff;
  font-family:Arial,sans-serif;
}

.wrap{
  max-width:680px;
  margin:auto;
  padding:18px;
}

.card{
  background:#151c31;
  border:1px solid #293552;
  border-radius:20px;
  padding:20px;
  margin:12px 0;
}

h1{
  margin:5px 0 8px;
  font-size:30px;
}

p{
  color:#aeb9d3;
  line-height:1.5;
}

label{
  display:block;
  margin:16px 0 7px;
  font-size:17px;
}

input,
select,
button{
  width:100%;
  box-sizing:border-box;
  border-radius:14px;
  padding:14px;
  border:1px solid #394765;
  background:#0e1528;
  color:#fff;
  font-size:16px;
}

input:focus,
select:focus{
  outline:none;
  border-color:#6975ff;
}

button{
  background:#5b67ff;
  border:0;
  font-weight:700;
  margin-top:18px;
  padding:16px;
  cursor:pointer;
  font-size:17px;
}

button:disabled{
  opacity:.5;
  cursor:not-allowed;
}

.grid{
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:12px;
}

.progress{
  height:14px;
  background:#27314a;
  border-radius:20px;
  overflow:hidden;
  margin-top:14px;
}

.bar{
  height:100%;
  width:0%;
  background:#6d7aff;
  transition:width .3s;
}

.item{
  padding:14px;
  border:1px solid #303c5b;
  border-radius:14px;
  margin:10px 0;
  line-height:1.6;
}

.item a{
  display:inline-block;
  margin-top:8px;
  padding:9px 12px;
  border-radius:9px;
  background:#5b67ff;
  color:#fff;
  text-decoration:none;
  font-weight:bold;
}

.status{
  font-size:16px;
  line-height:1.5;
}

.success{
  color:#7df0a5;
}

.error{
  color:#ff7272;
}

.small{
  font-size:13px;
  color:#8e9ab5;
  line-height:1.5;
  margin-top:14px;
}

.loading{
  display:none;
  margin-top:12px;
  color:#aeb9d3;
}

.spinner{
  display:inline-block;
  width:15px;
  height:15px;
  border:2px solid #6672ff;
  border-top-color:transparent;
  border-radius:50%;
  animation:spin .8s linear infinite;
  vertical-align:middle;
  margin-right:7px;
}

@keyframes spin{
  to{
    transform:rotate(360deg);
  }
}

@media(max-width:500px){

  .wrap{
    padding:12px;
  }

  .grid{
    grid-template-columns:1fr 1fr;
  }

  h1{
    font-size:26px;
  }

}

</style>

</head>


<body>

<div class="wrap">


<!-- ==============================
     HEADER
================================ -->

<div class="card">

<h1>🎬 AI VIDEO FACTORY</h1>

<p>
Sản xuất MP4 hàng loạt từ một chủ đề.
</p>


<!-- CHỦ ĐỀ -->

<label for="topic">
Chủ đề
</label>

<input
  id="topic"
  type="text"
  placeholder="Ví dụ: 5 mẹo chăm sóc mèo"
  value="5 mẹo chăm sóc mèo"
>


<!-- SỐ VIDEO + THỜI LƯỢNG -->

<div class="grid">

<div>

<label for="count">
Số video
</label>

<input
  id="count"
  type="number"
  min="1"
  max="5"
  value="3"
>

</div>


<div>

<label for="duration">
Thời lượng
</label>

<select id="duration">

<option value="30">
30 giây
</option>

<option value="60">
60 giây
</option>

</select>

</div>

</div>


<!-- PHONG CÁCH -->

<label for="style">
Phong cách
</label>

<select id="style">

<option value="viral, cuốn hút">
viral, cuốn hút
</option>

<option value="kể chuyện">
kể chuyện
</option>

<option value="kiến thức">
kiến thức
</option>

<option value="bán hàng">
bán hàng
</option>

</select>


<!-- ĐỐI TƯỢNG -->

<label for="audience">
Đối tượng
</label>

<input
  id="audience"
  type="text"
  value="người xem Facebook"
>


<!-- BUTTON -->

<button id="go">
🚀 SẢN XUẤT MP4 HÀNG LOẠT
</button>


<div
  id="loading"
  class="loading"
>

<span class="spinner"></span>

Đang sản xuất video, vui lòng chờ...

</div>

</div>


<!-- ==============================
     KẾT QUẢ
================================ -->

<div class="card">

<div
  id="status"
  class="status"
>
Chưa có tác vụ
</div>


<div class="progress">

<div
  id="bar"
  class="bar"
></div>

</div>


<div id="results"></div>

</div>


<!-- ==============================
     GHI CHÚ
================================ -->

<div class="small">

Video được tạo bằng ảnh thực tế từ nguồn hình ảnh,
giọng đọc tiếng Việt và FFmpeg, định dạng MP4 dọc 9:16.

<br><br>

API key không cần nhập vào giao diện.

</div>


</div>


<script>

/* =========================================
   HELPER
========================================= */

const $ = (id) => {
  return document.getElementById(id);
};


/* =========================================
   HIỂN THỊ TRẠNG THÁI
========================================= */

function setStatus(message, type = "") {

  $("status").textContent = message;

  $("status").className =
    "status " + type;

}


/* =========================================
   HIỂN THỊ KẾT QUẢ VIDEO
========================================= */

function showVideos(videos) {

  if (!Array.isArray(videos)) {
    return;
  }

  $("results").innerHTML = "";

  videos.forEach((video, index) => {

    const item =
      document.createElement("div");

    item.className = "item";


    const title =
      document.createElement("div");

    title.innerHTML =
      "🎞️ Video " +
      (video.index || index + 1) +
      ": <b>" +
      escapeHtml(
        video.title || "Video"
      ) +
      "</b>";


    item.appendChild(title);


    if (video.ok && video.url) {

      const link =
        document.createElement("a");

      link.href = video.url;

      link.target = "_blank";

      link.rel = "noopener";

      link.textContent =
        "⬇️ MỞ / TẢI MP4";


      item.appendChild(link);

    } else {

      const error =
        document.createElement("div");

      error.className =
        "error";

      error.textContent =
        "❌ " +
        (video.error ||
         "Không tạo được video.");

      item.appendChild(error);

    }


    $("results").appendChild(item);

  });

}


/* =========================================
   ESCAPE HTML
========================================= */

function escapeHtml(value) {

  return String(value)
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;")
    .replace(/'/g,"&#039;");

}


/* =========================================
   TẠO VIDEO
========================================= */

$("go").onclick = async function() {

  const button =
    $("go");

  button.disabled = true;

  $("results").innerHTML = "";

  $("bar").style.width = "5%";

  $("loading").style.display =
    "block";


  const topic =
    $("topic").value.trim();

  const count =
    Number($("count").value);

  const duration =
    Number($("duration").value);

  const style =
    $("style").value;

  const audience =
    $("audience").value.trim();


  /* -------------------------------
     KIỂM TRA
  -------------------------------- */

  if (!topic) {

    setStatus(
      "❌ Vui lòng nhập chủ đề.",
      "error"
    );

    button.disabled = false;

    $("loading").style.display =
      "none";

    return;
  }


  try {

    setStatus(
      "⏳ Đang gửi yêu cầu sản xuất..."
    );

    $("bar").style.width =
      "10%";


    /* =================================
       GỌI ĐÚNG API SERVER
       /api/generate
    ================================= */

    const response =
      await fetch(
        "/api/generate",
        {
          method:"POST",

          headers:{
            "Content-Type":
              "application/json"
          },

          body:JSON.stringify({

            topic:topic,

            count:count,

            duration:duration,

            style:style,

            audience:audience

          })

        }
      );


    $("bar").style.width =
      "35%";


    /* =================================
       ĐỌC RESPONSE AN TOÀN
    ================================= */

    const text =
      await response.text();


    let data;

    try {

      data =
        JSON.parse(text);

    } catch (parseError) {

      throw new Error(
        "Server trả về dữ liệu không hợp lệ."
      );

    }


    /* =================================
       SERVER BÁO LỖI
    ================================= */

    if (!response.ok) {

      throw new Error(
        data.error ||
        "API tạo video bị lỗi."
      );

    }


    /* =================================
       KẾT QUẢ
    ================================= */

    $("bar").style.width =
      "100%";


    if (
      data.ok &&
      Array.isArray(data.videos)
    ) {

      const success =
        Number(data.success || 0);

      const total =
        Number(
          data.total ||
          data.videos.length
        );


      if (success > 0) {

        setStatus(
          "✅ " +
          (data.message ||
           `Đã tạo ${success}/${total} video.`),
          "success"
        );

      } else {

        setStatus(
          "❌ Không tạo được video nào.",
          "error"
        );

      }


      showVideos(
        data.videos
      );


    } else {

      throw new Error(
        data.error ||
        data.message ||
        "Không nhận được kết quả từ server."
      );

    }


  } catch (error) {

    console.error(
      "GENERATE ERROR:",
      error
    );


    $("bar").style.width =
      "0%";


    setStatus(
      "❌ " +
      (
        error.message ||
        "Có lỗi xảy ra."
      ),
      "error"
    );


  } finally {

    button.disabled = false;

    $("loading").style.display =
      "none";

  }

};


/* =========================================
   KIỂM TRA API KHI MỞ TRANG
========================================= */

async function checkAPI() {

  try {

    const response =
      await fetch("/api");


    if (!response.ok) {
      throw new Error(
        "API không phản hồi."
      );
    }


    const data =
      await response.json();


    if (
      data.ok &&
      data.endpoints &&
      data.endpoints.generate
    ) {

      console.log(
        "AI Video Factory API OK:",
        data.endpoints
      );

    } else {

      console.warn(
        "API phản hồi nhưng chưa đúng cấu trúc."
      );

    }


  } catch (error) {

    console.error(
      "API CHECK ERROR:",
      error
    );

  }

}


/* =========================================
   CHẠY KIỂM TRA
========================================= */

checkAPI();

</script>

</body>

</html>
