// tools/remove-entry.mjs — 刪掉一個工具或文檔, 連同只有它在用的檔案。
//
//   node tools/remove-entry.mjs                 列出全部, 選編號
//   node tools/remove-entry.mjs --list          只列出, 不問
//   node tools/remove-entry.mjs rail-map        直接指定（id、檔名或路徑都行）
//   node tools/remove-entry.mjs rail-map --dry-run   只印出會刪什麼, 不動手
//   node tools/remove-entry.mjs rail-map --yes       不問直接刪
//
// 為什麼需要這支:
//   一個工具散在好幾個地方 —— content/tools/x.md、js/tools/x/、可能還有封面圖
//   與只有它在用的資料檔, 刪完 data/ 與 sw.js 還要重建。手動刪很容易漏掉其中
//   一項, 而漏掉的那一項不會報錯: 它會變成離線清單裡指向不存在檔案的項目,
//   或是首頁上點下去 404 的卡片。
//
// 兩條原則:
//   1. 只刪「刪掉之後沒有人會再用到」的東西。共用模組、別的 .md 也在用的工具
//      模組一律留著, 而且會印出來說明為什麼留 —— 不讓人以為漏刪了。
//   2. 刪之前先把完整清單攤開。git 追不到的檔案特別標出來, 那些是真的回不來。

import { readFileSync, readdirSync, statSync, existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  ROOT, slugify, walkMarkdown, relPath, readJSON,
  parseFrontmatter, stripFrontmatter, extractToolIds, resolveCover, COVER_BASE,
} from "./lib.mjs";

/** 這支自己的原始碼: 註解裡舉例提到的路徑不算「有人在用」。 */
const SELF = relPath(fileURLToPath(import.meta.url));

const CONTENT_DIR = path.join(ROOT, "content");
const ENTRIES_JSON = path.join(ROOT, "data", "entries.json");

/** 找「還有誰在用」時要翻的地方。 */
const SCAN_DIRS = ["js", "css", "pages", "content", "data", "assets/templates"];
const SCAN_FILES = ["index.html", "manifest.webmanifest"];
const SCAN_EXT = [".js", ".mjs", ".css", ".html", ".json", ".md", ".webmanifest"];

/**
 * 這三個是產生出來的, 不能拿來當「有人在用」的證據 —— 它們裡面本來就一定
 * 有正要刪掉的那個 id, 把它們算進去的話, 每個工具都會看起來還有人在用。
 */
const GENERATED = new Set(["data/entries.json", "data/search-index.json", "sw.js"]);

const argv = process.argv.slice(2);
const FLAGS = new Set(argv.filter((a) => a.startsWith("-")));
const TARGETS = argv.filter((a) => !a.startsWith("-"));
const DRY_RUN = FLAGS.has("--dry-run") || FLAGS.has("-n");
const LIST_ONLY = FLAGS.has("--list") || FLAGS.has("-l");
const ASSUME_YES = FLAGS.has("--yes") || FLAGS.has("-y");

/* ============================ 小工具 ============================ */

const abs = (rel) => path.join(ROOT, rel.split("/").join(path.sep));

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/** 終端機是等寬的, 但中日韓字佔兩格 —— 不算進去表格就會歪掉。 */
function width(text) {
  let n = 0;
  for (const ch of String(text)) n += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return n;
}
const pad = (text, to) => String(text) + " ".repeat(Math.max(0, to - width(text)));

/** 一個路徑底下的所有檔案（檔案就回傳自己）。 */
function filesUnder(rel, out = []) {
  const full = abs(rel);
  if (!existsSync(full)) return out;
  if (!statSync(full).isDirectory()) { out.push(rel); return out; }
  for (const name of readdirSync(full).sort()) filesUnder(`${rel}/${name}`, out);
  return out;
}

const bytesUnder = (rel) =>
  filesUnder(rel).reduce((sum, f) => sum + (existsSync(abs(f)) ? statSync(abs(f)).size : 0), 0);

/**
 * 問一句。整支只開一個 readline —— 開兩個接同一個 stdin 的話, 關掉第一個時會
 * 把緩衝區裡還沒讀的輸入一起帶走, 第二個問題就永遠等不到答案。
 */
let rl = null;
async function prompt(question) {
  rl ??= createInterface({ input: process.stdin, output: process.stdout });
  return (await rl.question(question)).trim();
}
const endPrompt = () => { rl?.close(); rl = null; };

