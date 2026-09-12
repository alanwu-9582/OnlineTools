// js/tools/md2docs/docx.js — 文件模型 + 模板 → 一個真正的 .docx。
//
// .docx 就是一個 ZIP 裡面裝一疊 XML（OOXML）。打包交給站上共用的 zip.js,
// 這裡只負責生出那幾份 XML。沒有用任何 docx 函式庫。
//
// 兩個刻意的決定:
//
// 1. 目錄用 Word 的 TOC 功能變數, 不是自己畫一張表。
//    功能變數的目錄在 Word 裡點得動、頁碼會自己算, 使用者在 Word 裡補一段字
//    再按「更新功能變數」, 頁碼跟著對。自己畫的目錄一改內文就全錯。
//    同時我們把預覽算出來的頁碼寫進功能變數的快取結果, 所以就算使用者
//    完全不更新（或用 Google 文件打開）, 看到的也是對的數字而不是一排 1。
//
// 2. 標題樣式是從模板「生」出來的, 不是套 Word 內建的樣式。
//    老師要求的字級行高直接變成 Heading1 樣式本身, 所以使用者在 Word 裡
//    要再微調時, 改一個樣式整份跟著動 —— 而不是面對一份到處都是直接格式的檔案。

import { writeZip } from "../zip.js";
import { fill, today } from "./meta.js";
import { parseSizeHint } from "./images.js";
import { mathToOmml } from "./math.js";

/* ============================ 單位 ============================ */

const mmToTwip = (mm) => Math.round(mm * 1440 / 25.4);
const ptToTwip = (pt) => Math.round(pt * 20);
const ptToHalf = (pt) => Math.round(pt * 2);
const mmToEmu = (mm) => Math.round(mm * 36000);
/** 圖片的自然像素是 96 dpi 的 CSS 像素。 */
const pxToMm = (px) => px * 25.4 / 96;

const ALIGN = { left: "left", center: "center", right: "right", both: "both" };

/** XML 1.0 不接受這些控制字元。留著的話 Word 會直接說檔案損毀而不是忽略它們。 */
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

