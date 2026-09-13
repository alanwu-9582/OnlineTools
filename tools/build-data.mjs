// tools/build-data.mjs — 掃描 content/**/*.md, 產生
// data/entries.json 與 data/search-index.json。
//
//   node tools/build-data.mjs          產生檔案
//   node tools/build-data.mjs --check  只檢查、不寫檔（有落差時以非 0 結束）
//
// 設計原則: 
//   1. 不動任何 .md 原始檔, 只讀檔頭的 <!-- key: value --> 註解。
//   2. id 依 path 沿用既有資料, 避免既有連結失效。
//   3. 「最後更新」從 git 紀錄自動抓（不是 git 專案就退回發佈日期）。
//   4. 內文裡的 <div data-tool="…"> 會被記下來, 順便檢查工具模組存不存在。
//
// 檔頭可用欄位: 
//   title / description / category / tags / published time / cover / type

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

import {
  ROOT, slugify, walkMarkdown, relPath, readJSON,
  parseFrontmatter, stripFrontmatter, extractToolIds, resolveCover,
} from "./lib.mjs";

const CONTENT_DIR = path.join(ROOT, "content");
const TOOL_MODULE_DIR = path.join(ROOT, "js", "tools");
const ENTRIES_JSON = path.join(ROOT, "data", "entries.json");
const SITE_JSON = path.join(ROOT, "data", "site.json");
const SEARCH_JSON = path.join(ROOT, "data", "search-index.json");

/** 頂層資料夾 → 內容種類。檔頭的 type 可以蓋過去。 */
const FOLDER_TYPE = { tools: "tool", docs: "doc" };
const TYPES = new Set(["tool", "doc"]);

const CHECK_ONLY = process.argv.includes("--check");
const warnings = [];
const warn = (msg) => warnings.push(msg);

/* ============================ 小工具 ============================ */

/** 去掉行內 Markdown 語法, 取純文字（標題 slug 與全文索引都要用）。 */
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

/**
 * 把正文切成 { headingId, heading, text } 區塊, 搜尋結果才能直接跳到章節。
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

/** 中文以字數、英文以詞數估算閱讀時間（分鐘, 最少 1）。 */
function readingMinutes(plainText) {
  const cjk = (plainText.match(/[㐀-鿿豈-﫿]/g) || []).length;
  const words = (plainText.replace(/[㐀-鿿豈-﫿]/g, " ").match(/[A-Za-z0-9_.-]+/g) || []).length;
  return Math.max(1, Math.round(cjk / 350 + words / 200));
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
  warn(`${file}: 未知的${kind}「${raw}」, 請先加入 data/site.json`);
  return raw;
}

/** description 常見的佔位字串, 一律視為未填。 */
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
    // 一個工具一個資料夾, 進入點固定是 index.js。
    if (!existsSync(path.join(TOOL_MODULE_DIR, id, "index.js"))) {
      warn(`${rel}: 找不到工具模組 js/tools/${id}/index.js`);
    }
  }

  // 種類: 檔頭最優先, 其次看放在哪個資料夾, 最後看內文有沒有工具。
  const declared = cleanText(meta.type).toLowerCase();
  if (declared && !TYPES.has(declared)) warn(`${rel}: 未知的 type「${declared}」, 只能是 tool 或 doc`);
  const type = TYPES.has(declared)
    ? declared
    : (FOLDER_TYPE[topFolder(rel)] || (toolIds.length ? "tool" : "doc"));

  if (type === "tool" && !toolIds.length) {
    warn(`${rel}: 標成 tool 但內文沒有任何 <div data-tool="…"></div>`);
  }

  // id: 既有的優先沿用, 其次用檔名, 重複時補流水號。
  let id = prior.id || slugify(path.basename(file, ".md"));
  if (usedIds.has(id)) {
    warn(`${rel}: id「${id}」重複, 已自動改名`);
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

  if (!description) warn(`${rel}: 沒有 description, 列表會少一行說明`);
  if (!publishedDate) warn(`${rel}: 沒有 published time, 日期會留空`);

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
      warn(`js/tools/${entry}/: 少了 index.js, 工具載不起來`);
    } else if (!referenced.has(entry)) {
      warn(`js/tools/${entry}/: 沒有任何 .md 用到它`);
    }
  }
}

/* ---------- Service Worker 的預先快取清單 ---------- */