function git(args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

/* ============================ 現有的內容 ============================ */

/**
 * content/ 底下每一篇, 帶上它擁有的東西。
 *
 * id 以 data/entries.json 為準（那裡的 id 會沿用舊值, 跟檔名不一定一樣）,
 * 還沒建置過的新檔案才退回用檔名推。
 */
function collect() {
  const built = readJSON(ENTRIES_JSON, { entries: [] }).entries || [];
  const byPath = new Map(built.map((doc) => [doc.path, doc]));

  const list = walkMarkdown(CONTENT_DIR).map((file) => {
    const rel = relPath(file);
    const source = readFileSync(file, "utf8");
    const meta = parseFrontmatter(source);
    const prior = byPath.get(rel);
    const name = path.basename(file, ".md");
    return {
      md: rel,
      id: prior?.id || slugify(name),
      title: prior?.title || meta.title || name,
      type: prior?.type || (rel.startsWith("content/tools/") ? "tool" : "doc"),
      toolIds: extractToolIds(stripFrontmatter(source)),
      cover: prior?.cover || resolveCover(meta.cover || meta["cover image"]),
      built: Boolean(prior),
    };
  });

  list.sort((a, b) =>
    (a.type === b.type ? 0 : a.type === "tool" ? -1 : 1)
    || a.id.localeCompare(b.id, "en"));
  return list;
}

function printList(all) {
  const w = {
    n: String(all.length).length,
    id: Math.max(...all.map((e) => width(e.id)), 2),
    title: Math.max(...all.map((e) => width(e.title)), 4),
    md: Math.max(...all.map((e) => width(e.md)), 4),
  };
  console.log("");
  all.forEach((entry, i) => {
    const tools = entry.toolIds.length ? `  ${entry.toolIds.map((t) => `js/tools/${t}/`).join(" ")}` : "";
    const line = `  ${String(i + 1).padStart(w.n)}. ${entry.type === "tool" ? "工具" : "文檔"}  `
      + `${pad(entry.id, w.id)}  ${pad(entry.title, w.title)}  ${pad(entry.md, w.md)}${tools}`
      + (entry.built ? "" : "  (還沒建置)");
    console.log(line.trimEnd());
  });
  console.log("");
}

/** 把使用者打的東西對回項目: 編號、id、檔名、路徑都接受。 */
function match(all, token) {
  const raw = token.trim();
  const asNumber = Number(raw);
  if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= all.length) return all[asNumber - 1];

  const key = raw.toLowerCase().replace(/\\/g, "/").replace(/\.md$/, "");
  return all.find((entry) =>
    entry.id.toLowerCase() === key
    || entry.md.toLowerCase().replace(/\.md$/, "") === key
    || path.basename(entry.md, ".md").toLowerCase() === key) || null;
}

function selectionFrom(all, tokens) {
  const picked = [];
  for (const token of tokens) {
    const hit = match(all, token);
    if (!hit) {
      console.error(`x 找不到「${token}」。可用的 id: ${all.map((e) => e.id).join(", ")}`);
      process.exit(1);
    }
    if (!picked.includes(hit)) picked.push(hit);
  }
  return picked;
}

/* ============================ 還有誰在用 ============================ */

/**
 * 把可以搜的原始檔讀進來一次。
 * @param {string[]} skip 這些路徑（含其底下）不算 —— 它們正要被刪掉。
 * @param {string[]} extraDirs 額外要翻的資料夾。
 */
function loadSources(skip, extraDirs = []) {
  const out = [];
  const blocked = (rel) => skip.some((s) => rel === s || rel.startsWith(`${s}/`));

  const take = (rel) => {
    if (blocked(rel) || GENERATED.has(rel)) return;
    if (!SCAN_EXT.includes(path.extname(rel))) return;
    out.push({ rel, text: readFileSync(abs(rel), "utf8") });
  };
  for (const dir of [...SCAN_DIRS, ...extraDirs]) for (const rel of filesUnder(dir)) take(rel);
  for (const rel of SCAN_FILES) if (existsSync(abs(rel))) take(rel);
  return out;
}

const usedBy = (sources, needle) => sources.filter((s) => s.text.includes(needle)).map((s) => s.rel);

