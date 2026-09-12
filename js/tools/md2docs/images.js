// js/tools/md2docs/images.js — 把 Markdown 裡的圖變成可以塞進 .docx 的位元組。
//
// 三種來源, 一起支援:
//   data:…        直接解碼, 一定成功
//   http(s)://…   下載回來（對方沒開 CORS 就會失敗, 這時如實回報而不是靜靜略過）
//   相對路徑      在使用者「附加的圖片檔」裡用檔名找
//
// 相對路徑那條是實際最常用的: 報告的 .md 跟圖片放在同一個資料夾, 寫的是
// `![](sem.png)`。網頁沒有辦法自己去讀那個資料夾, 所以請使用者把圖一起選進來,
// 再用檔名對回去。對使用者來說就是多選幾個檔案, 不用改 Markdown 裡的任何一個字。
//
// 尺寸一律交給瀏覽器解（<img> 的 naturalWidth）, 不自己讀 PNG/JPEG 的檔頭:
// 少一份要維護的格式解析, 而且瀏覽器認得的格式都自動支援。
// Word 讀不懂的格式（SVG、WebP…）在這裡先用 canvas 轉成 PNG。

/** Word 直接吃得下的格式。其餘一律轉 PNG。 */
const NATIVE = new Set(["image/png", "image/jpeg", "image/gif"]);

const EXT = { "image/png": "png", "image/jpeg": "jpeg", "image/gif": "gif" };

/** 走訪所有區塊, 收集用到的圖片路徑（含行內圖）。 */
export function collectImageSources(blocks) {
  const out = new Set();
  const visit = (list) => {
    for (const b of list || []) {
      if (b.kind === "figure" && b.src) out.add(b.src);
      for (const run of b.inlines || []) if (run.image?.src) out.add(run.image.src);
      if (b.blocks) visit(b.blocks);
      if (b.items) for (const item of b.items) visit(item.blocks);
      if (b.header) for (const c of b.header) for (const run of c.inlines || []) if (run.image?.src) out.add(run.image.src);
      if (b.rows) for (const r of b.rows) for (const c of r) for (const run of c.inlines || []) if (run.image?.src) out.add(run.image.src);
    }
  };
  visit(blocks);
  return [...out];
}

function basename(src) {
  return String(src).split(/[?#]/)[0].split("/").pop().toLowerCase();
}

function decodeDataUrl(src) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(src);
  if (!m) throw new Error("data: 網址的格式不對");
  const mime = m[1] || "image/png";
  const body = m[3];
  if (m[2]) {
    const bin = atob(body);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return { bytes, mime };
  }
  return { bytes: new TextEncoder().encode(decodeURIComponent(body)), mime };
}

/** 量出自然尺寸（CSS 像素）。順便回傳已經載好的 <img>, 需要轉檔時直接畫。 */
function measure(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => resolve({ img, url, width: img.naturalWidth || 0, height: img.naturalHeight || 0 });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("這個檔案不是瀏覽器讀得懂的圖片")); };
    img.src = url;
  });
}

/** 不是 PNG/JPEG/GIF 就畫到 canvas 再輸出 PNG, 否則 Word 會顯示成一個紅叉。 */
async function toPng(img, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("轉存 PNG 失敗");
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * `![說明](圖.png "說明 =60%")` —— 尾巴的 `=60%` 或 `=80mm` 是顯示寬度。
 * Markdown 本身沒有這個語法, 但不給一個指定寬度的方法, 一張手機拍的照片
 * 會佔掉整頁, 使用者只能回去改圖檔。回傳解析結果與去掉指令後的說明文字。
 */
export function parseSizeHint(text) {
  const m = /\s*=\s*(\d+(?:\.\d+)?)\s*(%|mm|cm)?\s*$/.exec(String(text ?? ""));
  if (!m) return { caption: String(text ?? "").trim(), percent: 0, mm: 0 };
  const value = Number(m[1]);
  const unit = m[2] || "%";
  return {
    caption: String(text).slice(0, m.index).trim(),
    percent: unit === "%" ? Math.min(100, Math.max(1, value)) : 0,
    mm: unit === "mm" ? value : unit === "cm" ? value * 10 : 0,
  };
}

/**
 * 解析所有圖片。
 *
 * @param {string[]} sources
 * @param {Map<string, File>} attachments 檔名（小寫）→ 使用者附加的檔案
 * @returns {Promise<{images: Map<string, object>, missing: string[]}>}
 *   每張圖: {bytes, mime, ext, width, height, dataUrl}
 */
/**
 * 解過的圖存起來。預覽是每次停下打字就重排一遍, 沒有快取的話每打一個字
 * 都要把所有圖重新解碼、重新轉 base64 —— 一張手機拍的照片就夠卡了。
 * key 帶上檔案的大小與修改時間, 換了同名的新檔會自動失效。
 */
const cache = new Map();
const CACHE_LIMIT = 60;

function cacheKey(src, file) {
  return file ? `${src}|${file.size}|${file.lastModified}` : src;
}

function remember(key, value) {
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return value;
}

export async function resolveImages(sources, attachments = new Map()) {
  const images = new Map();
  const missing = [];

  await Promise.all(sources.map(async (src) => {
    const key = cacheKey(src, /^(data:|https?:)/i.test(src) ? null : attachments.get(basename(src)));
    if (cache.has(key)) {
      const hit = cache.get(key);
      if (hit.error) missing.push(hit.error);
      else images.set(src, hit.image);
      return;
    }
    try {
      let bytes;
      let mime;
      if (/^data:/i.test(src)) {
        ({ bytes, mime } = decodeDataUrl(src));
      } else if (/^https?:\/\//i.test(src)) {
        const res = await fetch(src, { mode: "cors" });
        if (!res.ok) throw new Error(`下載失敗（${res.status}）`);
        const blob = await res.blob();
        bytes = new Uint8Array(await blob.arrayBuffer());
        mime = blob.type || "image/png";
      } else {
        const file = attachments.get(basename(src));
        if (!file) throw new Error("沒有附加這個檔案");
        bytes = new Uint8Array(await file.arrayBuffer());
        mime = file.type || "image/png";
      }

      const { img, url, width, height } = await measure(new Blob([bytes], { type: mime }));
      let outBytes = bytes;
      let outMime = mime;
      if (!NATIVE.has(mime)) {
        outBytes = await toPng(img, width, height);
        outMime = "image/png";
      }
      URL.revokeObjectURL(url);

      images.set(src, remember(key, {
        image: {
          bytes: outBytes,
          mime: outMime,
          ext: EXT[outMime] || "png",
          width: width || 640,
          height: height || 480,
          // 預覽與列印都用 data: —— blob: 網址在列印用的 iframe 裡活不過換文件。
          dataUrl: `data:${outMime};base64,${base64(outBytes)}`,
        },
      }).image);
    } catch (err) {
      // 找不到的也要記, 否則每打一個字都會再去抓一次同一個不存在的網址。
      missing.push(remember(key, { error: `${src}（${err.message}）` }).error);
    }
  }));

  return { images, missing };
}

/** Uint8Array → base64。分段處理, 免得大圖把 apply 的參數撐爆。 */
function base64(bytes) {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(binary);
}
