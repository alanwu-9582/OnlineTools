// js/tools/ig-template/render.js — 把模板畫到 canvas 上。
//
// 圖片一律由呼叫端先載好再傳進來，這裡是同步的 —— 拖曳照片時每一格都要重畫，
// 中間夾一個 await 會讓畫面閃。

import { applyFont, layoutText, fitPhoto } from "./layout.js";

/** 圓角路徑。roundRect 是比較新的 API，沒有就自己補。 */
function roundRectPath(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  if (!radius) { ctx.rect(x, y, w, h); return; }
  if (typeof ctx.roundRect === "function") { ctx.roundRect(x, y, w, h, radius); return; }
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** 依角度做線性漸層。0° 由上往下、90° 由左往右。 */
function makeGradient(ctx, layer) {
  const { x, y, w, h } = layer.rect;
  const rad = ((layer.gradient.angle - 90) * Math.PI) / 180;
  // 讓漸層軸的兩端落在 rect 的外接圓上，任何角度都能鋪滿。
  const r = Math.hypot(w, h) / 2;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const grad = ctx.createLinearGradient(
    cx - Math.cos(rad) * r, cy - Math.sin(rad) * r,
    cx + Math.cos(rad) * r, cy + Math.sin(rad) * r,
  );
  grad.addColorStop(0, layer.gradient.from);
  grad.addColorStop(1, layer.gradient.to);
  return grad;
}

/**
 * 畫一整張。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} template
 * @param {{slots?:Map, placeholders?:boolean, hideText?:Set<string>}} opts
 *   slots       layerId -> { img, scale, dx, dy }。photo 與 image 共用一個 map，
 *               兩者都是「一個圖槽」，差別只在預設 fit 與語意。
 *   placeholders 空的照片框要不要畫提示。預覽時開、匯出時關。
 *   hideText    正在用行內輸入框編輯的文字圖層，canvas 這邊要跳過不畫，
 *               不然會跟上面那層輸入框的字疊成兩份。
 *
 * 選取框不在這裡畫 —— 那是 DOM 覆蓋層的事。canvas 上永遠只有成品本身，
 * 所以匯出前不需要先重畫一次。
 * @returns {{overflow:string[], missing:string[]}} 溢出與還沒放照片的圖層標籤
 */
export function renderTemplate(ctx, template, {
  slots = new Map(), placeholders = false, hideText = null,
} = {}) {
  const { canvas, layers } = template;
  const overflow = [];
  const missing = [];

  ctx.save();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = canvas.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (const layer of layers) {
    const { x, y, w, h } = layer.rect;
    ctx.save();
    ctx.globalAlpha = layer.opacity;
    // 繞 rect 中心旋轉。放在 clip 之前，裁切框才會跟著轉。
    if (layer.rotate) {
      ctx.translate(x + w / 2, y + h / 2);
      ctx.rotate((layer.rotate * Math.PI) / 180);
      ctx.translate(-(x + w / 2), -(y + h / 2));
    }

    if (layer.type === "rect") {
      ctx.beginPath();
      roundRectPath(ctx, x, y, w, h, layer.radius);
      ctx.fillStyle = layer.gradient ? makeGradient(ctx, layer) : layer.color;
      ctx.fill();
    } else if (layer.type === "image" || layer.type === "photo") {
      const state = slots.get(layer.id);
      const img = state?.img;

      if (img) {
        ctx.beginPath();
        roundRectPath(ctx, x, y, w, h, layer.radius);
        ctx.clip();
        const placed = fitPhoto({
          imgW: img.naturalWidth || img.width,
          imgH: img.naturalHeight || img.height,
          box: layer.rect,
          fit: layer.fit || (layer.type === "image" ? "contain" : "cover"),
          scale: state?.scale ?? 1,
          dx: state?.dx ?? 0,
          dy: state?.dy ?? 0,
        });
        ctx.drawImage(img, placed.x, placed.y, placed.w, placed.h);
      } else {
        missing.push(layer.label);
        if (placeholders) drawPlaceholder(ctx, layer);
      }
    } else if (layer.type === "text" && !hideText?.has(layer.id)) {
      const laid = layoutText(ctx, layer);
      if (laid.overflow) overflow.push(layer.label);

      // 文字裁到框內。溢出的部分寧可被切掉也不要蓋到別的圖層 ——
      // 反正上面已經記下來，UI 會明確講是哪一層爆掉。
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();

      applyFont(ctx, layer.font, laid.size);
      ctx.fillStyle = layer.color;
      ctx.textBaseline = "middle";
      ctx.textAlign = layer.align;

      const lineH = laid.size * layer.font.lineHeight;
      const anchorX = layer.align === "center" ? x + w / 2 : layer.align === "right" ? x + w : x;
      const top = layer.valign === "middle" ? y + (h - laid.total) / 2
        : layer.valign === "bottom" ? y + h - laid.total
          : y;

      laid.lines.forEach((line, i) => {
        // 每一行都垂直置中在自己的行高裡，行距才會平均。
        ctx.fillText(line, anchorX, top + lineH * (i + 0.5));
      });
    }

    ctx.restore();
  }

  ctx.restore();
  return { overflow, missing };
}

/** 還沒放照片的框：畫一個虛線框跟提示字，不然預覽會是一片空白。 */
function drawPlaceholder(ctx, layer) {
  const { x, y, w, h } = layer.rect;
  ctx.save();
  ctx.beginPath();
  roundRectPath(ctx, x, y, w, h, layer.radius);
  ctx.fillStyle = "rgba(0, 0, 0, 0.06)";
  ctx.fill();
  ctx.strokeStyle = "rgba(0, 0, 0, 0.28)";
  ctx.lineWidth = Math.max(2, Math.min(w, h) / 120);
  ctx.setLineDash([ctx.lineWidth * 5, ctx.lineWidth * 4]);
  ctx.stroke();
  ctx.setLineDash([]);

  const size = Math.max(14, Math.min(w, h) / 12);
  ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
  ctx.font = `500 ${size}px "IBM Plex Sans JP", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(layer.placeholder || "照片", x + w / 2, y + h / 2);
  ctx.restore();
}

/** 載一張圖，等它真的可以畫了才回來。 */
export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("圖片載入失敗"));
    img.src = src;
  });
}

/**
 * 匯出成檔案。
 *
 * 注意：如果有任何遠端圖片被畫進去，canvas 會被 taint，這裡會丟
 * SecurityError。這也是為什麼 schema 只放行 data URI —— 讓問題在讀模板時
 * 就被擋掉，而不是等到使用者按下匯出。
 */
export function exportBlob(canvas, { type = "image/png", quality = 0.92 } = {}) {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("瀏覽器沒有產出圖片"))),
        type,
        type === "image/jpeg" ? quality : undefined,
      );
    } catch (err) {
      reject(err);
    }
  });
}
