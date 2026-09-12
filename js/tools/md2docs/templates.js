// js/tools/md2docs/templates.js — 排版模板。
//
// 一份模板就是一個純 JSON 物件, 沒有程式碼。這是整個工具能「適配每個老師」的關鍵:
// 老師的要求永遠是「標楷體 14 級、1.5 倍行高、章節用第一章、頁碼置中」這種
// 一條一條的規定, 把它們攤成資料之後, 換一個老師就是換一個 JSON,
// 而不是改一次程式。使用者可以在工具裡直接改, 也可以存起來下次再用。
//
// 單位固定: 頁面與邊界 mm、字級 pt、行高是倍數、段距 pt。
// 兩條輸出（.docx 與列印用的 HTML）讀的是同一份模板, 所以改一個數字兩邊一起動。

/** 每一層標題的預設值, 讓模板只需要寫自己真的要改的欄位。 */
const HEADING_DEFAULT = {
  size: 14, bold: true, align: "left", line: 1.5,
  before: 12, after: 6, breakBefore: false, cjk: "", latin: "",
};

const BASE = {
  id: "base",
  name: "",
  note: "",
  page: { width: 210, height: 297, margin: [25.4, 25.4, 25.4, 25.4] },
  fonts: {
    cjk: "標楷體", latin: "Times New Roman", mono: "Consolas",
    headingCjk: "", headingLatin: "",
  },
  body: { size: 12, line: 1.5, indent: 2, before: 0, after: 0, align: "both" },
  headings: [],
  numbering: ["", "", "", "", "", ""],
  cover: {
    enabled: true, align: "center", dateFormat: "zh", rule: false, fields: [],
  },
  toc: { enabled: true, title: "目　錄", depth: 3, leader: "dot", pageNumbers: true, indent: 2 },
  sections: { frontMatter: "roman" },
  header: { text: "", align: "right", size: 9 },
  footer: { text: "{page}", align: "center", size: 10.5 },
  captions: {
    figure: "圖 {n}　", table: "表 {n}　",
    figurePos: "below", tablePos: "above", size: 10.5, align: "center",
  },
  table: { size: 10.5, headerBold: true, headerFill: "F2F2F2", border: "all", align: "center" },
  // pad / gap 是「框線離文字多遠」, 單位 pt。Word 的段落框線用 w:space 表示同一件事,
  // 而它的上限是 31pt, 所以這兩個值也夾在同一個範圍, 兩邊才畫得出一樣的位置。
  code: { size: 9.5, fill: "F6F6F6", border: true, pad: 8 },
  quote: { indent: 4, italic: false, bar: true, gap: 8 },
  list: { indent: 2, gap: 0 },
};

/* ============================ 內建模板 ============================ */

/** 台灣大專院校最常見的那一種要求。 */
const REPORT = {
  id: "report",
  name: "標準書面報告",
  note: "標楷體、1.5 倍行高、首行縮排兩字元, 章節用「第一章／一、／(一)」。多數課堂報告直接用這個。",
  page: { width: 210, height: 297, margin: [25.4, 25.4, 25.4, 30] },
  body: { size: 12, line: 1.5, indent: 2, before: 0, after: 0, align: "both" },
  headings: [
    { size: 18, align: "center", before: 0, after: 12, breakBefore: true },
    { size: 15, before: 12, after: 6 },
    { size: 13, before: 9, after: 4 },
    { size: 12, before: 6, after: 3 },
    { size: 12, before: 6, after: 3, bold: false },
    { size: 12, before: 6, after: 3, bold: false },
  ],
  numbering: ["第{N}章　", "{N}、", "（{N}）", "{n}. ", "", ""],
  cover: {
    enabled: true, align: "center", dateFormat: "zh", rule: true,
    fields: [
      { key: "school", size: 20, bold: true, gap: 0 },
      { key: "department", size: 16, gap: 4 },
      { key: "course", size: 16, gap: 28 },
      { key: "title", size: 28, bold: true, gap: 36 },
      { key: "subtitle", size: 16, gap: 8 },
      { key: "instructor", size: 14, prefix: "指導老師：", gap: 44 },
      { key: "className", size: 14, prefix: "班　　級：", gap: 6 },
      { key: "group", size: 14, prefix: "組　　別：", gap: 6 },
      { key: "studentId", size: 14, prefix: "學　　號：", gap: 6 },
      { key: "author", size: 14, prefix: "姓　　名：", gap: 6 },
      { key: "date", size: 14, gap: 36 },
    ],
  },
  toc: { enabled: true, title: "目　錄", depth: 3, leader: "dot", pageNumbers: true, indent: 2 },
};

