// js/tools/md2docs/meta.js — 從 .md 的註解裡撈封面資料。
//
// 為什麼用 HTML 註解而不是 YAML front matter:
// 註解在任何 Markdown 預覽器裡都是隱形的, 所以同一份 .md 直接貼到 GitHub、
// Obsidian、VS Code 預覽都還是乾淨的報告內文, 只有這個工具看得見封面欄位。
// front matter 則會在不支援的地方變成一行 `---` 加一堆裸鍵值。
//
//     <!-- 標題: 材料科學實驗報告 -->
//     <!--
//       課程: 材料科學實驗
//       指導教授: 王大明
//       學號: 112345678
//     -->
//
// 一個註解裡可以放很多行, 也可以拆成很多個註解, 效果一樣。
// 鍵沒有白名單 —— 認得的會對應到標準欄位, 認不得的原樣留著,
// 模板要拿去排版也可以（封面欄位是模板自己列的）。

/** 標準欄位 → 可以拿來寫的別名。比對前會正規化（小寫、去掉空白與底線）。 */
const ALIASES = {
  title: ["title", "標題", "題目", "報告名稱", "報告題目"],
  docType: ["doctype", "文件類型", "報告類型", "類別"],
  subtitle: ["subtitle", "副標題", "子標題", "副題"],
  school: ["school", "university", "學校", "校名", "學校名稱"],
  department: ["department", "dept", "系所", "科系", "系級", "系別"],
  course: ["course", "subject", "課程", "科目", "課程名稱"],
  instructor: ["instructor", "teacher", "professor", "老師", "教授", "指導老師", "指導教授", "授課老師", "任課老師"],
  author: ["author", "作者", "姓名", "學生", "組員", "撰寫者"],
  studentId: ["studentid", "sid", "學號"],
  className: ["class", "班級", "班別"],
  group: ["group", "組別", "第幾組", "小組"],
  semester: ["semester", "term", "學期", "學年", "學年度"],
  date: ["date", "日期", "繳交日期", "完成日期"],
  abstract: ["abstract", "摘要"],
  keywords: ["keywords", "關鍵字", "關鍵詞"],
  template: ["template", "模板", "格式", "樣式"],
  toc: ["toc", "目錄"],
};

/** 內文裡用來硬斷頁的註解。 */
const PAGEBREAK_WORDS = new Set(["pagebreak", "page-break", "newpage", "分頁", "換頁", "跳頁"]);

/** 段落走到這個字串就是一個分頁指令。用不會出現在正常內文的形狀。 */
export const PAGEBREAK_MARK = "\u0000md2docs:pagebreak\u0000";

function normalizeKey(key) {
  return String(key).trim().toLowerCase().replace(/[\s_\-]+/g, "");
}

/** 把別名查回標準欄位名；查不到就回傳正規化後的原鍵。 */
function canonicalKey(key) {
  const norm = normalizeKey(key);
  for (const [canonical, names] of Object.entries(ALIASES)) {
    if (names.includes(norm)) return canonical;
  }
  return norm;
}

/**
 * 一段註解內文 → 鍵值對。
 * 只有「冒號前面像個欄位名」的行才算, 所以一般的說明性註解不會被誤當成資料。
 * 全形冒號一起吃, 中文輸入法下不用特地切半形。
 */