function x(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    // 控制字元在 XML 1.0 裡不合法, Word 會直接拒絕開檔。
    .replace(CONTROL_CHARS, "");
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const NS = [
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
  'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"',
].join(" ");

/* ============================ 打包用的小記事本 ============================ */

/**
 * 產生過程要一邊收東西: 圖片、外部連結、清單編號都各自需要一個 id,
 * 而且 document.xml 寫到一半才知道有哪些。集中在一個物件裡, 最後再一次
 * 生出 rels 與 numbering.xml。
 */
function newBook() {
  return {
    rels: [],          // {id, type, target, mode?}
    media: [],         // {name, bytes}
    numbering: [],     // {numId, abstractId, levels:[{ordered,start}]}
    nextRel: 100,
    nextDocPr: 1,
  };
}

function addRel(book, type, target, mode) {
  const id = `rId${book.nextRel += 1}`;
  book.rels.push({ id, type, target, mode });
  return id;
}

/* ============================ 行內 ============================ */

function runProps(run, tpl, ctx) {
  // rPr 的子元素在 schema 裡是有規定順序的:
  // rStyle → rFonts → b → i → strike → sz → shd → vertAlign。
  // 排錯了 Word 不會容忍, 是直接跳「檔案已損毀」, 所以不要為了好讀而重排。
  const parts = [];
  const cjk = ctx.cjk || tpl.fonts.cjk;
  const latin = ctx.latin || tpl.fonts.latin;
  if (ctx.link) parts.push('<w:rStyle w:val="Hyperlink"/>');
  if (run.code) {
    const mono = x(tpl.fonts.mono);
    parts.push(`<w:rFonts w:ascii="${mono}" w:hAnsi="${mono}" w:eastAsia="${mono}" w:cs="${mono}"/>`);
  } else {
    parts.push(`<w:rFonts w:ascii="${x(latin)}" w:hAnsi="${x(latin)}" w:eastAsia="${x(cjk)}" w:cs="${x(latin)}"/>`);
  }
  if (run.bold || ctx.bold) parts.push("<w:b/><w:bCs/>");
  if (run.italic) parts.push("<w:i/><w:iCs/>");
  if (run.strike) parts.push("<w:strike/>");
  const size = run.code ? tpl.code.size : ctx.size;
  if (size) parts.push(`<w:sz w:val="${ptToHalf(size)}"/><w:szCs w:val="${ptToHalf(size)}"/>`);
  if (run.code && tpl.code.fill) {
    parts.push(`<w:shd w:val="clear" w:color="auto" w:fill="${x(tpl.code.fill)}"/>`);
  }
  if (run.sup) parts.push('<w:vertAlign w:val="superscript"/>');
  if (run.sub) parts.push('<w:vertAlign w:val="subscript"/>');
  return parts.length ? `<w:rPr>${parts.join("")}</w:rPr>` : "";
}

/** 一段文字裡的換行要變成 <w:br/>, 不能就這樣塞進 <w:t>。 */
function textRuns(text, props) {
  return String(text).split("\n").map((line, i) => {
    const br = i ? "<w:br/>" : "";
    return `<w:r>${props}${br}<w:t xml:space="preserve">${x(line)}</w:t></w:r>`;
  }).join("");
}

function inlineXml(runs, tpl, book, ctx = {}) {
  let out = "";
  for (const run of runs || []) {
    if (run.br) { out += `<w:r>${runProps({}, tpl, ctx)}<w:br/></w:r>`; continue; }
    if (run.math) {
      const { omml, error } = mathToOmml(run.math, false);
      // 轉不出來就退回原始 LaTeX, 讓使用者看得到是哪一條式子出問題。
      if (omml) out += omml;
      else {
        book.mathErrors.push(`${run.math}（${error}）`);
        out += textRuns(`$${run.math}$`, runProps({ code: true }, tpl, ctx));
      }
      continue;
    }
    if (run.image) { out += imageRun(run.image, tpl, book, { inline: true }); continue; }
    if (!run.text) continue;
    if (run.href && /^(https?|mailto):/i.test(run.href)) {
      const rel = addRel(book, "hyperlink", run.href, "External");
      out += `<w:hyperlink r:id="${rel}" w:history="1">`
        + textRuns(run.text, runProps(run, tpl, { ...ctx, link: true }))
        + "</w:hyperlink>";
    } else {
      out += textRuns(run.text, runProps(run, tpl, ctx));
    }
  }
  return out;
}

/* ============================ 段落屬性 ============================ */

function spacing({ before = 0, after = 0, line = 1.5 }) {
  return `<w:spacing w:before="${ptToTwip(before)}" w:after="${ptToTwip(after)}"`
    + ` w:line="${Math.round(line * 240)}" w:lineRule="auto"/>`;
}

function paraProps(opts, tpl) {
  // 同樣是有規定順序的:
  // pStyle → keepNext → pageBreakBefore → numPr → pBdr → shd → tabs → spacing → ind → jc
  const parts = [];
  if (opts.style) parts.push(`<w:pStyle w:val="${opts.style}"/>`);
  if (opts.keepNext) parts.push("<w:keepNext/>");
  if (opts.breakBefore) parts.push("<w:pageBreakBefore/>");
  if (opts.numId) parts.push(`<w:numPr><w:ilvl w:val="${opts.ilvl || 0}"/><w:numId w:val="${opts.numId}"/></w:numPr>`);
  if (opts.border) parts.push(opts.border);
  if (opts.shading) parts.push(`<w:shd w:val="clear" w:color="auto" w:fill="${x(opts.shading)}"/>`);
  if (opts.tabs) parts.push(opts.tabs);
  if (opts.spacing !== false) parts.push(spacing(opts));
  const bits = [];
  if (opts.indentLeft) bits.push(`w:left="${ptToTwip(opts.indentLeft)}"`);
  if (opts.indentRight) bits.push(`w:right="${ptToTwip(opts.indentRight)}"`);
  if (opts.firstLineChars) bits.push(`w:firstLineChars="${Math.round(opts.firstLineChars * 100)}"`);
  if (opts.firstLine) bits.push(`w:firstLine="${ptToTwip(opts.firstLine)}"`);
  if (opts.hanging) bits.push(`w:hanging="${ptToTwip(opts.hanging)}"`);
  if (bits.length) parts.push(`<w:ind ${bits.join(" ")}/>`);
  if (opts.align && ALIGN[opts.align]) parts.push(`<w:jc w:val="${ALIGN[opts.align]}"/>`);
  return parts.length ? `<w:pPr>${parts.join("")}</w:pPr>` : "";
}

function para(content, opts, tpl) {
  return `<w:p>${paraProps(opts || {}, tpl)}${content}</w:p>`;
}

/* ============================ 圖片 ============================ */

/** 一張圖要多寬（mm）。先看 `=60%` 這種指定, 再看自然尺寸, 最後被版面寬度夾住。 */
function figureSize(image, tpl, hint) {
  const contentMm = tpl.page.width - tpl.page.margin[1] - tpl.page.margin[3];
  const natural = pxToMm(image.width);
  let widthMm = hint.percent ? contentMm * hint.percent / 100 : hint.mm || natural;
  widthMm = Math.min(widthMm, contentMm);
  const ratio = image.height / (image.width || 1);
  return { widthMm, heightMm: widthMm * ratio };
}

function imageRun(spec, tpl, book, { inline = false } = {}) {
  const image = book.images.get(spec.src);
  if (!image) {
    return `<w:r><w:rPr><w:color w:val="C00000"/></w:rPr><w:t xml:space="preserve">[缺圖: ${x(spec.alt || spec.src)}]</w:t></w:r>`;
  }
  let entry = book.mediaBySrc.get(spec.src);
  if (!entry) {
    const name = `image${book.media.length + 1}.${image.ext}`;
    const rel = addRel(book, "image", `media/${name}`);
    book.media.push({ name, bytes: image.bytes });
    entry = { rel, name };
    book.mediaBySrc.set(spec.src, entry);
  }
  const hint = parseSizeHint(spec.title || "");
  const alt = parseSizeHint(spec.alt || "");
  const size = figureSize(image, tpl, hint.percent || hint.mm ? hint : alt);
  // 行內圖跟著文字走, 縮到一行高度上下才不會把行距撐開。
  const scale = inline ? Math.min(1, (tpl.body.size * 1.6) / (size.heightMm * 72 / 25.4)) : 1;
  const cx = mmToEmu(size.widthMm * scale);
  const cy = mmToEmu(size.heightMm * scale);
  const id = book.nextDocPr += 1;

  return "<w:r><w:drawing>"
    + `<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>`
    + '<wp:effectExtent l="0" t="0" r="0" b="0"/>'
    + `<wp:docPr id="${id}" name="Picture ${id}" descr="${x(alt.caption || "")}"/>`
    + '<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>'
    + '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
    + '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
    + '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
    + `<pic:nvPicPr><pic:cNvPr id="${id}" name="${x(entry.name)}"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip r:embed="${entry.rel}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
    + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
    + "</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>";
}

/* ============================ 表格 ============================ */

/**
 * 一條框線。sz 的單位是 1/8 pt（4 = 0.5pt）, space 是「框線離文字多遠」, 單位 pt,
 * schema 上限 31。段落框線靠 space 決定畫在哪, 預覽那邊對應的是 padding。
 */
function borderTag(name, sz, color = "auto", space = 0) {
  const gap = Math.min(31, Math.max(0, Math.round(space)));
  return sz > 0
    ? `<w:${name} w:val="single" w:sz="${sz}" w:space="${gap}" w:color="${color}"/>`
    : `<w:${name} w:val="none" w:sz="0" w:space="0" w:color="auto"/>`;
}

function tableBorders(style) {
  if (style === "threeline") {
    return "<w:tblBorders>"
      + borderTag("top", 12) + borderTag("bottom", 12)
      + borderTag("left", 0) + borderTag("right", 0)
      + borderTag("insideH", 0) + borderTag("insideV", 0)
      + "</w:tblBorders>";
  }
  if (style === "row") {
    return "<w:tblBorders>"
      + borderTag("top", 4) + borderTag("bottom", 4)
      + borderTag("left", 0) + borderTag("right", 0)
      + borderTag("insideH", 4) + borderTag("insideV", 0)
      + "</w:tblBorders>";
  }
  if (style === "none") {
    return "<w:tblBorders>"
      + ["top", "bottom", "left", "right", "insideH", "insideV"].map((n) => borderTag(n, 0)).join("")
      + "</w:tblBorders>";
  }
  return "<w:tblBorders>"
    + ["top", "bottom", "left", "right", "insideH", "insideV"].map((n) => borderTag(n, 4)).join("")
    + "</w:tblBorders>";
}

function tableXml(block, tpl, book) {
  const cols = Math.max(1, block.header.length || (block.rows[0] || []).length);
  const contentTwip = mmToTwip(tpl.page.width - tpl.page.margin[1] - tpl.page.margin[3]);
  const colWidth = Math.floor(contentTwip / cols);
  const threeline = tpl.table.border === "threeline";

  const cellXml = (c, { head = false, lastHeadRow = false, align = "left" }) => {
    // tcPr 的順序: tcW → tcBorders → shd → vAlign。
    const props = [`<w:tcW w:w="${colWidth}" w:type="dxa"/>`];
    if (lastHeadRow) props.push(`<w:tcBorders>${borderTag("bottom", 8)}</w:tcBorders>`);
    if (head && tpl.table.headerFill) {
      props.push(`<w:shd w:val="clear" w:color="auto" w:fill="${x(tpl.table.headerFill)}"/>`);
    }
    props.push('<w:vAlign w:val="center"/>');
    const body = inlineXml(c.inlines, tpl, book, { size: tpl.table.size, bold: head && tpl.table.headerBold });
    // 段落上下不再留空: 儲存格的留白全部交給 tblCellMar, 只有一個來源,
    // 預覽那邊的 padding 才對得上。
    const cellPara = para(body || "<w:r><w:t/></w:r>", {
      align: head ? "center" : align,
      before: 0, after: 0, line: 1.15,
    }, tpl);
    return `<w:tc><w:tcPr>${props.join("")}</w:tcPr>${cellPara}</w:tc>`;
  };

  const rows = [];
  if (block.header.length) {
    rows.push("<w:tr><w:trPr><w:tblHeader/></w:trPr>"
      + block.header.map((c) => cellXml(c, { head: true, lastHeadRow: threeline })).join("")
      + "</w:tr>");
  }
  for (const row of block.rows) {
    rows.push("<w:tr>"
      + row.map((c, i) => cellXml(c, { align: block.align[i] || "left" })).join("")
      + "</w:tr>");
  }

  return "<w:tbl><w:tblPr>"
    + `<w:tblW w:w="${contentTwip}" w:type="dxa"/>`
    + `<w:jc w:val="${ALIGN[tpl.table.align] || "center"}"/>`
    + tableBorders(tpl.table.border)
    // 固定欄寬 + 等寬 gridCol, 對應預覽的 table-layout: fixed。讓 Word 自動調欄寬的話
    // 它跟瀏覽器的演算法不一樣, 同一張表會排出兩種樣子。
    + '<w:tblLayout w:type="fixed"/>'
    + '<w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="90" w:type="dxa"/>'
    + '<w:bottom w:w="60" w:type="dxa"/><w:right w:w="90" w:type="dxa"/></w:tblCellMar>'
    + "</w:tblPr>"
    + `<w:tblGrid>${Array.from({ length: cols }, () => `<w:gridCol w:w="${colWidth}"/>`).join("")}</w:tblGrid>`
    + rows.join("")
    + "</w:tbl>";
}

/* ============================ 清單編號 ============================ */

/**
 * 幫一棵清單樹登記一組編號定義。
 *
 * 每一棵樹都自己一組, 而不是全文件共用 —— 共用的話第二個有序清單會
 * 接著第一個繼續數（5. 6. 7.）, 這是 Word 清單最常見的災情。
 */
function registerList(block, book) {
  const levels = [];
  const scan = (list, depth) => {
    if (depth > 8) return;
    if (!levels[depth]) levels[depth] = { ordered: list.ordered, start: list.start };
    for (const item of list.items) {
      for (const child of item.blocks) if (child.kind === "list") scan(child, depth + 1);
    }
  };
  scan(block, 0);
  const abstractId = book.numbering.length;
  const numId = abstractId + 1;
  book.numbering.push({ numId, abstractId, levels });
  return numId;
}

/* ============================ 區塊 ============================ */

function blockXml(block, tpl, book, ctx) {
  const out = [];
  const bodyLine = tpl.body.line;

  switch (block.kind) {
    case "math": {
      const { omml, error } = mathToOmml(block.tex, true);
      if (!omml) {
        book.mathErrors.push(`${block.tex}（${error}）`);
        out.push(para(textRuns(block.tex, runProps({ code: true }, tpl, {})), {
          align: "center", before: 8, after: 8, line: 1.15,
        }, tpl));
        break;
      }
      // oMathPara 是「自己佔一行的公式」, 對齊交給 m:jc。
      out.push(para(
        `<m:oMathPara><m:oMathParaPr><m:jc m:val="center"/></m:oMathParaPr>${omml}</m:oMathPara>`,
        { before: 8, after: 8, line: bodyLine },
        tpl,
      ));
      break;
    }
    case "mermaid": {
      const found = book.diagrams.get(block.text);
      if (!found) {
        out.push(para(
          '<w:r><w:rPr><w:color w:val="C00000"/></w:rPr><w:t>[流程圖畫不出來]</w:t></w:r>',
          { align: "center", before: 8, after: 8, line: 1 }, tpl,
        ));
        break;
      }
      out.push(para(imageRun({
        src: `mermaid:${block.text}`, alt: "", title: block.hint || "",
      }, tpl, book), {
        align: "center", before: 8, after: block.number || block.caption ? 2 : 8, line: 1,
        keepNext: !!(block.number || block.caption),
      }, tpl));
      if (block.number || block.caption) {
        const label = `${block.number || ""}${block.caption || ""}`.trim();
        out.push(para(
          inlineXml([{ text: label }], tpl, book, { size: tpl.captions.size }),
          { align: tpl.captions.align, before: 2, after: 10, line: 1.15, style: "Caption" },
          tpl,
        ));
      }
      break;
    }
    case "heading": {
      const lv = Math.min(6, Math.max(1, block.level));
      const h = tpl.headings[lv - 1];
      // 計數器要放在 book（整份共用的那個）上。ctx 一路都是用 {...ctx} 複製下去的,
      // 放在 ctx 裡的遞增回到上層就不見了, 書籤會整批撞名。
      const bookmark = `_Toc${90000000 + book.headingIndex}`;
      book.bookmarks.set(block.id, bookmark);
      const id = book.headingIndex;
      book.headingIndex += 1;
      const runs = inlineXml(
        [{ text: block.number || "" }, ...block.inlines].filter((r) => r.text !== ""),
        tpl, book, { cjk: tpl.fonts.headingCjk, latin: tpl.fonts.headingLatin },
      );
      out.push(para(
        `<w:bookmarkStart w:id="${id + 1}" w:name="${bookmark}"/>${runs}<w:bookmarkEnd w:id="${id + 1}"/>`,
        { style: `Heading${lv}`, spacing: false, breakBefore: h.breakBefore && !ctx.first },
        tpl,
      ));
      break;
    }
    case "para": {
      const runs = inlineXml(block.inlines, tpl, book, {});
      out.push(para(runs, {
        align: tpl.body.align,
        before: tpl.body.before, after: tpl.body.after, line: bodyLine,
        border: ctx.border || "",
        indentLeft: ctx.indentLeft || 0,
        firstLineChars: ctx.noIndent ? 0 : tpl.body.indent,
        firstLine: ctx.noIndent ? 0 : tpl.body.indent * tpl.body.size,
      }, tpl));
      break;
    }
    case "figure": {
      const hint = parseSizeHint(block.title || "");
      const altHint = parseSizeHint(block.alt || "");
      out.push(para(imageRun(block, tpl, book), {
        align: "center", before: 8, after: tpl.captions.figurePos === "below" ? 2 : 8, line: 1,
        keepNext: true,
      }, tpl));
      const caption = hint.caption || altHint.caption;
      if (caption || block.number) {
        out.push(para(
          inlineXml([{ text: `${block.number || ""}${caption}` }], tpl, book, { size: tpl.captions.size }),
          { align: tpl.captions.align, before: 2, after: 10, line: 1.15, style: "Caption" },
          tpl,
        ));
      }
      break;
    }
    case "table": {
      const caption = block.number || block.caption
        ? `${block.number || ""}${block.caption || ""}` : "";
      if (caption && tpl.captions.tablePos === "above") {
        out.push(para(inlineXml([{ text: caption }], tpl, book, { size: tpl.captions.size }),
          { align: tpl.captions.align, before: 10, after: 2, line: 1.15, style: "Caption", keepNext: true }, tpl));
      }
      out.push(tableXml(block, tpl, book));
      if (caption && tpl.captions.tablePos !== "above") {
        out.push(para(inlineXml([{ text: caption }], tpl, book, { size: tpl.captions.size }),
          { align: tpl.captions.align, before: 2, after: 10, line: 1.15, style: "Caption" }, tpl));
      }
      // 表格後面沒有段落的話, 兩張連在一起的表在 Word 裡會併成一張。
      out.push(`<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:rPr><w:sz w:val="8"/></w:rPr></w:pPr></w:p>`);
      break;
    }
    case "code": {
      // 框線離文字: 左右 code.pad, 上下 3pt —— 跟預覽的 padding: 3pt <pad> 同一組數字。
      const pad = tpl.code.pad;
      const border = tpl.code.border
        ? `<w:pBdr>${borderTag("top", 4, "DDDDDD", 3)}${borderTag("bottom", 4, "DDDDDD", 3)}`
          + `${borderTag("left", 4, "DDDDDD", pad)}${borderTag("right", 4, "DDDDDD", pad)}</w:pBdr>`
        : "";
      const lines = String(block.text).replace(/\n+$/, "").split("\n");
      const props = runProps({ code: true }, tpl, {});
      const runs = lines.map((line, i) => `<w:r>${props}${i ? "<w:br/>" : ""}`
        + `<w:t xml:space="preserve">${x(line)}</w:t></w:r>`).join("");
      out.push(para(runs, {
        align: "left", before: 6, after: 6, line: 1.15,
        indentLeft: pad, indentRight: pad, border, shading: tpl.code.fill || "",
      }, tpl));
      break;
    }
    case "quote": {
      // 2.25pt 的左框線, 離文字 quote.gap —— 預覽那邊是同寬的 border-left 加同寬的
      // padding-left, 所以兩邊的直線畫在同一個位置。
      const border = tpl.quote.bar
        ? `<w:pBdr>${borderTag("left", 18, "BBBBBB", tpl.quote.gap)}</w:pBdr>` : "";
      for (const child of block.blocks) {
        out.push(...blockXml(child, tpl, book, {
          ...ctx,
          indentLeft: (ctx.indentLeft || 0) + tpl.quote.indent * tpl.body.size,
          border,
          noIndent: true,
        }));
      }
      break;
    }
    case "list": {
      const numId = ctx.listNumId || registerList(block, book);
      const depth = ctx.listDepth || 0;
      block.items.forEach((item) => {
        item.blocks.forEach((child, i) => {
          if (child.kind === "list") {
            out.push(...blockXml(child, tpl, book, { ...ctx, listNumId: numId, listDepth: depth + 1 }));
            return;
          }
          if (child.kind === "para" && i === 0) {
            const runs = inlineXml(child.inlines, tpl, book, {});
            out.push(para(runs, {
              numId, ilvl: depth, align: "left",
              before: 0, after: tpl.list.gap, line: bodyLine,
            }, tpl));
            return;
          }
          out.push(...blockXml(child, tpl, book, {
            ...ctx, listNumId: null, listDepth: 0, noIndent: true,
            indentLeft: (ctx.indentLeft || 0) + (depth + 1) * tpl.list.indent * tpl.body.size,
          }));
        });
      });
      break;
    }
    case "hr":
      out.push(para("", {
        spacing: true, before: 6, after: 6, line: 1,
        border: `<w:pBdr>${borderTag("bottom", 6, "999999")}</w:pBdr>`,
      }, tpl));
      break;
    case "pagebreak":
      out.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
      break;
    default:
      break;
  }
  return out;
}

/* ============================ 封面與目錄 ============================ */

function coverXml(meta, tpl, book) {
  if (!tpl.cover.enabled) return [];
  const out = [];
  const values = { ...meta };
  if (!values.date && tpl.cover.dateFormat) values.date = today(tpl.cover.dateFormat);

  for (const f of tpl.cover.fields) {
    const value = values[f.key];
    if (!value) continue;
    // 逗號類分隔符同時接受半形逗號與頓號，與瀏覽器預覽一致。
    const separator = f.split === "," || f.split === "、" ? /[,、]/ : f.split;
    const pieces = separator ? String(value).split(separator).map((s) => s.trim()).filter(Boolean) : [value];
    pieces.forEach((piece, i) => {
      out.push(para(
        inlineXml([{ text: `${i === 0 || f.repeatPrefix ? f.prefix : ""}${piece}`, bold: f.bold }], tpl, book,
          { size: f.size, cjk: tpl.fonts.headingCjk, latin: tpl.fonts.headingLatin }),
        { align: f.align || tpl.cover.align, before: i === 0 ? f.gap : 0, after: 0, line: 1.3 },
        tpl,
      ));
    });
    if (f.key === "title" && tpl.cover.rule) {
      out.push(para("", {
        before: 6, after: 0, line: 1,
        border: `<w:pBdr>${borderTag("bottom", 8, "666666")}</w:pBdr>`,
      }, tpl));
    }
  }
  return out;
}

/**
 * 目錄。外層是一個 TOC 功能變數, 中間塞我們自己算好的項目當「快取結果」。
 *
 * 這樣三種讀者都得到合理的東西:
 *   Word 使用者    —— 開檔時自動更新, 頁碼由 Word 自己算, 點得動
 *   不更新的人     —— 看到的是預覽算出來的頁碼, 不是一排 1
 *   Google 文件    —— 不支援功能變數, 但快取結果就是純文字, 照樣看得到目錄
 */
function tocXml(outline, tpl, book, pageOf) {
  if (!tpl.toc.enabled || !outline.length) return [];
  const out = [];
  const contentTwip = mmToTwip(tpl.page.width - tpl.page.margin[1] - tpl.page.margin[3]);
  const h1 = tpl.headings[0];

  out.push(para(
    inlineXml([{ text: tpl.toc.title, bold: true }], tpl, book,
      { size: h1.size, cjk: tpl.fonts.headingCjk, latin: tpl.fonts.headingLatin }),
    { align: "center", before: 0, after: 18, line: 1.3 },
    tpl,
  ));

  const entries = outline.map((item) => {
    const bookmark = book.bookmarks.get(item.id);
    const label = `${item.number || ""}${item.text}`;
    const indent = (item.level - 1) * tpl.toc.indent * tpl.body.size;
    const page = pageOf?.get(item.id);
    const tabs = tpl.toc.pageNumbers
      ? `<w:tabs><w:tab w:val="right" w:leader="${tpl.toc.leader === "none" ? "none" : "dot"}" w:pos="${contentTwip}"/></w:tabs>`
      : "";
    const props = runProps({}, tpl, { size: tpl.body.size });
    let body = `<w:r>${props}<w:t xml:space="preserve">${x(label)}</w:t></w:r>`;
    if (tpl.toc.pageNumbers) {
      body += `<w:r>${props}<w:tab/></w:r>`
        + `<w:r>${props}<w:fldChar w:fldCharType="begin"/></w:r>`
        + `<w:r>${props}<w:instrText xml:space="preserve"> PAGEREF ${bookmark} \\h </w:instrText></w:r>`
        + `<w:r>${props}<w:fldChar w:fldCharType="separate"/></w:r>`
        + `<w:r>${props}<w:t>${page == null ? "" : page}</w:t></w:r>`
        + `<w:r>${props}<w:fldChar w:fldCharType="end"/></w:r>`;
    }
    return para(
      `<w:hyperlink w:anchor="${bookmark}" w:history="1">${body}</w:hyperlink>`,
      { align: "left", before: 0, after: 4, line: 1.3, indentLeft: indent, tabs },
      tpl,
    );
  });

  // 功能變數的 begin 與 end 可以跨段落, Word 自己寫出來的目錄就長這樣。
  const first = entries[0] || para("", {}, tpl);
  const opened = first.replace(
    /^<w:p>(<w:pPr>.*?<\/w:pPr>)?/s,
    (whole, pPr) => `<w:p>${pPr || ""}`
      + '<w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r>'
      + `<w:r><w:instrText xml:space="preserve"> TOC \\o "1-${tpl.toc.depth}" \\h \\z \\u </w:instrText></w:r>`
      + '<w:r><w:fldChar w:fldCharType="separate"/></w:r>',
  );
  out.push(opened, ...entries.slice(1));
  out.push(para('<w:r><w:fldChar w:fldCharType="end"/></w:r>', { spacing: false }, tpl));
  return out;
}

/* ============================ 頁首頁尾 ============================ */

function fieldRun(name, props) {
  return `<w:r>${props}<w:fldChar w:fldCharType="begin"/></w:r>`
    + `<w:r>${props}<w:instrText xml:space="preserve"> ${name} </w:instrText></w:r>`
    + `<w:r>${props}<w:fldChar w:fldCharType="separate"/></w:r>`
    + `<w:r>${props}<w:t>1</w:t></w:r>`
    + `<w:r>${props}<w:fldChar w:fldCharType="end"/></w:r>`;
}

/** 把 "{page} / {pages}" 這種樣板變成一串 run, {page}/{pages} 換成功能變數。 */
function bandXml(pattern, meta, tpl, size, align, tag) {
  const props = runProps({}, tpl, { size });
  let body = "";
  const text = fill(String(pattern ?? ""), meta);
  for (const piece of text.split(/(\{page\}|\{pages\})/)) {
    if (piece === "{page}") body += fieldRun("PAGE", props);
    else if (piece === "{pages}") body += fieldRun("NUMPAGES", props);
    else if (piece) body += `<w:r>${props}<w:t xml:space="preserve">${x(piece)}</w:t></w:r>`;
  }
  const inner = `<w:p><w:pPr><w:pStyle w:val="${tag === "hdr" ? "Header" : "Footer"}"/>`
    + `<w:jc w:val="${ALIGN[align] || "center"}"/>`
    + '<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>'
    + body + "</w:p>";
  return XML_HEAD + `<w:${tag} ${NS}>${inner}</w:${tag}>`;
}

/* ============================ 樣式 ============================ */

function stylesXml(tpl) {
  const fontTag = (cjk, latin) =>
    `<w:rFonts w:ascii="${x(latin)}" w:hAnsi="${x(latin)}" w:eastAsia="${x(cjk)}" w:cs="${x(latin)}"/>`;

  const headings = tpl.headings.map((h, i) => {
    const lv = i + 1;
    return `<w:style w:type="paragraph" w:styleId="Heading${lv}">`
      + `<w:name w:val="heading ${lv}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>`
      + `<w:uiPriority w:val="9"/><w:qFormat/>`
      + `<w:pPr><w:keepNext/><w:keepLines/>${spacing(h)}`
      + `<w:jc w:val="${ALIGN[h.align] || "left"}"/><w:outlineLvl w:val="${i}"/></w:pPr>`
      + `<w:rPr>${fontTag(tpl.fonts.headingCjk || tpl.fonts.cjk, tpl.fonts.headingLatin || tpl.fonts.latin)}`
      + `${h.bold ? "<w:b/><w:bCs/>" : ""}`
      + `<w:sz w:val="${ptToHalf(h.size)}"/><w:szCs w:val="${ptToHalf(h.size)}"/></w:rPr></w:style>`;
  }).join("");

  const tocStyles = [1, 2, 3, 4, 5, 6].map((lv) =>
    `<w:style w:type="paragraph" w:styleId="TOC${lv}"><w:name w:val="toc ${lv}"/>`
    + `<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="39"/>`
    + `<w:pPr><w:spacing w:after="80"/><w:ind w:left="${ptToTwip((lv - 1) * tpl.toc.indent * tpl.body.size)}"/></w:pPr>`
    + "</w:style>").join("");

  return XML_HEAD + `<w:styles ${NS}>`
    + "<w:docDefaults><w:rPrDefault><w:rPr>"
    + fontTag(tpl.fonts.cjk, tpl.fonts.latin)
    + `<w:sz w:val="${ptToHalf(tpl.body.size)}"/><w:szCs w:val="${ptToHalf(tpl.body.size)}"/>`
    + '<w:lang w:val="en-US" w:eastAsia="zh-TW" w:bidi="ar-SA"/>'
    + "</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr>"
    + spacing({ before: tpl.body.before, after: tpl.body.after, line: tpl.body.line })
    + "</w:pPr></w:pPrDefault></w:docDefaults>"
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/>'
    + `<w:pPr><w:widowControl/>${spacing({ before: tpl.body.before, after: tpl.body.after, line: tpl.body.line })}`
    + `<w:jc w:val="${ALIGN[tpl.body.align] || "both"}"/></w:pPr></w:style>`
    + headings
    + tocStyles
    + '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/>'
    + '<w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/>'
    + `<w:qFormat/><w:pPr><w:ind w:firstLine="0"/><w:jc w:val="${ALIGN[tpl.captions.align] || "center"}"/></w:pPr>`
    + `<w:rPr><w:sz w:val="${ptToHalf(tpl.captions.size)}"/></w:rPr></w:style>`
    + '<w:style w:type="paragraph" w:styleId="Header"><w:name w:val="header"/><w:basedOn w:val="Normal"/>'
    + '<w:pPr><w:ind w:firstLine="0"/></w:pPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/>'
    + '<w:pPr><w:ind w:firstLine="0"/></w:pPr></w:style>'
    + "</w:styles>";
}

