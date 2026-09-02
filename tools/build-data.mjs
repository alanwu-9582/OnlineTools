// tools/build-data.mjs — 掃描 content/**/*.md，產生
// data/entries.json 與 data/search-index.json。
//
//   node tools/build-data.mjs          產生檔案
//   node tools/build-data.mjs --check  只檢查、不寫檔（有落差時以非 0 結束）
//
// 設計原則: 
//   1. 不動任何 .md 原始檔，只讀檔頭的 <!-- key: value --> 註解。
//   2. id 依 path 沿用既有資料，避免既有連結失效。
//   3. 「最後更新」從 git 紀錄自動抓（不是 git 專案就退回發佈日期）。
//   4. 內文裡的 <div data-tool="…"> 會被記下來，順便檢查工具模組存不存在。
//
// 檔頭可用欄位: 
//   title / description / category / tags / published time / cover / type

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT_DIR = path.join(ROOT, "content");
const TOOL_MODULE_DIR = path.join(ROOT, "js", "tools");
const ENTRIES_JSON = path.join(ROOT, "data", "entries.json");
const SITE_JSON = path.join(ROOT, "data", "site.json");
const SEARCH_JSON = path.join(ROOT, "data", "search-index.json");
/** 檔頭只寫檔名時，封面圖從這裡找。 */
const COVER_BASE = "assets/images/covers";

/** 頂層資料夾 → 內容種類。檔頭的 type 可以蓋過去。 */
const FOLDER_TYPE = { tools: "tool", docs: "doc" };
const TYPES = new Set(["tool", "doc"]);

const CHECK_ONLY = process.argv.includes("--check");
const warnings = [];
const warn = (msg) => warnings.push(msg);

/* ============================ 小工具 ============================ */

