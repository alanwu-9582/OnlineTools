// js/utils/utils.js — 共用小工具與 DOM 輔助函式。

/* ---------------- 圖示 ---------------- */
const ICON_NAMES = new Set([
  "home", "book", "search", "filter", "x", "alert", "check", "info", "link", "copy",
  "arrow-right", "external", "tool", "grid", "play", "pause", "lock",
]);

/** 以獨立 SVG 檔作為遮罩，讓圖示沿用文字顏色。未知名稱回傳空字串。 */
export function icon(name, { size = "1em" } = {}) {
  const normalized = name === "arrowRight" ? "arrow-right" : name;
  if (!ICON_NAMES.has(normalized)) return "";
  return `<span class="svg-icon icon-${normalized}" style="width:${size};height:${size}" aria-hidden="true"></span>`;
}

/** 把文字轉義後才放進 innerHTML。 */
export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 正規化文字, 供不分大小寫的比較使用。 */
export function normalizeText(value) {
  return String(value ?? "").trim().toLowerCase();
}

/** 取 JSON, 失敗時給出清楚的訊息。 */
export async function loadJSON(path) {
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`載入失敗 (${res.status}): ${path}`);
  return res.json();
}

/** 取純文字（例如 Markdown 原始檔）。 */
export async function loadText(path) {
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`載入失敗 (${res.status}): ${path}`);
  return res.text();
}

/** 把函式節流成 wait 毫秒後才執行。 */
export function debounce(fn, wait = 120) {
  let t = null;
  return function (...args) {
    if (t) clearTimeout(t);
    t = setTimeout(() => { t = null; fn.apply(this, args); }, wait);
  };
}

/** 格式化成 "YYYY/MM/DD"。接受 ISO / "YYYY/MM/DD" / Date。 */
export function formatDate(value) {
  if (!value) return "";
  if (typeof value === "string") {
    const m = value.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
    if (m) return `${m[1]}/${String(m[2]).padStart(2, "0")}/${String(m[3]).padStart(2, "0")}`;
  }
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return String(value);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}

/** 解析 "YYYY/MM/DD" 之類的值成毫秒, 失敗回傳 NaN。 */
function parseDate(value) {
  return Date.parse(String(value ?? "").replace(/\//g, "-"));
}

/** 人看得懂的相對時間: 今天 / 3 天前 / 2 個月前。 */
export function relativeDate(value) {
  const t = parseDate(value);
  if (isNaN(t)) return "";
  const days = Math.floor((Date.now() - t) / 86400000);
  if (days < 0) return "剛剛";
  if (days === 0) return "今天";
  if (days === 1) return "昨天";
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 個月前`;
  return `${Math.floor(days / 365)} 年前`;
}

/** "約 5 分鐘" 的閱讀時間標籤。 */
export function readingLabel(minutes) {
  const n = Number(minutes);
  return n > 0 ? `約 ${n} 分鐘` : "";
}

/** 日期由新到舊；無法解析的排最後。 */
export function compareDateDesc(a, b) {
  const ta = parseDate(a);
  const tb = parseDate(b);
  return (isNaN(tb) ? -Infinity : tb) - (isNaN(ta) ? -Infinity : ta);
}

/** 標題比較: 語系正確且能認得數字（02 < 10）。 */
export function compareTitle(a, b) {
  return String(a ?? "").localeCompare(String(b ?? ""), "zh-Hant", {
    numeric: true,
    sensitivity: "base",
  });
}

/** 把搜尋字串切成正規化後的詞。 */
export function queryTerms(query) {
  return normalizeText(query).split(/\s+/).filter(Boolean);
}

/**
 * 轉義 text 之後, 把命中的 terms 包上 <mark>, 不分大小寫。
 */
export function highlightTerms(text, terms = []) {
  const raw = String(text ?? "");
  const list = terms.filter(Boolean);
  if (!raw || !list.length) return escapeHtml(raw);
  const pattern = list
    // 長的排前面, 避免互相蓋住。
    .slice().sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  if (!pattern) return escapeHtml(raw);
  const re = new RegExp(`(${pattern})`, "gi");
  // 有一個捕捉群組時, split() 會是「文字、命中、文字、命中…」交錯。
  return raw
    .split(re)
    .map((piece, i) => (i % 2 === 1
      ? `<mark class="hl">${escapeHtml(piece)}</mark>`
      : escapeHtml(piece)))
    .join("");
}

/** querySelector 縮寫。 */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** 建立元素, 可帶屬性與子節點。 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === "html") node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** 轉成 id / URL 安全的字串（保留中日韓文字）。 */
export function slugify(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s/\\]+/g, "-")
    .replace(/[^\w一-鿿-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