/** 會被丟進離線快取的檔案。副檔名以外的東西（建置腳本、原始 .md）不進去。 */
const SHELL_ROOTS = [
  { dir: "css", ext: [".css"] },
  { dir: "js", ext: [".js", ".css"] },
  { dir: "pages", ext: [".html"] },
  { dir: "data", ext: [".json"] },
  { dir: "assets/icons", ext: [".svg"] },
  { dir: "assets/templates", ext: [".json", ".jpg", ".png", ".svg"] },
];
const SHELL_FILES = ["./", "index.html", "manifest.webmanifest", "assets/images/icon.svg"];
const SW_JS = path.join(ROOT, "sw.js");

function walkFiles(dir, exts, out = []) {
  const full = path.join(ROOT, dir);
  if (!existsSync(full)) return out;
  for (const name of readdirSync(full).sort()) {
    const rel = `${dir}/${name}`;
    if (statSync(path.join(ROOT, rel)).isDirectory()) walkFiles(rel, exts, out);
    else if (exts.includes(path.extname(name))) out.push(rel);
  }
  return out;
}

/**
 * 產生 sw.js 裡那段預先快取清單。
 *
 * 以前這份清單是手寫的, 於是它慢慢跟現實脫節 —— 稽核時裡面躺著九個
 * 早就刪掉的檔案, 而每次改動又都要記得手動把 CACHE_VERSION 加一。
 * 兩件事都交給這裡: 清單用掃的, 版本號是所有檔案內容的雜湊,
 * 內容一變就自動換一個名字, 舊快取自然被丟掉。
 */
function buildPrecache(pending) {
  const files = [...SHELL_FILES];
  for (const { dir, ext } of SHELL_ROOTS) files.push(...walkFiles(dir, ext));

  const hash = createHash("sha256");
  for (const rel of files) {
    if (rel === "./") continue;
    hash.update(rel);
    // data/entries.json 與搜尋索引也在清單裡, 而它們正是這次要覆寫的東西。
    // 讀磁碟上那份舊的會讓雜湊比實際內容慢一步 —— 寫完之後再跑 --check 就會
    // 說「不同步」。所以這一輪要寫出去的內容直接拿來算。
    hash.update(pending.get(rel) ?? readFileSync(path.join(ROOT, rel)));
  }
  const version = `onlinetools-${hash.digest("hex").slice(0, 12)}`;

  const block = "/* build:precache:start */\n"
    + `const CACHE_VERSION = ${JSON.stringify(version)};\n`
    + `const SHELL = [\n${files.map((f) => `  ${JSON.stringify(f)},`).join("\n")}\n];\n`
    + "/* build:precache:end */";

  const source = readFileSync(SW_JS, "utf8");
  const next = source.replace(
    /\/\* build:precache:start \*\/[\s\S]*?\/\* build:precache:end \*\//,
    () => block,
  );
  return { next, changed: next !== source, count: files.length };
}

/* ---------- 輸出 ---------- */

const entriesOut = `${JSON.stringify({ entries }, null, 2)}\n`;
const searchOut = `${JSON.stringify({ entries: searchDocs })}\n`;

const precache = buildPrecache(new Map([
  ["data/entries.json", entriesOut],
  ["data/search-index.json", searchOut],
]));

const readOrEmpty = (file) => {
  try { return readFileSync(file, "utf8").trim(); } catch { return ""; }
};
const changed =
  readOrEmpty(ENTRIES_JSON) !== entriesOut.trim() ||
  readOrEmpty(SEARCH_JSON) !== searchOut.trim() ||
  precache.changed;

for (const w of warnings) console.warn(`! ${w}`);

if (CHECK_ONLY) {
  if (changed) {
    console.error("x data/ 與 content/ 不同步, 請執行: node tools/build-data.mjs");
    process.exit(1);
  }
  console.log(`v ${entries.length} 筆內容, 資料已同步`);
} else {
  writeFileSync(ENTRIES_JSON, entriesOut);
  writeFileSync(SEARCH_JSON, searchOut);
  if (precache.changed) {
    writeFileSync(SW_JS, precache.next);
    console.log(`v 離線清單 ${precache.count} 個檔案 -> sw.js`);
  }
  const tools = entries.filter((doc) => doc.type === "tool").length;
  const kb = (Buffer.byteLength(searchOut) / 1024).toFixed(0);
  console.log(`v ${entries.length} 筆內容（工具 ${tools}、文檔 ${entries.length - tools}） -> data/entries.json`);
  console.log(`v 全文索引 ${kb} KB -> data/search-index.json`);
}
