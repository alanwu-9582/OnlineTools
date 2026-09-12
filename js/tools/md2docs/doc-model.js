// js/tools/md2docs/doc-model.js — Markdown → 中性的文件模型。
//
// 為什麼要多一層模型, 不直接 Markdown → DOCX:
// 輸出有兩條路（.docx 與列印用的 HTML）, 兩條都要套同一套模板規則。
// 中間夾一層之後, 章節編號、圖表編號、分頁指令這些「內容上的決定」
// 只做一次, 兩邊看到的是同一份已經編好號的資料, 不會一邊有編號一邊沒有。
//
// 斷詞用的是站上本來就在載的 marked（entry.js 渲染每一篇內容都靠它）,
// 所以這裡沒有新增任何依賴, 也不必自己寫一個一定會有出入的 Markdown 解析器。
// 只用它的 lexer 拿 token, 不用它的 renderer —— 我們要的不是 HTML。
//
// 區塊的形狀:
//   {kind:"heading", level, text, inlines, number, id}
//   {kind:"para",    inlines}
//   {kind:"list",    ordered, start, items:[{blocks}]}
//   {kind:"code",    lang, text}
//   {kind:"quote",   blocks}
//   {kind:"table",   header:[cell], rows:[[cell]], align, number}   cell = {inlines}
//   {kind:"figure",  src, alt, title, number}
//   {kind:"math",    tex}                      獨立成行的公式
//   {kind:"mermaid", text, hint, number}       流程圖
//   {kind:"hr"} {kind:"pagebreak"}
//
// 行內的形狀（一律攤平成一串 run, 巢狀的粗體斜體會併成同一個 run 的旗標）:
//   {text, bold, italic, code, strike, sup, sub, href}
//   {image:{src, alt, title}}  {math:"tex"}  {br:true}

import { PAGEBREAK_MARK } from "./meta.js";