/** 工具資料夾裡指到外面的相對路徑（`../../../data/rail-network.json` 那種）。 */
function outsideRefs(dirs) {
  const found = new Set();
  for (const dir of dirs) {
    for (const rel of filesUnder(dir)) {
      if (!SCAN_EXT.includes(path.extname(rel))) continue;
      for (const m of readFileSync(abs(rel), "utf8").matchAll(/\.\.\/\.\.\/\.\.\/([\w./-]+)/g)) {
        const target = m[1].replace(/\/+$/, "");
        if (target && existsSync(abs(target))) found.add(target);
      }
    }
  }
  return [...found].sort();
}

/* ============================ 盤點 ============================ */

function planRemoval(picked, all) {
  const remaining = all.filter((entry) => !picked.includes(entry));
  const removals = [];   // 要刪的
  const keeps = [];      // 本來以為要刪, 但別人還在用
  const notes = [];      // 不刪, 只是提醒

  for (const entry of picked) removals.push({ rel: entry.md, kind: "file" });

  /* --- 工具模組 --- */
  const stillWanted = new Set(remaining.flatMap((entry) => entry.toolIds));
  const removedDirs = [];
  for (const id of new Set(picked.flatMap((entry) => entry.toolIds))) {
    const dir = `js/tools/${id}`;
    if (!existsSync(abs(dir))) continue;
    if (stillWanted.has(id)) {
      const who = remaining.filter((e) => e.toolIds.includes(id)).map((e) => e.md);
      keeps.push({ rel: `${dir}/`, why: `${who.join("、")} 還在用` });
    } else {
      removals.push({ rel: dir, kind: "dir" });
      removedDirs.push(dir);
    }
  }

  /* --- 封面圖 --- */
  const coversKept = new Set(remaining.map((entry) => entry.cover).filter(Boolean));
  for (const cover of new Set(picked.map((entry) => entry.cover).filter(Boolean))) {
    if (!cover.startsWith(`${COVER_BASE}/`) || !existsSync(abs(cover))) continue;
    if (coversKept.has(cover)) keeps.push({ rel: cover, why: "別的內容也用同一張封面" });
    else removals.push({ rel: cover, kind: "file" });
  }

  const sources = loadSources(removals.map((r) => r.rel));

  /* --- 刪完之後沒人用的共用模組 --- */
  for (const name of readdirSync(abs("js/tools")).sort()) {
    const rel = `js/tools/${name}`;
    if (statSync(abs(rel)).isDirectory() || path.extname(name) !== ".js") continue;
    // 自己的檔頭註解就寫著自己的路徑, 不排掉的話永遠看起來有人在用。
    const importers = usedBy(sources, `/${name}`).filter((who) => who !== rel);
    if (!importers.length) {
      notes.push(`js/tools/${name} 之後就沒有工具在用了, 可以一起刪`);
    }
  }

  /* --- 工具資料夾指到外面的檔案 --- */
  // 比對用整條路徑而不是檔名: 檔名太容易誤中（"index.json" 會撞到
  // "search-index.json", "templates" 會撞到 md2docs 的版型模板）, 而任何
  // 相對寫法 —— ../../../data/x.json、../assets/x.svg —— 都含有整條路徑。
  const orphans = outsideRefs(removedDirs)
    .filter((target) => !removals.some((r) => r.rel === target))
    .filter((target) => !usedBy(sources, target).length);
  for (const target of orphans) {
    // 整個資料夾都沒人用時就只講資料夾, 不必把裡面每個檔案再講一次。
    if (orphans.some((other) => other !== target && target.startsWith(`${other}/`))) continue;
    // 建置腳本不算「網站在用」, 但提到它的那幾支值得一起看一眼。
    const scripts = usedBy(loadSources([], ["tools"]), target)
      .filter((rel) => rel.startsWith("tools/") && rel !== SELF);
    notes.push(`${target} 只有這次刪掉的工具在用, 可以一起刪`
      + (scripts.length ? `（${scripts.join("、")} 也提到它）` : ""));
  }

  /* --- 還有誰連過來 --- */
  for (const entry of picked) {
    const base = path.basename(entry.md);
    for (const source of sources) {
      if (!source.rel.endsWith(".md")) continue;
      if (source.text.includes(`id=${entry.id}`) || source.text.includes(`](${base}`)) {
        notes.push(`${source.rel} 裡有連到「${entry.title}」的連結, 會變成死連結`);
      }
    }
  }

  /* --- git 救不救得回來 --- */
  const status = git(["status", "--porcelain", "--untracked-files=all", "--", ...removals.map((r) => r.rel)]);
  const untracked = [];
  const dirty = [];
  for (const line of status.split("\n").filter(Boolean)) {
    const file = line.slice(3).trim().replace(/^"|"$/g, "");
    (line.startsWith("??") ? untracked : dirty).push(file);
  }
  if (untracked.length) {
    notes.push(`這些檔案還沒進過 git, 刪掉救不回來: ${untracked.slice(0, 6).join(", ")}`
      + (untracked.length > 6 ? ` …共 ${untracked.length} 個` : ""));
  }
  if (dirty.length) {
    notes.push(`這些檔案有未提交的修改, 那些修改會一起消失: ${dirty.slice(0, 6).join(", ")}`
      + (dirty.length > 6 ? ` …共 ${dirty.length} 個` : ""));
  }

  return { removals, keeps, notes };
}