function numberingXml(book, tpl) {
  const bullets = ["•", "◦", "▪", "•", "◦", "▪", "•", "◦", "▪"];
  const ordered = ["%L.", "%L.", "%L.", "%L.", "%L.", "%L.", "%L.", "%L.", "%L."];
  const formats = ["decimal", "lowerLetter", "lowerRoman", "decimal", "lowerLetter", "lowerRoman",
    "decimal", "lowerLetter", "lowerRoman"];

  const abstracts = book.numbering.map((entry) => {
    const levels = Array.from({ length: 9 }, (_, i) => {
      const def = entry.levels[i] || entry.levels[entry.levels.length - 1] || { ordered: false, start: 1 };
      const indent = ptToTwip((i + 1) * tpl.list.indent * tpl.body.size);
      const hanging = ptToTwip(tpl.list.indent * tpl.body.size);
      const text = def.ordered ? ordered[i].replace("%L", `%${i + 1}`) : bullets[i];
      return `<w:lvl w:ilvl="${i}"><w:start w:val="${def.ordered ? (def.start || 1) : 1}"/>`
        + `<w:numFmt w:val="${def.ordered ? formats[i] : "bullet"}"/>`
        + `<w:lvlText w:val="${x(text)}"/><w:lvlJc w:val="left"/>`
        + `<w:pPr><w:ind w:left="${indent}" w:hanging="${hanging}"/></w:pPr>`
        + `<w:rPr><w:rFonts w:ascii="${x(tpl.fonts.latin)}" w:hAnsi="${x(tpl.fonts.latin)}" w:eastAsia="${x(tpl.fonts.cjk)}" w:hint="default"/></w:rPr></w:lvl>`;
    }).join("");
    return `<w:abstractNum w:abstractNumId="${entry.abstractId}">`
      + `<w:multiLevelType w:val="hybridMultilevel"/>${levels}</w:abstractNum>`;
  }).join("");

  const nums = book.numbering.map((entry) =>
    `<w:num w:numId="${entry.numId}"><w:abstractNumId w:val="${entry.abstractId}"/></w:num>`).join("");

  return XML_HEAD + `<w:numbering ${NS}>${abstracts}${nums}</w:numbering>`;
}