/** 必須與 js/utils/utils.js 的 slugify() 完全一致，否則搜尋深連結會對不上。 */
function slugify(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s/\\]+/g, "-")
    .replace(/[^\w一-鿿-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** 去掉行內 Markdown 語法，取純文字（標題 slug 與全文索引都要用）。 */
function stripInline(text) {
  return String(text ?? "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")   // 圖片 → alt
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")    // 連結 → 文字
    .replace(/`([^`]*)`/g, "$1")                // 行內程式碼
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/__([^_]*)__/g, "$1")
    .replace(/\*([^*]*)\*/g, "$1")
    .replace(/~~([^~]*)~~/g, "$1")
    .replace(/<[^>]+>/g, "")                    // 裸 HTML 標籤（工具佔位也在這裡被吃掉）
    .replace(/\s+/g, " ")
    .trim();
}

function walkMarkdown(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkMarkdown(full));
    else if (entry.toLowerCase().endsWith(".md")) out.push(full);
  }
  return out.sort();
}

/** 以 / 分隔的相對路徑（entries.json 的 path 欄位格式）。 */
function relPath(absolute) {
  return path.relative(ROOT, absolute).split(path.sep).join("/");
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** git 最後提交時間 → YYYY/MM/DD；未追蹤或非 git 環境回傳 null。 */
function gitDate(file) {
  try {
    const iso = execFileSync("git", ["log", "-1", "--format=%cI", "--", file], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!iso) return null;
    const [date] = iso.split("T");
    return date.replace(/-/g, "/");
  } catch {
    return null;
  }
}

function normalizeDate(value) {
  const m = String(value ?? "").match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (!m) return "";
  return `${m[1]}/${String(m[2]).padStart(2, "0")}/${String(m[3]).padStart(2, "0")}`;
}

/* ============================ 解析 Markdown ============================ */

/** 讀檔頭連續的 `<!-- key: value -->`；遇到第一個非註解、非空白行就停。 */
function parseFrontmatter(source) {
  const meta = {};
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const m = trimmed.match(/^<!--\s*([^:]+?)\s*:\s*([\s\S]*?)\s*-->$/);
    if (!m) break;
    meta[m[1].trim().toLowerCase()] = m[2].trim();
  }
  return meta;
}

/** 去掉檔頭註解後的正文。 */
function stripFrontmatter(source) {
  const lines = source.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (trimmed === "" || /^<!--[\s\S]*-->$/.test(trimmed)) i++;
    else break;
  }
  return lines.slice(i).join("\n");
}

/**
 * 內文裡出現過的工具 id，依出現順序、不重複。
 * 程式碼區塊裡的要跳過 —— 說明文件會把佔位當範例寫出來，那不是真的要掛工具。
 */
function extractToolIds(body) {
  const ids = [];
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    for (const m of line.matchAll(/data-tool\s*=\s*["']([^"']+)["']/g)) {
      const id = m[1].trim();
      if (id && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

/**
 * 把正文切成 { headingId, heading, text } 區塊，搜尋結果才能直接跳到章節。
 * 標題 id 的產生方式（含重複時補 -2、-3）必須與 js/utils/markdown.js 的
 * renderer.heading 一致。
 */
function extractBlocks(body) {
  const used = new Set();
  const blocks = [];
  const fresh = (headingId, heading) => ({ headingId, heading, lines: [], code: [] });
  let current = fresh("", "");
  let inFence = false;

  const flush = () => {
    if (current.lines.length || current.code.length || current.heading) blocks.push(current);
  };

  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    // 程式碼原樣留著: 常常就是靠搜某個指令或識別字找回文章。
    if (inFence) { current.code.push(line); continue; }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flush();
      const level = heading[1].length;
      const text = stripInline(heading[2]);
      const base = slugify(text) || `sec-${level}`;
      let id = base;
      let n = 2;
      while (used.has(id)) id = `${base}-${n++}`;
      used.add(id);
      current = fresh(id, text);
      continue;
    }
    current.lines.push(line);
  }
  flush();

  return blocks
    .map((b) => {
      const prose = stripInline(
        b.lines
          .join(" ")
          .replace(/^\s*[|>-]\s?/gm, " ")   // 表格 / 引言 / 清單記號
          .replace(/\|/g, " "),
      );
      const code = b.code.join(" ").replace(/\s+/g, " ").trim();
      return {
        headingId: b.headingId,
        heading: b.heading,
        text: [prose, code].filter(Boolean).join(" ").trim(),
      };
    })
    .filter((b) => b.heading || b.text);
}

/** 中文以字數、英文以詞數估算閱讀時間（分鐘，最少 1）。 */
function readingMinutes(plainText) {
  const cjk = (plainText.match(/[㐀-鿿豈-﫿]/g) || []).length;
  const words = (plainText.replace(/[㐀-鿿豈-﫿]/g, " ").match(/[A-Za-z0-9_.-]+/g) || []).length;
  return Math.max(1, Math.round(cjk / 350 + words / 200));
}

/** 封面: 完整路徑原樣用，只寫檔名就補上 assets/images/covers/。 */
function resolveCover(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (/^(https?:)?\/\//i.test(raw) || raw.startsWith("/") || raw.includes("/")) {
    return raw.replace(/^\.\//, "");
  }
  return `${COVER_BASE}/${raw}`;
}

/* ============================ 主流程 ============================ */

const site = readJSON(SITE_JSON, {});
const categoryKeys = Object.keys(site.categories || {});
const tagKeys = Object.keys(site.tags || {});

/** 大小寫不敏感地對回 site.json 的正式鍵名。 */
function canonical(value, keys, kind, file) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const hit = keys.find((k) => k.toLowerCase() === raw.toLowerCase());
  if (hit) return hit;
  warn(`${file}: 未知的${kind}「${raw}」，請先加入 data/site.json`);
  return raw;
}

/** description 常見的佔位字串，一律視為未填。 */
function cleanText(value) {
  const raw = String(value ?? "").trim();
  if (!raw || /^(nan|null|undefined|-)$/i.test(raw)) return "";
  return raw;
}

/** 頂層資料夾（content/tools/foo.md → tools）。 */
function topFolder(rel) {
  const parts = rel.split("/");
  return parts.length > 2 ? parts[1] : "";
}

const previous = readJSON(ENTRIES_JSON, { entries: [] });
const previousByPath = new Map((previous.entries || []).map((doc) => [doc.path, doc]));
const usedIds = new Set();

const entries = [];
const searchDocs = [];

for (const file of walkMarkdown(CONTENT_DIR)) {
  const rel = relPath(file);
  const source = readFileSync(file, "utf8");
  const meta = parseFrontmatter(source);
  const body = stripFrontmatter(source);
  const prior = previousByPath.get(rel) || {};

  const title = cleanText(meta.title) || cleanText(prior.title) || path.basename(file, ".md");
  const description = cleanText(meta.description) || cleanText(prior.description);
  const category = canonical(
    cleanText(meta.category) || cleanText(prior.category) || categoryKeys[0] || "",
    categoryKeys, "類別", rel,
  );

  const rawTags = String(meta.tags || "").split(/[,、\s]+/).filter(Boolean);
  const tags = [...new Set(
    (rawTags.length ? rawTags : (prior.tags || []))
      .map((t) => canonical(t, tagKeys, "標籤", rel))
      .filter(Boolean),
  )];

  const toolIds = extractToolIds(body);
  for (const id of toolIds) {
    // 一個工具一個資料夾，進入點固定是 index.js。
    if (!existsSync(path.join(TOOL_MODULE_DIR, id, "index.js"))) {
      warn(`${rel}: 找不到工具模組 js/tools/${id}/index.js`);
    }
  }

  // 種類: 檔頭最優先，其次看放在哪個資料夾，最後看內文有沒有工具。
  const declared = cleanText(meta.type).toLowerCase();
  if (declared && !TYPES.has(declared)) warn(`${rel}: 未知的 type「${declared}」，只能是 tool 或 doc`);
  const type = TYPES.has(declared)
    ? declared
    : (FOLDER_TYPE[topFolder(rel)] || (toolIds.length ? "tool" : "doc"));

  if (type === "tool" && !toolIds.length) {
    warn(`${rel}: 標成 tool 但內文沒有任何 <div data-tool="…"></div>`);
  }

  // id: 既有的優先沿用，其次用檔名，重複時補流水號。
  let id = prior.id || slugify(path.basename(file, ".md"));
  if (usedIds.has(id)) {
    warn(`${rel}: id「${id}」重複，已自動改名`);
    let n = 2;
    while (usedIds.has(`${id}-${n}`)) n++;
    id = `${id}-${n}`;
  }
  usedIds.add(id);

  const publishedDate =
    normalizeDate(meta["published time"] || meta.published || meta.date) ||
    normalizeDate(prior.publishedDate);
  const updatedDate = gitDate(rel) || publishedDate;
  const cover = resolveCover(meta.cover || meta["cover image"] || prior.cover);

  const blocks = extractBlocks(body);
  const plain = blocks.map((b) => `${b.heading} ${b.text}`).join(" ");

  if (!description) warn(`${rel}: 沒有 description，列表會少一行說明`);
  if (!publishedDate) warn(`${rel}: 沒有 published time，日期會留空`);

  entries.push({
    id,
    type,
    title,
    ...(description ? { description } : {}),
    path: rel,
    category,
    tags,
    ...(toolIds.length ? { tools: toolIds } : {}),
    ...(cover ? { cover } : {}),
    publishedDate,
    updatedDate,
    readingMinutes: readingMinutes(plain),
  });

  searchDocs.push({
    id,
    blocks: blocks
      .filter((b) => b.text || b.heading)
      .map((b) => ({ h: b.heading, i: b.headingId, t: b.text })),
  });
}

// 由新到舊；同一天的用標題排（數字感知）。
entries.sort((a, b) => {
  const ta = Date.parse(String(a.publishedDate).replace(/\//g, "-"));
  const tb = Date.parse(String(b.publishedDate).replace(/\//g, "-"));
  const va = isNaN(ta) ? -Infinity : ta;
  const vb = isNaN(tb) ? -Infinity : tb;
  if (va !== vb) return vb - va;
  return String(a.title).localeCompare(String(b.title), "zh-Hant", { numeric: true });
});
searchDocs.sort(
  (a, b) => entries.findIndex((d) => d.id === a.id) - entries.findIndex((d) => d.id === b.id),
);

/* ---------- 沒有人用到的工具模組 ---------- */

const referenced = new Set(entries.flatMap((doc) => doc.tools || []));
if (existsSync(TOOL_MODULE_DIR)) {
  for (const entry of readdirSync(TOOL_MODULE_DIR)) {
    const full = path.join(TOOL_MODULE_DIR, entry);
    // 資料夾才是工具；kit.js 那種放在外面的是共用元件。
    if (!statSync(full).isDirectory()) continue;
    if (!existsSync(path.join(full, "index.js"))) {
      warn(`js/tools/${entry}/: 少了 index.js，工具載不起來`);
    } else if (!referenced.has(entry)) {
      warn(`js/tools/${entry}/: 沒有任何 .md 用到它`);
    }
  }
}

/* ---------- 輸出 ---------- */

const entriesOut = `${JSON.stringify({ entries }, null, 2)}\n`;
const searchOut = `${JSON.stringify({ entries: searchDocs })}\n`;

const readOrEmpty = (file) => {
  try { return readFileSync(file, "utf8").trim(); } catch { return ""; }
};
const changed =
  readOrEmpty(ENTRIES_JSON) !== entriesOut.trim() ||
  readOrEmpty(SEARCH_JSON) !== searchOut.trim();

for (const w of warnings) console.warn(`! ${w}`);

if (CHECK_ONLY) {
  if (changed) {
    console.error("x data/ 與 content/ 不同步，請執行: node tools/build-data.mjs");
    process.exit(1);
  }
  console.log(`v ${entries.length} 筆內容，資料已同步`);
} else {
  writeFileSync(ENTRIES_JSON, entriesOut);
  writeFileSync(SEARCH_JSON, searchOut);
  const tools = entries.filter((doc) => doc.type === "tool").length;
  const kb = (Buffer.byteLength(searchOut) / 1024).toFixed(0);
  console.log(`v ${entries.length} 筆內容（工具 ${tools}、文檔 ${entries.length - tools}） -> data/entries.json`);
  console.log(`v 全文索引 ${kb} KB -> data/search-index.json`);
}
