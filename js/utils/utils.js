// js/utils/utils.js — 共用小工具與 DOM 輔助函式。

/* ---------------- 圖示 ---------------- */
// 直接內嵌 SVG（用 currentColor 上色），不額外抓檔案，也避免 mask URL 的相對路徑問題。
const ICON_PATHS = {
  home: '<path d="M3 10.5 12 3l9 7.5"></path><path d="M5.5 9.5V20h13V9.5"></path><path d="M9.5 20v-6h5v6"></path>',
  book: '<path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H19v18H5.5A1.5 1.5 0 0 1 4 19.5z"></path><path d="M4 17h15"></path><path d="M8 7.5h7"></path>',
  search: '<circle cx="11" cy="11" r="6.5"></circle><path d="m16 16 4.5 4.5"></path>',
  filter: '<line x1="4" y1="7" x2="20" y2="7"></line><line x1="7" y1="12" x2="17" y2="12"></line><line x1="10" y1="17" x2="14" y2="17"></line>',
  x: '<path d="M7 7l10 10M17 7 7 17"></path>',
  alert: '<path d="M12 4 2.8 20h18.4z"></path><path d="M12 10v4"></path><path d="M12 17.2v.2"></path>',
  check: '<polyline points="20 6 9 17 4 12"></polyline>',
  info: '<circle cx="12" cy="12" r="9"></circle><path d="M12 11v5"></path><path d="M12 8v.2"></path>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"></path><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"></path>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"></rect><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"></path>',
  arrowRight: '<path d="M5 12h14"></path><polyline points="13 6 19 12 13 18"></polyline>',
  external: '<path d="M14 4h6v6"></path><path d="M20 4 11 13"></path><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"></path>',
  tool: '<path d="M14.5 3.5a5.5 5.5 0 0 0-7.3 6.9l-4.1 4.1a2.4 2.4 0 0 0 3.4 3.4l4.1-4.1a5.5 5.5 0 0 0 6.9-7.3l-3 3-2.5-2.5z"></path><path d="M14 15.5 19.5 21"></path>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"></rect><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"></rect><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"></rect><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"></rect>',
  play: '<path d="M8.5 5.6v12.8L19 12z"></path>',
  pause: '<line x1="9.5" y1="5.5" x2="9.5" y2="18.5"></line><line x1="14.5" y1="5.5" x2="14.5" y2="18.5"></line>',
  lock: '<rect x="4.5" y="10.5" width="15" height="9.5" rx="2"></rect><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"></path>',
};

/** 回傳一段內嵌 SVG 字串。未知名稱回傳空字串。 */
export function icon(name, { size = "1em", stroke = 2 } = {}) {
  const paths = ICON_PATHS[name];
  if (!paths) return "";
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor"`
    + ` stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
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

/** 正規化文字，供不分大小寫的比較使用。 */
export function normalizeText(value) {
  return String(value ?? "").trim().toLowerCase();
}

/** 取 JSON，失敗時給出清楚的訊息。 */
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

/** 解析 "YYYY/MM/DD" 之類的值成毫秒，失敗回傳 NaN。 */
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
 * 轉義 text 之後，把命中的 terms 包上 <mark>，不分大小寫。
 */
export function highlightTerms(text, terms = []) {
  const raw = String(text ?? "");
  const list = terms.filter(Boolean);
  if (!raw || !list.length) return escapeHtml(raw);
  const pattern = list
    // 長的排前面，避免互相蓋住。
    .slice().sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  if (!pattern) return escapeHtml(raw);
  const re = new RegExp(`(${pattern})`, "gi");
  // 有一個捕捉群組時，split() 會是「文字、命中、文字、命中…」交錯。
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

/** 建立元素，可帶屬性與子節點。 */
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
