// tools/lib.mjs — build-data 與 remove-entry 共用的讀取邏輯。
//
// 這些函式原本只住在 build-data.mjs 裡。刪除腳本要用同一套規則找檔案、
// 認檔頭、認工具佔位 —— 抄一份過去的話, 兩邊遲早會對不起來（改了一邊
// 忘了另一邊, 於是刪除腳本看到的世界跟建置看到的不一樣）, 所以搬出來共用。

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 必須與 js/utils/utils.js 的 slugify() 完全一致, 否則搜尋深連結會對不上。 */
export function slugify(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s/\\]+/g, "-")
    .replace(/[^\w一-鿿-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function walkMarkdown(dir) {
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
export function relPath(absolute) {
  return path.relative(ROOT, absolute).split(path.sep).join("/");
}

export function readJSON(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** 讀檔頭連續的 `<!-- key: value -->`；遇到第一個非註解、非空白行就停。 */
export function parseFrontmatter(source) {
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
export function stripFrontmatter(source) {
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
 * 內文裡出現過的工具 id, 依出現順序、不重複。
 * 程式碼區塊裡的要跳過 —— 說明文件會把佔位當範例寫出來, 那不是真的要掛工具。
 */
export function extractToolIds(body) {
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

/** 檔頭只寫檔名時, 封面圖從這裡找。 */
export const COVER_BASE = "assets/images/covers";

/** 封面: 完整路徑原樣用, 只寫檔名就補上 assets/images/covers/。 */
export function resolveCover(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (/^(https?:)?\/\//i.test(raw) || raw.startsWith("/") || raw.includes("/")) {
    return raw.replace(/^\.\//, "");
  }
  return `${COVER_BASE}/${raw}`;
}