/* ============================ 節 ============================ */

function sectPr(tpl, { headerRel, footerRel, numFmt, numStart }) {
  const [top, right, bottom, left] = tpl.page.margin;
  return "<w:sectPr>"
    + (headerRel ? `<w:headerReference w:type="default" r:id="${headerRel}"/>` : "")
    + (footerRel ? `<w:footerReference w:type="default" r:id="${footerRel}"/>` : "")
    + `<w:pgSz w:w="${mmToTwip(tpl.page.width)}" w:h="${mmToTwip(tpl.page.height)}"/>`
    + `<w:pgMar w:top="${mmToTwip(top)}" w:right="${mmToTwip(right)}" w:bottom="${mmToTwip(bottom)}"`
    + ` w:left="${mmToTwip(left)}" w:header="${mmToTwip(top / 2)}" w:footer="${mmToTwip(bottom / 2)}" w:gutter="0"/>`
    + (numFmt ? `<w:pgNumType w:start="${numStart || 1}" w:fmt="${numFmt}"/>` : "")
    + '<w:docGrid w:type="default" w:linePitch="360"/>'
    + "</w:sectPr>";
}

/* ============================ 主流程 ============================ */

/**
 * 產生 .docx。
 *
 * @param {object} args
 * @param {Array}  args.blocks   已編號的區塊
 * @param {object} args.meta     封面欄位
 * @param {object} args.tpl      正規化過的模板
 * @param {Array}  args.outline  目錄項目
 * @param {Map}    args.images   圖片（來自 resolveImages）
 * @param {Map}    [args.diagrams] 流程圖（來自 renderDiagrams）
 * @param {Map}    [args.pageOf] 標題 id → 頁碼（預覽算的, 當目錄快取值）
 * @param {string[]} [args.warnings] 轉檔過程中的問題會塞進這個陣列
 * @returns {Promise<Blob>}
 */