/** 論文／專題報告: 章節走 1 / 1.1 / 1.1.1, 前置頁用羅馬數字。 */
const THESIS = {
  id: "thesis",
  name: "論文／專題報告",
  note: "章節編號 1 / 1.1 / 1.1.1, 每章另起一頁, 目錄前置頁用羅馬數字頁碼, 圖表號跟著章走（圖 2-1）。",
  page: { width: 210, height: 297, margin: [25.4, 25.4, 25.4, 30] },
  fonts: { cjk: "標楷體", latin: "Times New Roman", mono: "Consolas", headingCjk: "標楷體", headingLatin: "Times New Roman" },
  body: { size: 12, line: 2, indent: 2, before: 0, after: 0, align: "both" },
  headings: [
    { size: 16, align: "center", before: 0, after: 18, breakBefore: true, line: 1.5 },
    { size: 14, before: 14, after: 8, line: 1.5 },
    { size: 12, before: 10, after: 6, line: 1.5 },
    { size: 12, before: 8, after: 4, line: 1.5, bold: false },
    { size: 12, before: 6, after: 3, line: 1.5, bold: false },
    { size: 12, before: 6, after: 3, line: 1.5, bold: false },
  ],
  numbering: ["第{N}章　", "{p} ", "{p} ", "{p} ", "", ""],
  cover: {
    enabled: true, align: "center", dateFormat: "roc", rule: false,
    fields: [
      { key: "school", size: 22, bold: true, gap: 0 },
      { key: "department", size: 18, gap: 6 },
      { key: "docType", size: 16, gap: 6 },
      { key: "title", size: 26, bold: true, gap: 48 },
      { key: "subtitle", size: 18, gap: 10 },
      { key: "instructor", size: 15, prefix: "指導教授：", gap: 60 },
      { key: "author", size: 15, prefix: "研 究 生：", gap: 8 },
      { key: "studentId", size: 15, prefix: "學　　號：", gap: 8 },
      { key: "date", size: 15, gap: 40 },
    ],
  },
  toc: { enabled: true, title: "目　錄", depth: 3, leader: "dot", pageNumbers: true, indent: 2 },
  sections: { frontMatter: "roman" },
  captions: {
    figure: "圖 {c}-{n}　", table: "表 {c}-{n}　",
    figurePos: "below", tablePos: "above", size: 10.5, align: "center",
  },
  table: { size: 11, headerBold: true, headerFill: "", border: "threeline", align: "center" },
};

/** 英文課程用的報告。行高兩倍、首行縮排半吋、頁碼在右上。 */
const APA = {
  id: "apa",
  name: "English report",
  note: "Times New Roman 12pt、double spaced、1 吋邊界、首行縮排 0.5 吋, 頁碼在右上角。寫英文報告用這個。",
  page: { width: 215.9, height: 279.4, margin: [25.4, 25.4, 25.4, 25.4] },
  fonts: { cjk: "Times New Roman", latin: "Times New Roman", mono: "Courier New", headingCjk: "", headingLatin: "" },
  body: { size: 12, line: 2, indent: 2, before: 0, after: 0, align: "left" },
  headings: [
    { size: 12, align: "center", before: 0, after: 0, line: 2 },
    { size: 12, align: "left", before: 0, after: 0, line: 2 },
    { size: 12, align: "left", before: 0, after: 0, line: 2 },
    { size: 12, align: "left", before: 0, after: 0, line: 2, bold: false },
    { size: 12, align: "left", before: 0, after: 0, line: 2, bold: false },
    { size: 12, align: "left", before: 0, after: 0, line: 2, bold: false },
  ],
  numbering: ["", "", "", "", "", ""],
  cover: {
    enabled: true, align: "center", dateFormat: "en", rule: false,
    fields: [
      { key: "title", size: 14, bold: true, gap: 90 },
      { key: "subtitle", size: 12, gap: 8 },
      { key: "author", size: 12, gap: 24 },
      { key: "department", size: 12, gap: 6 },
      { key: "course", size: 12, gap: 6 },
      { key: "instructor", size: 12, gap: 6 },
      { key: "date", size: 12, gap: 6 },
    ],
  },
  toc: { enabled: true, title: "Contents", depth: 3, leader: "dot", pageNumbers: true, indent: 2 },
  sections: { frontMatter: "roman" },
  header: { text: "{page}", align: "right", size: 12 },
  footer: { text: "", align: "center", size: 10 },
  captions: {
    figure: "Figure {n}. ", table: "Table {n}. ",
    figurePos: "below", tablePos: "above", size: 11, align: "left",
  },
  table: { size: 11, headerBold: true, headerFill: "", border: "threeline", align: "left" },
};