function parseFields(body) {
  const out = [];
  for (const line of String(body).split(/\r?\n/)) {
    const m = line.match(/^\s*([^:：\r\n]{1,24}?)\s*[:：]\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    // 「http://…」這種行的冒號前面是協定名, 不是欄位。
    if (!key || /\s{2,}/.test(key) || /^https?$/i.test(key)) continue;
    out.push([key, m[2].trim()]);
  }
  return out;
}

/** 這段註解整個就是一個分頁指令？ */
function isPagebreak(body) {
  return PAGEBREAK_WORDS.has(String(body).trim().toLowerCase());
}

/**
 * 拆掉開頭的 YAML front matter。
 *
 * 主力是註解, 但從別的編輯器搬過來的稿子常常帶著 front matter,
 * 多認一種格式比要使用者手動改省事。只認「第一行就是 ---」的情況,
 * 免得把內文的分隔線當成檔頭。
 */
function takeFrontMatter(src) {
  if (!/^---\r?\n/.test(src)) return { fields: [], rest: src };
  const end = src.indexOf("\n---", 4);
  if (end < 0) return { fields: [], rest: src };
  const body = src.slice(4, end);
  const after = src.slice(end + 4).replace(/^[^\n]*\n?/, "");
  const fields = parseFields(body);
  // 每一行都要是鍵值才算 front matter, 否則那三條線多半是分隔線。
  const lines = body.split(/\r?\n/).filter((l) => l.trim());
  if (!fields.length || fields.length !== lines.length) return { fields: [], rest: src };
  return { fields, rest: after };
}

/**
 * ``` 或 ~~~ 圍起來的範圍。
 *
 * 裡面的東西一律是文字, 不是指令 —— 教人怎麼寫封面的時候, 示範用的
 * `<!-- 標題: … -->` 是貼在程式碼區塊裡的, 不該真的被當成這份文件的封面。
 */
function fencedRanges(src) {
  const ranges = [];
  let offset = 0;
  let start = -1;
  let marker = "";
  for (const line of src.split("\n")) {
    const m = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (m) {
      if (start < 0) { start = offset; marker = m[1][0]; }
      else if (m[1][0] === marker) { ranges.push([start, offset + line.length]); start = -1; }
    }
    offset += line.length + 1;
  }
  if (start >= 0) ranges.push([start, src.length]);
  return ranges;
}

/**
 * 把原始 Markdown 拆成「封面資料」與「真正要排版的內文」。
 *
 * @param {string} source
 * @returns {{meta: Record<string,string>, raw: Record<string,string>, body: string}}
 *   meta 是標準欄位名, raw 保留使用者原本寫的鍵（模板可以直接引用）。
 */
export function extractMeta(source) {
  const meta = Object.create(null);
  const raw = Object.create(null);

  const front = takeFrontMatter(String(source ?? "").replace(/^\uFEFF/, ""));
  for (const [key, value] of front.fields) {
    raw[key] = value;
    meta[canonicalKey(key)] = value;
  }

  const fenced = fencedRanges(front.rest);
  const inFence = (at) => fenced.some(([from, to]) => at >= from && at < to);

  const body = front.rest.replace(/<!--([\s\S]*?)-->/g, (whole, inner, at) => {
    if (inFence(at)) return whole; // 程式碼區塊裡的是示範, 不是指令
    if (isPagebreak(inner)) return `\n\n${PAGEBREAK_MARK}\n\n`;
    const fields = parseFields(inner);
    if (!fields.length) return whole; // 純說明用的註解, 留給 Markdown 自己忽略
    for (const [key, value] of fields) {
      raw[key] = value;
      meta[canonicalKey(key)] = value;
    }
    return "";
  });

  return { meta, raw, body: body.replace(/^\s*\n/, "") };
}

/** 今天的日期, 民國或西元。封面沒寫日期時用。 */
export function today(style = "zh") {
  const d = new Date();
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  if (style === "roc") return `中華民國 ${y - 1911} 年 ${m} 月 ${day} 日`;
  if (style === "iso") return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (style === "en") {
    const names = ["January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"];
    return `${names[m - 1]} ${day}, ${y}`;
  }
  return `${y} 年 ${m} 月 ${day} 日`;
}

/**
 * 把 "{title} — {course}" 這種字串裡的 {鍵} 換成實際的值。
 * 頁首、頁尾、封面的前綴都靠它。找不到的鍵換成空字串, 不留下 {} 這種殘骸。
 */
export function fill(pattern, values) {
  return String(pattern ?? "").replace(/\{([^{}]+)\}/g, (_, key) => {
    const v = values[key.trim()];
    return v == null ? "" : String(v);
  });
}