export async function buildDocx({
  blocks, meta, tpl, outline, images, diagrams, pageOf, warnings = [],
}) {
  const book = newBook();
  // 流程圖跟圖片走同一條嵌入路徑, 用一個不會跟檔名撞到的前綴當 key。
  book.images = new Map(images || []);
  book.diagrams = diagrams || new Map();
  for (const [code, art] of book.diagrams) book.images.set(`mermaid:${code}`, art);
  book.mediaBySrc = new Map();
  book.mathErrors = warnings;

  book.bookmarks = new Map();
  book.headingIndex = 0;

  // 先跑內文: 書籤要先建立, 目錄才連得過去。
  const bodyParts = [];
  blocks.forEach((block, i) => {
    bodyParts.push(...blockXml(block, tpl, book, { first: i === 0 }));
  });
  // 表格結尾 + sectPr 的組合在 Word 裡不合法, 補一個空段落。
  bodyParts.push('<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:p>');

  const cover = coverXml(meta, tpl, book);
  const toc = tocXml(outline, tpl, book, pageOf);

  const hasHeader = !!String(tpl.header.text || "").trim();
  const hasFooter = !!String(tpl.footer.text || "").trim();
  const parts = [];
  let headerRel = null;
  let frontFooterRel = null;
  let bodyFooterRel = null;

  if (hasHeader) {
    headerRel = addRel(book, "header", "header1.xml");
    parts.push({ name: "word/header1.xml", data: bandXml(tpl.header.text, meta, tpl, tpl.header.size, tpl.header.align, "hdr") });
  }
  if (hasFooter) {
    frontFooterRel = addRel(book, "footer", "footer1.xml");
    bodyFooterRel = addRel(book, "footer", "footer2.xml");
    const footer = bandXml(tpl.footer.text, meta, tpl, tpl.footer.size, tpl.footer.align, "ftr");
    parts.push({ name: "word/footer1.xml", data: footer });
    parts.push({ name: "word/footer2.xml", data: footer });
  }

  const roman = tpl.sections.frontMatter === "roman";
  const numberedFront = tpl.sections.frontMatter !== "none";

  // 封面自己一節, 而且不掛頁首頁尾 —— 封面印出一個「1」是最常見的扣分點。
  // 第一節沒有 headerReference 時 Word 不會去繼承（前面沒有節可繼承）, 正好就是要的結果。
  const body = [
    ...cover,
    ...(cover.length ? [`<w:p><w:pPr>${sectPr(tpl, {})}</w:pPr></w:p>`] : []),
    ...toc,
    ...(toc.length ? [`<w:p><w:pPr>${sectPr(tpl, {
      headerRel, footerRel: numberedFront ? frontFooterRel : null,
      numFmt: roman ? "lowerRoman" : "decimal", numStart: 1,
    })}</w:pPr></w:p>`] : []),
    ...bodyParts,
    sectPr(tpl, {
      headerRel, footerRel: bodyFooterRel,
      numFmt: "decimal", numStart: 1,
    }),
  ];

  const documentXml = XML_HEAD + `<w:document ${NS}><w:body>${body.join("")}</w:body></w:document>`;

  /* ---- 關聯與內容型別 ---- */
  const fixedRels = [
    { id: "rId1", type: "styles", target: "styles.xml" },
    { id: "rId2", type: "settings", target: "settings.xml" },
    { id: "rId3", type: "numbering", target: "numbering.xml" },
  ];
  const TYPE_URL = {
    styles: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles",
    settings: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings",
    numbering: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering",
    header: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/header",
    footer: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer",
    image: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
    hyperlink: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
  };
  const relsXml = XML_HEAD
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + [...fixedRels, ...book.rels].map((r) =>
      `<Relationship Id="${r.id}" Type="${TYPE_URL[r.type]}" Target="${x(r.target)}"`
      + `${r.mode ? ` TargetMode="${r.mode}"` : ""}/>`).join("")
    + "</Relationships>";

  const mediaExts = [...new Set(book.media.map((m) => m.name.split(".").pop()))];
  const mimeOf = { png: "image/png", jpeg: "image/jpeg", jpg: "image/jpeg", gif: "image/gif" };
  const contentTypes = XML_HEAD
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + mediaExts.map((e) => `<Default Extension="${e}" ContentType="${mimeOf[e] || "image/png"}"/>`).join("")
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>'
    + '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
    + (hasHeader ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : "")
    + (hasFooter ? '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>'
      + '<Override PartName="/word/footer2.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' : "")
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
    + "</Types>";

  const nowIso = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const coreXml = XML_HEAD
    + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"'
    + ' xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"'
    + ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    // 這幾個元素在 schema 裡是有順序的（created → creator → keywords → modified
    // → subject → title）, 照字面上舒服的順序排會變成不合法的檔案。
    + `<dcterms:created xsi:type="dcterms:W3CDTF">${nowIso}</dcterms:created>`
    + `<dc:creator>${x(meta.author || "")}</dc:creator>`
    + `<cp:keywords>${x(meta.keywords || "")}</cp:keywords>`
    + `<dcterms:modified xsi:type="dcterms:W3CDTF">${nowIso}</dcterms:modified>`
    + `<dc:subject>${x(meta.course || "")}</dc:subject>`
    + `<dc:title>${x(meta.title || "")}</dc:title>`
    + "</cp:coreProperties>";

  const appXml = XML_HEAD
    + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"'
    + ' xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
    + `<Company>${x(meta.school || "")}</Company>`
    + "<Application>MD2DOCS</Application><DocSecurity>0</DocSecurity></Properties>";

  // updateFields 要放在 compat 前面, 順序不對 Word 會抱怨檔案有問題。
  const settingsXml = XML_HEAD + `<w:settings ${NS}>`
    + '<w:zoom w:percent="100"/><w:defaultTabStop w:val="480"/>'
    + '<w:evenAndOddHeaders w:val="false"/><w:characterSpacingControl w:val="compressPunctuation"/>'
    + '<w:updateFields w:val="true"/>'
    + '<w:compat><w:compatSetting w:name="compatibilityMode"'
    + ' w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>'
    + "</w:settings>";

  const entries = [
    { name: "[Content_Types].xml", data: contentTypes },
    {
      name: "_rels/.rels",
      data: XML_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
        + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
        + "</Relationships>",
    },
    { name: "docProps/core.xml", data: coreXml },
    { name: "docProps/app.xml", data: appXml },
    { name: "word/document.xml", data: documentXml },
    { name: "word/_rels/document.xml.rels", data: relsXml },
    { name: "word/styles.xml", data: stylesXml(tpl) },
    { name: "word/settings.xml", data: settingsXml },
    { name: "word/numbering.xml", data: numberingXml(book, tpl) },
    ...parts,
    ...book.media.map((m) => ({ name: `word/media/${m.name}`, data: m.bytes })),
  ];

  const blob = await writeZip(entries);
  return new Blob([blob], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}