/** 不想要「公文感」的時候: 無縮排、段落之間留白、正黑體。 */
const CLEAN = {
  id: "clean",
  name: "簡潔現代",
  note: "微軟正黑體、段落之間留白、不縮排, 章節用 1 / 1.1。看起來像一份文件而不是公文。",
  page: { width: 210, height: 297, margin: [22, 22, 22, 22] },
  fonts: { cjk: "微軟正黑體", latin: "Calibri", mono: "Consolas", headingCjk: "微軟正黑體", headingLatin: "Calibri" },
  body: { size: 11.5, line: 1.6, indent: 0, before: 0, after: 8, align: "left" },
  headings: [
    { size: 19, before: 0, after: 10, breakBefore: true, line: 1.3 },
    { size: 15, before: 16, after: 6, line: 1.3 },
    { size: 13, before: 12, after: 4, line: 1.3 },
    { size: 11.5, before: 10, after: 3, line: 1.3 },
    { size: 11.5, before: 8, after: 3, line: 1.3, bold: false },
    { size: 11.5, before: 8, after: 3, line: 1.3, bold: false },
  ],
  numbering: ["{p}. ", "{p} ", "{p} ", "", "", ""],
  cover: {
    enabled: true, align: "left", dateFormat: "iso", rule: true,
    fields: [
      { key: "course", size: 13, gap: 70 },
      { key: "title", size: 32, bold: true, gap: 10 },
      { key: "subtitle", size: 16, gap: 8 },
      { key: "author", size: 13, gap: 40 },
      { key: "studentId", size: 13, gap: 4 },
      { key: "department", size: 13, gap: 4 },
      { key: "instructor", size: 13, prefix: "指導老師 ", gap: 4 },
      { key: "date", size: 13, gap: 4 },
    ],
  },
  toc: { enabled: true, title: "目錄", depth: 3, leader: "none", pageNumbers: true, indent: 2 },
  sections: { frontMatter: "continue" },
  footer: { text: "{page} / {pages}", align: "center", size: 9.5 },
  table: { size: 10.5, headerBold: true, headerFill: "F2F2F2", border: "row", align: "left" },
  quote: { indent: 3, italic: false, bar: true },
};

/**
 * 北科材資「材料工程實習(一)」機械試驗期末報告。
 *
 * 這一份的規格是老師白紙黑字列出來的, 不是我猜的:
 * 「中文字體標楷體／英文字體 Times New Roman／第一頁 24／標題 16／內文 12／
 *   要有目錄／底下要有頁碼」。
 * 其餘尺寸是從範例 PDF 量出來的: A4、四邊 1 吋（72pt）邊界、單倍行高
 *（24pt 的行距量到 31.2pt、12pt 量到 15.6pt, 都剛好是標楷體的自然行高）,
 * 每一項試驗的標題 24pt 置中、另起一頁。
 */
