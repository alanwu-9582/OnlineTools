// js/tools/ig-template/color.js — 顏色的單一表示法。
//
// 模板裡的顏色統一是 hex，需要透明度就用 8 位（#RRGGBBAA）。
// 理由：一種寫法就夠，複製貼上看得懂、diff 得出來，而且 canvas 的
// fillStyle / strokeStyle 跟 CSS 都直接吃 8 位 hex，不用在渲染時再轉一手。
//
// 讀進來的時候還是接受任何 CSS 顏色（rgba()、色名、3/4 位短式）——
// 手寫的模板與從 .pptx 轉來的東西什麼都有 —— 但存回去一律正規化成 hex。

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * hex 與 rgb()/rgba() 自己解，不碰 DOM。
 *
 * 這一段刻意不依賴瀏覽器: schema.js 要能在 Node 裡跑測試（那些測試抓過
 * 好幾個真的 bug），而模板裡九成九的顏色就是這兩種寫法。
 * 色名、hsl() 這類少見的才退回下面的 canvas 解析。
 *
 * @returns {{r:number,g:number,b:number,a:number}|null}
 */
function parsePlain(css) {
  const s = css.trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (hex) {
    const d = hex[1];
    // 3/4 位是短式，每個字元代表重複兩次（#f80 = #ff8800）。
    if (d.length === 3 || d.length === 4) {
      const [r, g, b, a] = [...d].map((ch) => parseInt(ch + ch, 16));
      return { r, g, b, a: d.length === 4 ? a / 255 : 1 };
    }
    if (d.length === 6 || d.length === 8) {
      const n = parseInt(d.slice(0, 6), 16);
      return {
        r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255,
        a: d.length === 8 ? parseInt(d.slice(6), 16) / 255 : 1,
      };
    }
    return null;   // 5 位或 7 位不是合法寫法
  }
  const fn = /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.%]+)\s*)?\)$/i
    .exec(s);
  if (!fn) return null;
  const alpha = fn[4] === undefined ? 1
    : fn[4].endsWith("%") ? Number(fn[4].slice(0, -1)) / 100 : Number(fn[4]);
  const nums = [fn[1], fn[2], fn[3]].map(Number);
  if (nums.some((n) => !Number.isFinite(n)) || !Number.isFinite(alpha)) return null;
  return { r: nums[0], g: nums[1], b: nums[2], a: clamp(alpha, 0, 1) };
}

/**
 * 用 canvas 當解析器。
 *
 * 自己寫 regex 只會涵蓋到自己想得到的那幾種寫法；丟給瀏覽器則 rgba()、hsl()、
 * 色名、3/4/6/8 位 hex 全都認得，而且認法跟真正繪圖時完全一致。
 *
 * 讀值是讀回 fillStyle 這個字串，**不是**填一格再取畫素 ——
 * canvas 內部存的是預乘顏色，getImageData 還原時半透明的色會掉精度
 * （#ff880080 會變成 #ff870080）。fillStyle 的正規化字串是精確的。
 */
let probe = null;
function probeCtx() {
  if (typeof document === "undefined") return null;
  if (!probe) probe = document.createElement("canvas").getContext("2d");
  return probe;
}

/** canvas 正規化之後只有兩種寫法: "#rrggbb" 或 "rgba(r, g, b, a)"。 */
function fromCanonical(value) {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i
    .exec(value);
  if (!rgba) return null;
  return {
    r: Number(rgba[1]), g: Number(rgba[2]), b: Number(rgba[3]),
    a: rgba[4] === undefined ? 1 : Number(rgba[4]),
  };
}

/**
 * 解析任何 CSS 顏色。認不出來的回 null（由呼叫端決定退路）。
 * @returns {{r:number, g:number, b:number, a:number}|null}
 */
export function parseColor(css) {
  if (typeof css !== "string" || !css.trim()) return null;
  const plain = parsePlain(css);
  if (plain) return plain;

  const ctx = probeCtx();
  if (!ctx) return null;         // 沒有 DOM（例如 Node 測試）就到此為止
  // fillStyle 對認不出來的字串會「保持原本的值不動」。所以用兩個不同的
  // 哨兵各試一次: 有效的話兩次都會變成同一個顏色，無效的話兩次各自留在
  // 自己的哨兵上。這樣連 "#000000" 本身也判得對。
  ctx.fillStyle = "#000000";
  ctx.fillStyle = css;
  const first = ctx.fillStyle;
  ctx.fillStyle = "#ffffff";
  ctx.fillStyle = css;
  if (first !== ctx.fillStyle) return null;
  return fromCanonical(first);
}

const hex2 = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0");

/**
 * {r,g,b,a} → hex。完全不透明時給 6 位，其餘給 8 位 ——
 * 沒有透明度的顏色不需要多背兩個字元。
 */
export function toHex({ r, g, b, a = 1 }) {
  const base = `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  return a >= 0.999 ? base : `${base}${hex2(a * 255)}`;
}

/**
 * 把任何 CSS 顏色正規化成 hex。
 * @param {string} css
 * @param {string} fallback 認不出來時用這個
 */
export function normalizeColor(css, fallback = "#000000") {
  const rgba = parseColor(css);
  return rgba ? toHex(rgba) : fallback;
}

/** 取出不含透明度的那一段，給 <input type="color"> 用（它只吃 6 位）。 */
export function rgbPart(css) {
  const rgba = parseColor(css);
  return rgba ? `#${hex2(rgba.r)}${hex2(rgba.g)}${hex2(rgba.b)}` : "#000000";
}

/** 透明度，0–1。 */
export function alphaOf(css) {
  return parseColor(css)?.a ?? 1;
}

/** 換掉透明度，保留 RGB。 */
export function withAlpha(css, a) {
  const rgba = parseColor(css) || { r: 0, g: 0, b: 0, a: 1 };
  return toHex({ ...rgba, a: clamp(a, 0, 1) });
}

/** 換掉 RGB，保留透明度。 */
export function withRgb(css, rgbHex) {
  const next = parseColor(rgbHex);
  if (!next) return normalizeColor(css);
  return toHex({ ...next, a: alphaOf(css) });
}