function printPlan(picked, plan) {
  console.log(`\n要刪掉「${picked.map((e) => e.title).join("」「")}」。\n`);

  const widest = Math.max(...plan.removals.map((r) => width(r.rel) + (r.kind === "dir" ? 1 : 0)));
  console.log("會刪掉:");
  for (const item of plan.removals) {
    const label = item.kind === "dir" ? `${item.rel}/` : item.rel;
    const count = item.kind === "dir" ? `${filesUnder(item.rel).length} 個檔案 · ` : "";
    console.log(`  ${pad(label, widest + 2)}${count}${formatBytes(bytesUnder(item.rel))}`);
  }

  if (plan.keeps.length) {
    console.log("\n會留著:");
    for (const item of plan.keeps) console.log(`  ${item.rel}  —— ${item.why}`);
  }
  if (plan.notes.length) {
    console.log("");
    for (const note of plan.notes) console.log(`! ${note}`);
  }
  console.log("\n刪完會自動跑一次 node tools/build-data.mjs, 把 data/ 與 sw.js 的離線清單補上。");
}

/* ============================ 動手 ============================ */

function apply(plan) {
  for (const item of plan.removals) {
    const full = abs(item.rel);
    // 護欄: 只能刪 ROOT 底下的東西, 而且資料夾只能是 js/tools/<id>。
    if (!full.startsWith(ROOT + path.sep)) throw new Error(`拒絕刪除 ${item.rel}: 不在專案裡`);
    if (item.kind === "dir" && !/^js\/tools\/[^/]+$/.test(item.rel)) {
      throw new Error(`拒絕刪除資料夾 ${item.rel}: 只允許 js/tools/<id>`);
    }
    rmSync(full, { recursive: item.kind === "dir", force: true });
    console.log(`v 已刪除 ${item.rel}${item.kind === "dir" ? "/" : ""}`);
  }
  console.log("");
  execFileSync(process.execPath, [path.join(ROOT, "tools", "build-data.mjs")], { cwd: ROOT, stdio: "inherit" });
}

/* ============================ 主流程 ============================ */

const all = collect();
if (!all.length) {
  console.error("x content/ 底下沒有任何 .md");
  process.exit(1);
}

if (LIST_ONLY) {
  printList(all);
  process.exit(0);
}

let picked;
if (TARGETS.length) {
  picked = selectionFrom(all, TARGETS);
} else if (!process.stdin.isTTY) {
  console.error("x 非互動環境請直接指定要刪的 id, 例如: node tools/remove-entry.mjs rail-map（--list 可以看有哪些）");
  process.exit(1);
} else {
  printList(all);
  const answer = await prompt("要刪掉哪些？（編號或 id, 逗號分隔多個；直接 Enter 取消）: ");
  const tokens = answer.split(/[,\s、]+/).filter(Boolean);
  if (!tokens.length) {
    endPrompt();
    console.log("沒有刪除任何東西。");
    process.exit(0);
  }
  picked = selectionFrom(all, tokens);
}

const plan = planRemoval(picked, all);
printPlan(picked, plan);

if (DRY_RUN) {
  endPrompt();
  console.log("\n（--dry-run, 什麼都沒動）");
  process.exit(0);
}

if (!ASSUME_YES) {
  if (!process.stdin.isTTY) {
    console.error("\nx 非互動環境要刪除請加 --yes");
    process.exit(1);
  }
  const ok = await prompt("\n確定刪除？(y/N): ");
  if (!/^y(es)?$/i.test(ok.trim())) {
    endPrompt();
    console.log("沒有刪除任何東西。");
    process.exit(0);
  }
}

console.log("");
endPrompt();
apply(plan);