const MECH = {
  id: "mech",
  name: "機械試驗期末報告",
  note: "北科材料工程實習(一)。標楷體 + Times New Roman, 封面 24／標題 16／內文 12, A4 一吋邊界、單倍行高, 有目錄與頁碼, 每項試驗另起一頁。",
  page: { width: 210, height: 297, margin: [25.4, 25.4, 25.4, 25.4] },
  fonts: {
    cjk: "標楷體", latin: "Times New Roman", mono: "Consolas",
    headingCjk: "標楷體", headingLatin: "Times New Roman",
  },
  body: { size: 12, line: 1, indent: 2, before: 0, after: 0, align: "both" },
  headings: [
    { size: 24, align: "center", before: 0, after: 12, breakBefore: true, line: 1 },
    { size: 16, align: "left", before: 6, after: 0, line: 1 },
    { size: 14, align: "left", before: 6, after: 0, line: 1 },
    { size: 12, align: "left", before: 6, after: 0, line: 1 },
    { size: 12, align: "left", before: 0, after: 0, line: 1, bold: false },
    { size: 12, align: "left", before: 0, after: 0, line: 1, bold: false },
  ],
  // 範例裡的章節沒有自動編號 —— 標題就是「概要:」「原理:」「公式:」,
  // 編號的部分（1. / (1)）都寫在內文的清單裡。
  numbering: ["", "", "", "", "", ""],
  cover: {
    enabled: true, align: "center", dateFormat: "", rule: false,
    fields: [
      { key: "course", size: 24, gap: 0 },
      { key: "title", size: 24, bold: true, gap: 28 },
      { key: "subtitle", size: 24, gap: 24, split: "、" },
      { key: "className", size: 24, gap: 56 },
      { key: "studentId", size: 24, gap: 0 },
      { key: "author", size: 24, gap: 0, split: "、" },
    ],
  },
  toc: { enabled: true, title: "目　錄", depth: 3, leader: "dot", pageNumbers: true, indent: 2 },
  sections: { frontMatter: "roman" },
  header: { text: "", align: "right", size: 10 },
  footer: { text: "{page}", align: "center", size: 12 },
  captions: {
    figure: "圖 {n}　", table: "表 {n}　",
    figurePos: "below", tablePos: "above", size: 12, align: "center",
  },
  table: { size: 12, headerBold: true, headerFill: "", border: "all", align: "center" },
};

/**
 * 北科材資「材料工程實習(一)」金相實習報告。
 *
 * 範例是掃描件, 量不到字級, 所以規格取自看得見的結構:
 * 章節走「一、」→「（一）」→「1.」→「(1)」, 封面列出整組組員與實驗老師。
 * 版面沿用同一門課的另一份（標楷體、A4）, 左右邊界照掃描件量出來的約 30mm。
 */
const METALLO = {
  id: "metallo",
  name: "金相實習報告",
  note: "北科材料工程實習(一)。章節「一、／（一）／1.」, 封面列出全組組員與實驗老師, 標楷體 A4、單倍行高。",
  page: { width: 210, height: 297, margin: [25.4, 30, 25.4, 30] },
  fonts: {
    cjk: "標楷體", latin: "Times New Roman", mono: "Consolas",
    headingCjk: "標楷體", headingLatin: "Times New Roman",
  },
  body: { size: 12, line: 1, indent: 2, before: 0, after: 0, align: "both" },
  headings: [
    { size: 16, align: "left", before: 12, after: 4, breakBefore: false, line: 1 },
    { size: 14, align: "left", before: 8, after: 2, line: 1 },
    { size: 12, align: "left", before: 6, after: 0, line: 1 },
    { size: 12, align: "left", before: 6, after: 0, line: 1, bold: false },
    { size: 12, align: "left", before: 0, after: 0, line: 1, bold: false },
    { size: 12, align: "left", before: 0, after: 0, line: 1, bold: false },
  ],
  numbering: ["{N}、", "（{N}）", "{n}. ", "({n}) ", "", ""],
  cover: {
    enabled: true, align: "center", dateFormat: "", rule: false,
    fields: [
      { key: "course", size: 22, gap: 0 },
      { key: "title", size: 22, bold: true, gap: 20 },
      { key: "subtitle", size: 18, gap: 16 },
      { key: "group", size: 18, gap: 48 },
      { key: "author", size: 16, gap: 16, split: "、" },
      { key: "instructor", size: 16, prefix: "實驗老師：", gap: 32 },
    ],
  },
  toc: { enabled: true, title: "目　錄", depth: 3, leader: "dot", pageNumbers: true, indent: 2 },
  sections: { frontMatter: "roman" },
  footer: { text: "{page}", align: "center", size: 12 },
  captions: {
    figure: "圖 {n}　", table: "表 {n}　",
    figurePos: "below", tablePos: "above", size: 12, align: "center",
  },
  table: { size: 12, headerBold: true, headerFill: "", border: "all", align: "center" },
};

const PRESETS = [MECH, METALLO, REPORT, THESIS, APA, CLEAN];

/* ============================ 合併與正規化 ============================ */

function isPlain(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

/** 深層合併。陣列整個取代 —— 半個 fields 陣列合併起來只會變成怪東西。 */
function merge(base, patch) {
  if (!isPlain(patch)) return patch === undefined ? base : patch;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isPlain(value) && isPlain(out[key]) ? merge(out[key], value) : value;
  }
  return out;
}