/** marked 的 token 會把文字先 HTML 轉義, 但我們要的是純文字。 */
function unesc(value) {
  return String(value ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/* ============================ 行內 ============================ */

/**
 * `10^3^` —— Markdown 沒有上標語法, 但理工報告一定會用到。
 * 只認「成對、開頭不是空白」的形式, 落單的 ^ 不會被吃掉。
 * 下標 `H~2~O` 不在這裡: 單波浪已經被 marked 當成 GFM 刪除線收走了,
 * 改在 del 那一支判斷（見 inlineRuns）。
 */
function splitScripts(run) {
  if (run.code || !run.text || !run.text.includes("^")) return [run];
  const out = [];
  const pattern = /\^(?=\S)([^\s^]{1,24}?)\^/g;
  let last = 0;
  let m;
  while ((m = pattern.exec(run.text))) {
    if (m.index > last) out.push({ ...run, text: run.text.slice(last, m.index) });
    out.push({ ...run, text: m[1], sup: true });
    last = pattern.lastIndex;
  }
  if (!out.length) return [run];
  if (last < run.text.length) out.push({ ...run, text: run.text.slice(last) });
  return out;
}

/**
 * 行內公式 `$…$` 與 `\(…\)`。
 *
 * `$` 在 Markdown 裡沒有意義, 所以 marked 會原樣留在文字裡, 由這裡挑出來。
 * 兩個條件擋掉金額被誤判成公式: 開頭的 `$` 後面不能是空白、結尾的 `$` 前面
 * 也不能是空白 —— 「$100 與 $200」中間那一段是以空白結尾的, 不會成對。
 * 真的要寫錢的時候用 `\$`。
 */
function splitMath(run) {
  if (run.code || !run.text || !/[$\\]/.test(run.text)) return [run];
  const out = [];
  const pattern = /\$\$([\s\S]+?)\$\$|\$(?!\s)((?:[^$\n\\]|\\.)+?)(?<!\s)\$|\\\(([\s\S]+?)\\\)/g;
  let last = 0;
  let m;
  while ((m = pattern.exec(run.text))) {
    if (m.index > last) out.push({ ...run, text: run.text.slice(last, m.index) });
    out.push({ math: (m[1] ?? m[2] ?? m[3]).trim() });
    last = pattern.lastIndex;
  }
  if (!out.length) return [run];
  if (last < run.text.length) out.push({ ...run, text: run.text.slice(last) });
  return out;
}

/** 把 marked 的行內 token 攤平成一串 run。style 是往下傳的旗標。 */
function inlineRuns(tokens, style = {}) {
  const out = [];
  for (const t of tokens || []) {
    switch (t.type) {
      case "strong": out.push(...inlineRuns(t.tokens, { ...style, bold: true })); break;
      case "em": out.push(...inlineRuns(t.tokens, { ...style, italic: true })); break;
      case "del":
        // GFM 把 ~單波浪~ 也算刪除線, 但理工報告寫 σ~UTS~ 要的是下標。
        // 兩個波浪才是刪除線, 一個就是下標 —— 從 raw 分得出來。
        out.push(...inlineRuns(t.tokens, String(t.raw || "").startsWith("~~")
          ? { ...style, strike: true }
          : { ...style, sub: true }));
        break;
      case "link":
        out.push(...inlineRuns(t.tokens, { ...style, href: String(t.href || "") }));
        break;
      case "image":
        out.push({ image: { src: String(t.href || ""), alt: unesc(t.text), title: unesc(t.title) } });
        break;
      case "codespan": out.push({ ...style, code: true, text: unesc(t.text) }); break;
      case "br": out.push({ br: true }); break;
      case "escape":
      case "text":
        // 巢狀的 text token（例如連結內文）自己還帶著 tokens, 要再往下拆。
        if (t.tokens) out.push(...inlineRuns(t.tokens, style));
        else out.push(...plainRuns(style, unesc(t.text)));
        break;
      case "html": break; // 內文裡的原生 HTML 對書面報告沒有意義, 直接丟掉
      default:
        if (t.tokens) out.push(...inlineRuns(t.tokens, style));
        else if (t.text != null) out.push(...plainRuns(style, unesc(t.text)));
    }
  }
  return out.filter((r) => r.image || r.br || r.math || r.text !== "");
}

/** 一段純文字 → 公式、上標、剩下的文字。 */
function plainRuns(style, text) {
  return splitMath({ ...style, text })
    .flatMap((run) => (run.math ? [run] : splitScripts(run)));
}

/** 這串 run 只有一張圖（可能前後有空白）→ 當成獨立的插圖而不是段落。 */
function loneImage(runs) {
  const solid = runs.filter((r) => !(r.text != null && !r.text.trim()));
  return solid.length === 1 && solid[0].image ? solid[0].image : null;
}

export function runsToText(runs) {
  return (runs || []).map((r) => {
    if (r.br) return " ";
    if (r.image) return r.image.alt || "";
    if (r.math) return r.math;
    return r.text || "";
  }).join("");
}

/* ============================ 區塊 ============================ */

function cell(c) {
  return { inlines: inlineRuns(c.tokens) };
}

function walk(tokens, out) {
  for (const t of tokens || []) {
    switch (t.type) {
      case "space":
      case "def":
        break;
      case "heading":
        out.push({ kind: "heading", level: t.depth, inlines: inlineRuns(t.tokens) });
        break;
      case "hr":
        out.push({ kind: "hr" });
        break;
      case "code": {
        // 圍籬的資訊字串第一個詞是語言, 後面當成尺寸指令（```mermaid =60%）。
        const info = String(t.lang || "").trim().split(/\s+/);
        const lang = info[0].toLowerCase();
        const hint = info.slice(1).join(" ");
        const text = String(t.text ?? "");
        if (lang === "mermaid") out.push({ kind: "mermaid", text, hint });
        else if (lang === "math" || lang === "latex" || lang === "tex") {
          out.push({ kind: "math", tex: text.trim() });
        } else out.push({ kind: "code", lang: info[0], text });
        break;
      }
      case "blockquote": {
        const inner = [];
        walk(t.tokens, inner);
        out.push({ kind: "quote", blocks: inner });
        break;
      }
      case "table":
        out.push({
          kind: "table",
          align: (t.align || []).map((a) => a || "left"),
          header: (t.header || []).map(cell),
          rows: (t.rows || []).map((r) => r.map(cell)),
        });
        break;
      case "list":
        out.push({
          kind: "list",
          ordered: !!t.ordered,
          start: Number(t.start) || 1,
          items: (t.items || []).map((item) => {
            const inner = [];
            walk(item.tokens, inner);
            const blocks = inner.length ? inner : [{ kind: "para", inlines: [] }];
            // `- [x] 做完了` —— marked 把方框拿掉只留文字, 交給渲染端自己補。
            // 我們補在模型上, 預覽與 .docx 就都不用各寫一次。
            if (item.task) {
              const first = blocks.find((b) => b.inlines);
              if (first) first.inlines.unshift({ text: item.checked ? "☑ " : "☐ " });
            }
            return { blocks, task: !!item.task, checked: !!item.checked };
          }),
        });
        break;
      case "html":
        break;
      case "paragraph":
      case "text": {
        const raw = String(t.text ?? "");
        if (raw.includes(PAGEBREAK_MARK)) { out.push({ kind: "pagebreak" }); break; }
        // 整段就是一條 $$…$$ 或 \[…\] → 獨立成行的公式, 不是段落裡的行內公式。
        const display = raw.trim().match(/^\$\$([\s\S]+)\$\$$|^\\\[([\s\S]+)\\\]$/);
        if (display) {
          out.push({ kind: "math", tex: (display[1] ?? display[2]).trim() });
          break;
        }
        const runs = inlineRuns(t.tokens || [{ type: "text", text: raw }]);
        if (!runs.length) break;
        const img = loneImage(runs);
        if (img) out.push({ kind: "figure", ...img });
        else out.push({ kind: "para", inlines: runs });
        break;
      }
      default:
        if (t.tokens) walk(t.tokens, out);
    }
  }
  return out;
}

/**
 * 表格與流程圖的說明。
 *
 * Markdown 的表格與 ```mermaid 都沒有標題語法, 但書面報告的表一定要有
 * 「表 1　各組硬度」。約定: 它正上方那一段, 如果整段都是粗體, 就當成說明收進去。
 * 選粗體是因為大家本來就會那樣寫, 而且在 GitHub 之類的地方看起來仍然正常 ——
 * 不必為了這個工具在 .md 裡留下奇怪的記號。
 */
function absorbTableCaptions(blocks) {
  const out = [];
  for (const block of blocks) {
    const prev = out[out.length - 1];
    if ((block.kind === "table" || block.kind === "mermaid") && prev?.kind === "para") {
      const runs = prev.inlines.filter((r) => r.text !== undefined);
      const allBold = runs.length > 0 && runs.every((r) => r.bold) && runs.length === prev.inlines.length;
      if (allBold) {
        block.caption = runsToText(prev.inlines).trim();
        out.pop();
      }
    }
    out.push(block);
  }
  return out;
}

/* ============================ 編號 ============================ */

const ZH_DIGITS = "〇一二三四五六七八九";

/** 1 → 一、15 → 十五、203 → 二百〇三。章節編號夠用, 不做萬以上。 */
export function zhNumber(n) {
  const v = Math.floor(Number(n) || 0);
  if (v <= 0) return String(v);
  if (v < 10) return ZH_DIGITS[v];
  if (v < 20) return `十${v % 10 ? ZH_DIGITS[v % 10] : ""}`;
  if (v < 100) {
    const t = Math.floor(v / 10);
    return `${ZH_DIGITS[t]}十${v % 10 ? ZH_DIGITS[v % 10] : ""}`;
  }
  const h = Math.floor(v / 100);
  const rest = v % 100;
  if (!rest) return `${ZH_DIGITS[h]}百`;
  if (rest < 10) return `${ZH_DIGITS[h]}百〇${ZH_DIGITS[rest]}`;
  return `${ZH_DIGITS[h]}百${zhNumber(rest)}`;
}

/** 1 → i、4 → iv。目錄前置頁的頁碼用。 */
export function roman(n, upper = false) {
  const table = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
    [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  let v = Math.max(0, Math.floor(Number(n) || 0));
  let out = "";
  for (const [value, sym] of table) while (v >= value) { out += sym; v -= value; }
  return upper ? out.toUpperCase() : out;
}

/** 1 → a、27 → aa。 */
function alpha(n, upper = false) {
  let v = Math.max(1, Math.floor(Number(n) || 1));
  let out = "";
  while (v > 0) { out = String.fromCharCode(97 + ((v - 1) % 26)) + out; v = Math.floor((v - 1) / 26); }
  return upper ? out.toUpperCase() : out;
}

/**
 * 套用一個編號樣板。
 *   {n} 阿拉伯數字   {N} 中文數字   {a}/{A} 英文字母
 *   {i}/{I} 羅馬數字  {p} 含上層的點分式（1.2.3）
 */
function formatNumber(pattern, counters, level, from) {
  const n = counters[level];
  const path = counters.slice(from, level + 1).join(".");
  return String(pattern)
    .replace(/\{n\}/g, String(n))
    .replace(/\{N\}/g, zhNumber(n))
    .replace(/\{a\}/g, alpha(n))
    .replace(/\{A\}/g, alpha(n, true))
    .replace(/\{i\}/g, roman(n))
    .replace(/\{I\}/g, roman(n, true))
    .replace(/\{p\}/g, path);
}

/**
 * 給每個標題編號、每個標題一個 id, 順便編圖表號。
 *
 * 編號是「寫進標題文字裡」而不是交給 Word 的多層次清單:
 * Word 的清單編號跟樣式綁在一起, 使用者只要動到樣式就整份跑掉,
 * 而且目錄、內文、預覽三邊要各自重算一次很容易對不上。寫死之後三邊一定一致。
 *
 * @param {Array} blocks
 * @param {{numbering:string[], captions:{figure:string, table:string}}} tpl
 */
export function numberDocument(blocks, tpl) {
  const patterns = tpl.numbering || [];
  const found = patterns.findIndex((p) => p);
  const from = found < 0 ? 0 : found; // 第一個有編號的層級
  const counters = [0, 0, 0, 0, 0, 0];
  let chapter = 0;
  let figure = 0;
  let table = 0;
  const figPattern = tpl.captions?.figure ?? "";
  const tabPattern = tpl.captions?.table ?? "";
  const perChapter = /\{c\}/.test(figPattern) || /\{c\}/.test(tabPattern);
  let index = 0;

  const visit = (list) => {
    for (const b of list) {
      if (b.kind === "heading") {
        const lv = Math.min(6, Math.max(1, b.level)) - 1;
        counters[lv] += 1;
        for (let i = lv + 1; i < counters.length; i += 1) counters[i] = 0;
        if (lv === from) {
          chapter += 1;
          if (perChapter) { figure = 0; table = 0; }
        }
        b.id = `md2-h${index}`;
        b.text = runsToText(b.inlines);
        const pattern = patterns[lv];
        b.number = pattern ? formatNumber(pattern, counters, lv, from) : "";
        index += 1;
      } else if ((b.kind === "figure" || b.kind === "mermaid") && figPattern) {
        // 流程圖跟照片一起編號: 報告裡它們都是「圖」。
        figure += 1;
        b.number = figPattern.replace(/\{c\}/g, String(chapter || 1)).replace(/\{n\}/g, String(figure));
      } else if (b.kind === "table" && tabPattern) {
        table += 1;
        b.number = tabPattern.replace(/\{c\}/g, String(chapter || 1)).replace(/\{n\}/g, String(table));
      }
      if (b.blocks) visit(b.blocks);
      if (b.items) for (const item of b.items) visit(item.blocks);
    }
  };
  visit(blocks);
  return blocks;
}

/** 目錄要收的標題。depth 是最深收到第幾層。 */
export function outlineOf(blocks, depth = 3) {
  return blocks
    .filter((b) => b.kind === "heading" && b.level <= depth)
    .map((b) => ({ id: b.id, level: b.level, number: b.number, text: b.text }));
}

/**
 * Markdown 原始字串 → 已編號的區塊陣列。
 * @param {string} body 已經被 extractMeta() 拿掉封面註解的內文
 * @param {object} tpl  模板（只用到編號設定）
 */
export function buildDocument(body, tpl) {
  if (!window.marked?.lexer) throw new Error("Markdown 函式庫尚未載入");
  const tokens = window.marked.lexer(String(body ?? ""), { gfm: true, breaks: false });
  return numberDocument(absorbTableCaptions(walk(tokens, [])), tpl);
}