const ALIGNS = new Set(["left", "center", "right", "both"]);

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 把使用者改過的模板校正回可用範圍。
 *
 * 使用者一定會手動改 JSON, 少一個欄位或把字級打成 1200 都很正常。
 * 這裡不報錯, 只把值拉回合理區間 —— 排版工具最不該做的事就是因為
 * 一個打錯的數字而整份不給看。
 */
export function normalizeTemplate(input) {
  const t = merge(BASE, isPlain(input) ? input : {});

  const m = Array.isArray(t.page.margin) ? t.page.margin : [25.4, 25.4, 25.4, 25.4];
  t.page.width = clampNumber(t.page.width, 210, 50, 600);
  t.page.height = clampNumber(t.page.height, 297, 50, 900);
  t.page.margin = [0, 1, 2, 3].map((i) => clampNumber(m[i], 25.4, 0, Math.min(t.page.width, t.page.height) / 2 - 10));

  t.body.size = clampNumber(t.body.size, 12, 5, 72);
  t.body.line = clampNumber(t.body.line, 1.5, 0.8, 4);
  t.body.indent = clampNumber(t.body.indent, 2, 0, 10);
  t.body.before = clampNumber(t.body.before, 0, 0, 200);
  t.body.after = clampNumber(t.body.after, 0, 0, 200);
  if (!ALIGNS.has(t.body.align)) t.body.align = "both";

  t.headings = Array.from({ length: 6 }, (_, i) => {
    const h = merge(HEADING_DEFAULT, isPlain(t.headings[i]) ? t.headings[i] : {});
    h.size = clampNumber(h.size, 14, 5, 96);
    h.line = clampNumber(h.line, 1.5, 0.8, 4);
    h.before = clampNumber(h.before, 12, 0, 300);
    h.after = clampNumber(h.after, 6, 0, 300);
    if (!ALIGNS.has(h.align)) h.align = "left";
    h.bold = !!h.bold;
    h.breakBefore = !!h.breakBefore;
    return h;
  });

  t.numbering = Array.from({ length: 6 }, (_, i) => String(t.numbering?.[i] ?? ""));

  t.cover.fields = (Array.isArray(t.cover.fields) ? t.cover.fields : [])
    .filter((f) => isPlain(f) && f.key)
    .map((f) => ({
      key: String(f.key),
      prefix: String(f.prefix ?? ""),
      size: clampNumber(f.size, 14, 5, 96),
      bold: !!f.bold,
      gap: clampNumber(f.gap, 6, 0, 400),
      align: ALIGNS.has(f.align) ? f.align : "",
      // 組員名單用: 值裡出現這個字元就拆成一人一行。
      split: typeof f.split === "string" ? f.split.slice(0, 4) : "",
      repeatPrefix: !!f.repeatPrefix,
    }));
  if (!ALIGNS.has(t.cover.align)) t.cover.align = "center";

  t.toc.depth = clampNumber(t.toc.depth, 3, 1, 6);
  t.toc.indent = clampNumber(t.toc.indent, 2, 0, 10);
  t.table.size = clampNumber(t.table.size, 10.5, 5, 48);
  t.code.size = clampNumber(t.code.size, 9.5, 5, 48);
  t.captions.size = clampNumber(t.captions.size, 10.5, 5, 48);
  t.header.size = clampNumber(t.header.size, 9, 5, 48);
  t.footer.size = clampNumber(t.footer.size, 10.5, 5, 48);
  t.quote.indent = clampNumber(t.quote.indent, 4, 0, 20);
  t.quote.gap = clampNumber(t.quote.gap, 8, 0, 31);
  t.code.pad = clampNumber(t.code.pad, 8, 0, 31);
  t.list.indent = clampNumber(t.list.indent, 2, 0, 20);

  return t;
}

/** 內建模板清單（已正規化）。 */
export function presets() {
  return PRESETS.map((p) => normalizeTemplate(merge(BASE, p)));
}

/** 依 id 取內建模板；找不到回傳第一個。 */
export function presetById(id) {
  const found = PRESETS.find((p) => p.id === id);
  return normalizeTemplate(merge(BASE, found || REPORT));
}

/** 給使用者編輯用的字串。縮排兩格, 陣列不要被拆成一行一個數字。 */
export function toEditableJson(tpl) {
  return JSON.stringify(tpl, null, 2)
    .replace(/\[\s+((?:-?[\d.]+,?\s+){1,8})\]/g, (whole, inner) => `[${inner.trim().replace(/\s+/g, " ")}]`);
}
