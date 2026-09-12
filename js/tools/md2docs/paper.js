// js/tools/md2docs/paper.js — 把文件模型排成一頁一頁的 HTML。
//
// 這裡是自己做的分頁引擎, 不是交給瀏覽器的 @page 去斷。多花這個工是為了
// 三件只有「知道每一段落在第幾頁」才做得到的事:
//
//   1. 目錄的頁碼是真的。CSS 沒有 target-counter, 交給瀏覽器分頁就只能
//      印出一份沒有頁碼的目錄 —— 書面報告的目錄沒有頁碼等於沒有。
//   2. 頁尾的頁碼是自己畫的。Chrome 的列印頁首頁尾只能印網址跟日期,
//      沒辦法照老師要求放「- 3 -」或「3 / 12」。
//   3. 預覽就是列印結果。看到的紙張、邊界、斷頁位置跟印出來的完全一樣,
//      不必印一次才知道封面後面多了一張空白頁。
//
// 順帶把算好的頁碼交給 docx.js 當目錄功能變數的快取值, 所以 .docx 在
// 還沒更新功能變數以前, 目錄上的數字也是對的。
//
// 斷頁規則跟 Word 對齊: 段落可以從中間某一行斷開、表格斷列（表頭重印）、
// 清單斷項、標題不跟內文分家（keep-with-next）、圖片與程式碼整塊搬。

import { fill, today } from "./meta.js";
import { roman } from "./doc-model.js";
import { parseSizeHint } from "./images.js";
import { renderMath, katexStyles, katexHref } from "./math.js";

/* ============================ 樣式隔離 ============================ */

/**
 * 紙一律畫在 shadow DOM 裡。
 *
 * 這是為了讓「預覽」跟「輸出」真的是同一件事。工具掛在文章內文裡, 而 viewer.css
 * 有一整批 `.doc-content a / table / blockquote / code …` 的規則, 它們會照著選擇器
 * 打進預覽的紙上 —— 目錄的連結變成主題藍、表格套上深色底與網站邊框、引言變成
 * 圓角色塊。但量測用的暫存區在 document.body 底下、列印用的 iframe 又是另一份
 * 文件, 兩邊都吃不到那些規則, 於是「看到的」和「印出來的」就分家了。
 *
 * 逐條寫 reset 蓋回去是能蓋掉, 但 viewer.css 以後每加一條規則就會再破一次,
 * 而且破的時候沒有任何徵兆。改成 shadow DOM 之後這件事變成結構上的保證:
 * 紙永遠只看得到 md2docs.css 這一份樣式, 三個地方都一樣。
 */
export const PAPER_STYLE_URL = new URL("./md2docs.css", import.meta.url).href;

let stylePromise = null;
let styleText = "";

/**
 * 取得紙的樣式原始碼（只抓一次）。列印用的 iframe 也是用這一份。
 * KaTeX 的樣式一起併進來 —— 公式在影子裡, 吃不到 <head> 那一份。
 */
export function paperStyles() {
  if (!stylePromise) {
    stylePromise = Promise.all([
      fetch(PAPER_STYLE_URL).then((r) => r.text()).catch(() => ""),
      katexStyles(),
    ]).then(([own, katex]) => {
      styleText = `${own}\n${katex}`;
      return styleText;
    });
  }
  return stylePromise;
}

/**
 * 在 host 底下開一塊隔離的紙區, 回傳要往裡面放頁面的容器。
 * 同一個 host 重複呼叫會沿用既有的 shadow root。
 */
export function createPaperSurface(host) {
  const root = host.shadowRoot || host.attachShadow({ mode: "open" });
  root.replaceChildren();
  // KaTeX 的樣式再掛一份 <link> 當保險: 上面那一份是抓下來的文字, 抓不到
  // （被 CDN、Service Worker 或離線擋下）就只剩這條路。兩份規則一樣, 疊著沒差。
  const katex = document.createElement("link");
  katex.rel = "stylesheet";
  katex.href = katexHref();
  root.appendChild(katex);
  if (styleText) {
    const style = document.createElement("style");
    style.textContent = styleText;
    root.appendChild(style);
  } else {
    // 樣式還沒抓到（或抓失敗）時的備援。<link> 是非同步的, 分頁量測會不準,
    // 所以正常路徑一定是先 await paperStyles() 再進來。
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = PAPER_STYLE_URL;
    root.appendChild(link);
  }
  const surface = document.createElement("div");
  surface.className = "md2-paper";
  root.appendChild(surface);
  return surface;
}

const MM = "mm";
const mm = (v) => `${Math.round(v * 1000) / 1000}${MM}`;
const pt = (v) => `${Math.round(v * 100) / 100}pt`;

const TEXT_ALIGN = { left: "left", center: "center", right: "right", both: "justify" };

/* ============================ 行高 ============================ */

/**
 * Word 的「N 倍行高」是 N × **字型的自然行高**, 不是 N × 字級。
 * 標楷體的自然行高大約是字級的 1.3 倍 —— 同樣寫 1.5, Word 排出來會比
 * CSS 的 line-height: 1.5 高出三成。一頁差幾行, 斷頁位置就跟著跑,
 * 目錄頁碼也一起錯。
 *
 * 所以預覽不能直接把模板的數字丟給 line-height, 要先乘上字型的自然行高。
 * 那個比例沒辦法從字型名稱算出來, 只能量: 拿一行字用 line-height: normal
 * （瀏覽器就是用字型自己的 ascent/descent/lineGap, 跟 Word 的單行間距同源）
 * 排出來看有多高。量一次就存起來。
 *
 * 量的時候中文字型要排在前面, 跟實際渲染的順序相反 —— 瀏覽器的 normal 行高
 * 只看「第一個存在的字型」, 而 Word 的行高看的是那一行真正用到的字型。
 * 中文報告每一行都有中文, 決定行高的是中文字型而不是英文字型。
 * 全英文的模板（cjk 欄位也填英文字型）走同一條規則一樣會得到對的答案。
 */
const lineRatios = new Map();

function naturalLineRatio(stack) {
  if (lineRatios.has(stack)) return lineRatios.get(stack);
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;left:-9999px;top:0;visibility:hidden;"
    + `white-space:nowrap;line-height:normal;font-size:200px;font-family:${stack}`;
  probe.textContent = "字Ag";
  document.body.appendChild(probe);
  const ratio = probe.offsetHeight / 200 || 1.2;
  probe.remove();
  lineRatios.set(stack, ratio);
  return ratio;
}

/** 量行高專用的字型順序: 中文排前面。 */
function metricStack(tpl, heading = false) {
  const cjk = (heading && tpl.fonts.headingCjk) || tpl.fonts.cjk;
  const latin = (heading && tpl.fonts.headingLatin) || tpl.fonts.latin;
  return `"${cjk}", "${latin}", serif`;
}

/** 模板寫的倍數 → CSS 的 line-height。 */
function lineHeight(multiple, stack) {
  return String(Math.round(multiple * naturalLineRatio(stack) * 1000) / 1000);
}

/** 封面每一行的行距。預覽與 .docx 共用同一個數字。 */
const COVER_LINE = 1.3;

/* ============================ 行內 ============================ */

function mathNode(tex, display, tpl) {
  const { html, error } = renderMath(tex, display);
  const node = document.createElement(display ? "div" : "span");
  node.className = display ? "md2-math" : "md2-math-inline";
  if (error) {
    node.classList.add("md2-missing");
    node.textContent = `[公式錯誤: ${tex} — ${error}]`;
    return node;
  }
  // html 是 KaTeX 自己產生的標記, 不是使用者寫的 HTML。
  node.innerHTML = html;
  node.style.fontSize = pt(tpl.body.size);
  return node;
}

function runNode(run, tpl, images) {
  if (run.br) return document.createElement("br");
  if (run.math) return mathNode(run.math, false, tpl);
  if (run.image) {
    const img = document.createElement("img");
    const found = images.get(run.image.src);
    img.src = found ? found.dataUrl : "";
    img.alt = run.image.alt || "";
    img.className = "md2-inline-img";
    if (!found) {
      const miss = document.createElement("span");
      miss.className = "md2-missing";
      miss.textContent = `[缺圖: ${run.image.alt || run.image.src}]`;
      return miss;
    }
    return img;
  }

  let node = document.createTextNode(run.text);
  const wrap = (tag, className) => {
    const w = document.createElement(tag);
    if (className) w.className = className;
    w.appendChild(node);
    node = w;
    return w;
  };
  if (run.code) {
    const c = wrap("code", "md2-codespan");
    c.style.fontFamily = `"${tpl.fonts.mono}", monospace`;
    c.style.fontSize = pt(tpl.code.size);
    // 對應 Word 的 <w:shd>: 底色跟著模板走, 沒設就不上底色。
    c.style.background = tpl.code.fill ? `#${tpl.code.fill}` : "transparent";
  }
  if (run.bold) wrap("strong");
  if (run.italic) wrap("em");
  if (run.strike) wrap("s");
  if (run.sup) wrap("sup");
  if (run.sub) wrap("sub");
  if (run.href) {
    const a = wrap("a");
    a.href = run.href;
    if (/^https?:/i.test(run.href)) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
  }
  return node;
}

function inlineInto(host, runs, tpl, images) {
  for (const run of runs || []) host.appendChild(runNode(run, tpl, images));
  return host;
}

/* ============================ 區塊 → DOM ============================ */

function applyParagraph(node, tpl, { indent = true, level = 0 } = {}) {
  node.style.fontSize = pt(tpl.body.size);
  node.style.lineHeight = lineHeight(tpl.body.line, metricStack(tpl));
  node.style.textAlign = TEXT_ALIGN[tpl.body.align] || "justify";
  node.style.marginTop = pt(tpl.body.before);
  node.style.marginBottom = pt(tpl.body.after);
  if (indent && tpl.body.indent) node.style.textIndent = `${tpl.body.indent}em`;
  if (level) node.style.marginLeft = pt(level);
  return node;
}

function captionNode(text, tpl) {
  const cap = document.createElement("div");
  cap.className = "md2-caption";
  cap.textContent = text;
  cap.style.fontSize = pt(tpl.captions.size);
  cap.style.lineHeight = lineHeight(1.15, metricStack(tpl));
  cap.style.textAlign = TEXT_ALIGN[tpl.captions.align] || "center";
  cap.dataset.atomic = "1";
  return cap;
}

function blockNodes(block, tpl, images, ctx = {}) {
  const out = [];
  const diagrams = ctx.diagrams || new Map();
  switch (block.kind) {
    case "math": {
      const node = mathNode(block.tex, true, tpl);
      node.dataset.atomic = "1";
      node.style.margin = "8pt 0";
      node.style.textAlign = "center";
      out.push(node);
      break;
    }
    case "mermaid": {
      const holder = document.createElement("div");
      holder.className = "md2-figure";
      holder.dataset.atomic = "1";
      holder.dataset.keepNext = "1";
      const found = diagrams.get(block.text);
      if (found) {
        const hint = parseSizeHint(block.hint || "");
        const contentMm = tpl.page.width - tpl.page.margin[1] - tpl.page.margin[3];
        const naturalMm = found.width * 25.4 / 96;
        let widthMm = Math.min(contentMm, hint.percent ? contentMm * hint.percent / 100 : hint.mm || naturalMm);
        const maxHeightMm = tpl.page.height - tpl.page.margin[0] - tpl.page.margin[2] - 14;
        const ratio = found.height / (found.width || 1);
        if (widthMm * ratio > maxHeightMm) widthMm = maxHeightMm / ratio;
        const box = document.createElement("div");
        box.className = "md2-diagram";
        box.style.width = mm(widthMm);
        box.style.height = mm(widthMm * ratio);
        // 向量圖直接內嵌, 印出來的線才是銳利的。mermaid 產生的 <style> 是用
        // #id 限定的, 同一頁放很多張也不會互相影響。
        box.innerHTML = found.svg;
        holder.appendChild(box);
      } else {
        const miss = document.createElement("span");
        miss.className = "md2-missing";
        miss.textContent = "[流程圖畫不出來]";
        holder.appendChild(miss);
      }
      out.push(holder);
      if (block.number || block.caption) {
        out.push(captionNode(`${block.number || ""}${block.caption || ""}`.trim(), tpl));
      }
      break;
    }
    case "heading": {
      const lv = Math.min(6, Math.max(1, block.level));
      const h = tpl.headings[lv - 1];
      const node = document.createElement(`h${lv}`);
      node.className = "md2-h";
      node.id = block.id;
      node.dataset.atomic = "1";
      node.dataset.keepNext = "1";
      if (h.breakBefore && !ctx.first) node.dataset.breakBefore = "1";
      node.style.fontSize = pt(h.size);
      node.style.fontWeight = h.bold ? "700" : "400";
      node.style.lineHeight = lineHeight(h.line, metricStack(tpl, true));
      node.style.textAlign = TEXT_ALIGN[h.align] || "left";
      node.style.marginTop = pt(h.before);
      node.style.marginBottom = pt(h.after);
      node.style.fontFamily = fontStack(tpl, true);
      if (block.number) node.appendChild(document.createTextNode(block.number));
      inlineInto(node, block.inlines, tpl, images);
      out.push(node);
      break;
    }
    case "para": {
      const node = applyParagraph(document.createElement("p"), tpl, {
        indent: !ctx.noIndent, level: ctx.indentLeft || 0,
      });
      node.className = "md2-p";
      inlineInto(node, block.inlines, tpl, images);
      out.push(node);
      break;
    }
    case "figure": {
      const hint = parseSizeHint(block.title || "");
      const altHint = parseSizeHint(block.alt || "");
      const size = hint.percent || hint.mm ? hint : altHint;
      const holder = document.createElement("div");
      holder.className = "md2-figure";
      holder.dataset.atomic = "1";
      holder.dataset.keepNext = "1";
      const found = images.get(block.src);
      if (found) {
        const img = document.createElement("img");
        img.src = found.dataUrl;
        img.alt = altHint.caption || "";
        const contentMm = tpl.page.width - tpl.page.margin[1] - tpl.page.margin[3];
        const naturalMm = found.width * 25.4 / 96;
        let widthMm = Math.min(contentMm, size.percent ? contentMm * size.percent / 100 : size.mm || naturalMm);
        // 比一頁還高的圖分頁時切不開, 只會被裁掉。先照高度縮到放得下。
        const maxHeightMm = tpl.page.height - tpl.page.margin[0] - tpl.page.margin[2] - 14;
        const ratio = found.height / (found.width || 1);
        if (widthMm * ratio > maxHeightMm) widthMm = maxHeightMm / ratio;
        img.style.width = mm(widthMm);
        holder.appendChild(img);
      } else {
        const miss = document.createElement("span");
        miss.className = "md2-missing";
        miss.textContent = `[缺圖: ${block.alt || block.src}]`;
        holder.appendChild(miss);
      }
      out.push(holder);
      const caption = hint.caption || altHint.caption;
      if (block.number || caption) out.push(captionNode(`${block.number || ""}${caption}`, tpl));
      break;
    }
    case "table": {
      const label = block.number || block.caption
        ? `${block.number || ""}${block.caption || ""}` : "";
      if (label && tpl.captions.tablePos === "above") {
        const cap = captionNode(label, tpl);
        cap.dataset.keepNext = "1";
        out.push(cap);
      }
      const table = document.createElement("table");
      table.className = "md2-table";
      table.dataset.border = tpl.table.border;
      table.style.fontSize = pt(tpl.table.size);
      table.style.lineHeight = lineHeight(1.15, metricStack(tpl));
      table.style.marginLeft = tpl.table.align === "center" ? "auto" : "0";
      table.style.marginRight = tpl.table.align === "center" ? "auto"
        : tpl.table.align === "right" ? "0" : "auto";
      if (block.header.length) {
        const thead = document.createElement("thead");
        const tr = document.createElement("tr");
        for (const c of block.header) {
          const th = document.createElement("th");
          if (tpl.table.headerFill) th.style.background = `#${tpl.table.headerFill}`;
          th.style.fontWeight = tpl.table.headerBold ? "700" : "400";
          inlineInto(th, c.inlines, tpl, images);
          tr.appendChild(th);
        }
        thead.appendChild(tr);
        table.appendChild(thead);
      }
      const tbody = document.createElement("tbody");
      for (const row of block.rows) {
        const tr = document.createElement("tr");
        row.forEach((c, i) => {
          const td = document.createElement("td");
          td.style.textAlign = TEXT_ALIGN[block.align[i]] || "left";
          inlineInto(td, c.inlines, tpl, images);
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      out.push(table);
      if (label && tpl.captions.tablePos !== "above") out.push(captionNode(label, tpl));
      break;
    }
    case "code": {
      const pre = document.createElement("pre");
      pre.className = "md2-code";
      pre.style.fontFamily = `"${tpl.fonts.mono}", monospace`;
      pre.style.fontSize = pt(tpl.code.size);
      pre.style.lineHeight = lineHeight(1.15, `"${tpl.fonts.mono}", monospace`);
      pre.style.padding = `3pt ${pt(tpl.code.pad)}`;
      if (tpl.code.fill) pre.style.background = `#${tpl.code.fill}`;
      if (!tpl.code.border) pre.style.border = "none";
      pre.textContent = String(block.text).replace(/\n+$/, "");
      out.push(pre);
      break;
    }
    case "quote": {
      const quote = document.createElement("blockquote");
      quote.className = "md2-quote";
      if (!tpl.quote.bar) quote.style.borderLeft = "none";
      // 文字縮排 indent 個字元, bar 畫在文字左邊 gap pt 處 —— Word 那邊是
      // 「ind left = 同一個縮排」加上「框線 w:space = 同一個 gap」, 位置一致。
      const textIndent = tpl.quote.indent * tpl.body.size;
      quote.style.marginLeft = pt(Math.max(0, textIndent - tpl.quote.gap));
      quote.style.paddingLeft = pt(Math.min(textIndent, tpl.quote.gap));
      for (const child of block.blocks) {
        for (const node of blockNodes(child, tpl, images, { ...ctx, noIndent: true })) {
          quote.appendChild(node);
        }
      }
      out.push(quote);
      break;
    }
    case "list": {
      const list = document.createElement(block.ordered ? "ol" : "ul");
      list.className = "md2-list";
      if (block.ordered && block.start !== 1) list.start = block.start;
      list.style.fontSize = pt(tpl.body.size);
      list.style.lineHeight = lineHeight(tpl.body.line, metricStack(tpl));
      list.style.paddingLeft = pt(tpl.list.indent * tpl.body.size);
      for (const item of block.items) {
        const li = document.createElement("li");
        li.style.marginBottom = pt(tpl.list.gap);
        item.blocks.forEach((child, i) => {
          if (child.kind === "para" && i === 0) {
            inlineInto(li, child.inlines, tpl, images);
            return;
          }
          for (const node of blockNodes(child, tpl, images, { ...ctx, noIndent: true })) {
            li.appendChild(node);
          }
        });
        list.appendChild(li);
      }
      out.push(list);
      break;
    }
    case "hr": {
      const hr = document.createElement("hr");
      hr.className = "md2-hr";
      hr.dataset.atomic = "1";
      out.push(hr);
      break;
    }
    case "pagebreak": {
      const brk = document.createElement("div");
      brk.className = "md2-forcebreak";
      brk.dataset.atomic = "1";
      brk.dataset.forceBreak = "1";
      out.push(brk);
      break;
    }
    default:
      break;
  }
  return out;
}

function fontStack(tpl, heading = false) {
  const cjk = (heading && tpl.fonts.headingCjk) || tpl.fonts.cjk;
  const latin = (heading && tpl.fonts.headingLatin) || tpl.fonts.latin;
  return `"${latin}", "${cjk}", serif`;
}

/* ============================ 切開一個已經放進頁面的元素 ============================ */

/** 這個元素裡「可以整塊搬走」的小單位。表格是列, 清單是項, 引言是段。 */
function childUnits(node) {
  if (node.tagName === "TABLE") {
    const tbody = node.querySelector("tbody");
    return tbody ? [...tbody.children] : [];
  }
  const kids = [...node.children];
  return kids.length && kids.every((k) => /^(LI|P|UL|OL|PRE|BLOCKQUOTE|DIV|TABLE|H[1-6])$/.test(k.tagName))
    ? kids : [];
}

/** 複製一個空殼（保留 class 與 style）, 表格另外把表頭原樣帶過去重印。 */
function cloneShell(node) {
  const shell = node.cloneNode(false);
  if (node.tagName === "TABLE") {
    const thead = node.querySelector("thead");
    if (thead) shell.appendChild(thead.cloneNode(true));
    shell.appendChild(document.createElement("tbody"));
  }
  if (node.tagName === "OL") {
    // 接下去的那一頁要從斷掉的地方繼續數, 不能重新從 1 開始。
    shell.start = 1;
  }
  return shell;
}

function unitHost(node) {
  return node.tagName === "TABLE" ? node.querySelector("tbody") : node;
}

/**
 * 把 node 裡超過 limitY 的部分切下來, 回傳新的一塊（放不下就回傳 null）。
 * node 必須已經在版面上 —— 位置要量得到才知道哪一行會掉出去。
 */
function splitNode(node, limitY, minKeep) {
  if (node.dataset?.atomic === "1") return null;

  const units = childUnits(node);
  if (units.length) {
    let cut = units.findIndex((u) => u.getBoundingClientRect().bottom > limitY);
    if (cut < 0) return null;
    let innerRest = null;
    if (cut === 0) {
      innerRest = splitNode(units[0], limitY, minKeep);
      if (!innerRest) return null;
      cut = 1;
    }
    const rest = cloneShell(node);
    const host = unitHost(rest);
    if (innerRest) host.appendChild(innerRest);
    if (node.tagName === "OL") {
      rest.start = (Number(node.getAttribute("start")) || 1) + cut - (innerRest ? 1 : 0);
    }
    for (const unit of units.slice(cut)) host.appendChild(unit);
    return host.childElementCount ? rest : null;
  }
  return splitText(node, limitY, minKeep);
}

/** 走訪所有文字節點, 供二分搜尋用。 */
function textNodesOf(node) {
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const list = [];
  let n = walker.nextNode();
  while (n) { if (n.length) list.push(n); n = walker.nextNode(); }
  return list;
}

/**
 * 從某一行的行首把段落切成兩段。
 *
 * 作法是二分搜尋字元位置, 用 Range 量「從段落開頭到這個字為止」的最後一行底部。
 * 一個字一個字量會慢得看得出來, 二分之後一段只要量二十次左右。
 */
function splitText(node, limitY, minKeep) {
  const texts = textNodesOf(node);
  const total = texts.reduce((sum, t) => sum + t.length, 0);
  if (total < 4) return null;

  const locate = (k) => {
    let rest = k;
    for (const t of texts) {
      if (rest <= t.length) return [t, rest];
      rest -= t.length;
    }
    const last = texts[texts.length - 1];
    return [last, last.length];
  };

  const range = document.createRange();
  const bottomAt = (k) => {
    const [t, off] = locate(k);
    range.setStart(texts[0], 0);
    range.setEnd(t, off);
    const rects = range.getClientRects();
    return rects.length ? rects[rects.length - 1].bottom : 0;
  };

  let lo = 0;
  let hi = total;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (bottomAt(mid) <= limitY) lo = mid; else hi = mid - 1;
  }
  if (lo <= 0 || lo >= total) return null;

  // 英文不能切在單字中間。中日韓文字本來就是逐字斷行, 不用retreat。
  let cut = lo;
  const whole = texts.map((t) => t.data).join("");
  if (/[A-Za-z0-9]/.test(whole[cut - 1] || "") && /[A-Za-z0-9]/.test(whole[cut] || "")) {
    while (cut > 0 && !/\s/.test(whole[cut - 1])) cut -= 1;
  }
  if (cut <= 0) return null;
  // 只留一行在上一頁看起來像失誤, 整塊搬過去比較好看。
  const top = node.getBoundingClientRect().top;
  if (bottomAt(cut) - top < minKeep) return null;

  const [t, off] = locate(cut);
  const tail = document.createRange();
  tail.selectNodeContents(node);
  tail.setStart(t, off);
  const rest = node.cloneNode(false);
  rest.appendChild(tail.extractContents());
  if (!rest.textContent.trim()) return null;
  if (rest.style) rest.style.textIndent = "0";
  return rest;
}

/* ============================ 分頁 ============================ */

function pageShell(tpl) {
  const [top, right, bottom, left] = tpl.page.margin;
  const page = document.createElement("div");
  page.className = "md2-page";
  page.style.width = mm(tpl.page.width);
  page.style.height = mm(tpl.page.height);
  page.style.fontFamily = fontStack(tpl);

  const make = (cls) => {
    const band = document.createElement("div");
    band.className = cls;
    band.style.left = mm(left);
    band.style.right = mm(right);
    return band;
  };
  const header = make("md2-band md2-header");
  header.style.top = mm(top / 2);
  header.style.fontSize = pt(tpl.header.size);
  header.style.lineHeight = lineHeight(1, metricStack(tpl));
  header.style.textAlign = TEXT_ALIGN[tpl.header.align] || "right";

  const body = make("md2-body");
  body.style.top = mm(top);
  body.style.height = mm(tpl.page.height - top - bottom);

  const footer = make("md2-band md2-footer");
  footer.style.bottom = mm(bottom / 2);
  footer.style.fontSize = pt(tpl.footer.size);
  footer.style.lineHeight = lineHeight(1, metricStack(tpl));
  footer.style.textAlign = TEXT_ALIGN[tpl.footer.align] || "center";

  page.append(header, body, footer);
  page.body = body;
  page.header = header;
  page.footer = footer;
  return page;
}

/**
 * 把一串元素倒進一疊頁面裡。
 * @returns {HTMLElement[]} 每一頁
 */
function flow(nodes, tpl, host) {
  const pages = [];
  let page = null;
  let body = null;
  const minKeep = tpl.body.size * tpl.body.line * 1.6 * 96 / 72; // 大約兩行

  const newPage = () => {
    page = pageShell(tpl);
    host.appendChild(page);
    body = page.body;
    pages.push(page);
    return page;
  };
  newPage();

  const overflowing = () => body.scrollHeight > body.clientHeight + 1;

  for (const original of nodes) {
    if (original.dataset?.forceBreak === "1") {
      if (body.childElementCount) newPage();
      continue;
    }
    if (original.dataset?.breakBefore === "1" && body.childElementCount) newPage();

    let node = original;
    body.appendChild(node);

    let guard = 0;
    while (overflowing() && (guard += 1) < 400) {
      const limitY = body.getBoundingClientRect().top + body.clientHeight;
      const rest = splitNode(node, limitY, minKeep);
      if (rest) {
        newPage();
        body.appendChild(rest);
        node = rest;
        continue;
      }
      // 切不開就整塊搬到下一頁。頁面上只有它自己的話就只能硬塞,
      // 否則會永遠搬不完。
      if (body.firstElementChild === node) break;
      body.removeChild(node);
      // 標題不能跟它的內文分家, 一起帶過去。
      const stranded = body.lastElementChild?.dataset?.keepNext === "1"
        && body.childElementCount > 1
        ? body.lastElementChild : null;
      if (stranded) body.removeChild(stranded);
      newPage();
      if (stranded) body.appendChild(stranded);
      body.appendChild(node);
    }
  }
  return pages;
}

/* ============================ 封面與目錄 ============================ */

function coverNodes(meta, tpl) {
  const out = [];
  const values = { ...meta };
  if (!values.date && tpl.cover.dateFormat) values.date = today(tpl.cover.dateFormat);

  for (const f of tpl.cover.fields) {
    const value = values[f.key];
    if (!value) continue;
    // 逗號類分隔符同時接受半形逗號與頓號，方便中英文鍵盤混用。
    const separator = f.split === "," || f.split === "、" ? /[,、]/ : f.split;
    const pieces = separator ? String(value).split(separator).map((s) => s.trim()).filter(Boolean) : [value];
    pieces.forEach((piece, i) => {
      const line = document.createElement("div");
      line.className = "md2-cover-line";
      line.dataset.atomic = "1";
      line.textContent = `${i === 0 || f.repeatPrefix ? f.prefix : ""}${piece}`;
      line.style.fontSize = pt(f.size);
      line.style.lineHeight = lineHeight(COVER_LINE, metricStack(tpl, true));
      line.style.fontWeight = f.bold ? "700" : "400";
      line.style.marginTop = pt(i === 0 ? f.gap : 0);
      line.style.textAlign = TEXT_ALIGN[f.align || tpl.cover.align] || "center";
      line.style.fontFamily = fontStack(tpl, true);
      out.push(line);
    });
    if (f.key === "title" && tpl.cover.rule) {
      const rule = document.createElement("div");
      rule.className = "md2-cover-rule";
      rule.dataset.atomic = "1";
      out.push(rule);
    }
  }
  return out;
}

function tocNodes(outline, tpl, pageOf, frontOffset) {
  const out = [];
  const title = document.createElement("div");
  title.className = "md2-toc-title";
  title.dataset.atomic = "1";
  title.textContent = tpl.toc.title;
  title.style.fontSize = pt(tpl.headings[0].size);
  title.style.fontFamily = fontStack(tpl, true);
  out.push(title);

  for (const item of outline) {
    const row = document.createElement("a");
    row.className = "md2-toc-row";
    row.dataset.atomic = "1";
    row.href = `#${item.id}`;
    row.style.fontSize = pt(tpl.body.size);
    row.style.paddingLeft = pt((item.level - 1) * tpl.toc.indent * tpl.body.size);

    const label = document.createElement("span");
    label.className = "md2-toc-text";
    label.textContent = `${item.number || ""}${item.text}`;
    row.appendChild(label);

    if (tpl.toc.pageNumbers) {
      const dots = document.createElement("span");
      dots.className = tpl.toc.leader === "none" ? "md2-toc-gap" : "md2-toc-dots";
      row.appendChild(dots);
      const num = document.createElement("span");
      num.className = "md2-toc-page";
      num.textContent = String((pageOf.get(item.id) || 0) + frontOffset);
      row.appendChild(num);
    }
    out.push(row);
  }
  return out;
}

/* ============================ 對外 ============================ */

/**
 * 量測用的暫存區。
 *
 * 分頁全靠 getBoundingClientRect 與 scrollHeight, 所以頁面必須真的在版面上、
 * 而且是原尺寸 —— 看得到的那份預覽會被 transform 縮小, 在那裡量出來的座標
 * 全都要再除以縮放比, 一個地方忘了除就斷在錯的行。乾脆固定在畫面外量,
 * 量完再把整頁搬過去（搬動不需要重新量）。
 */
function stage() {
  let node = document.getElementById("md2-stage");
  if (!node) {
    node = document.createElement("div");
    node.id = "md2-stage";
    node.className = "md2-stage";
    document.body.appendChild(node);
  }
  // 量測區也走 shadow DOM, 條件才跟看得到的那份與列印的那份完全一致。
  return createPaperSurface(node);
}

/**
 * 排版。把一頁一頁的 div 掛到 host 底下。
 *
 * @returns {{pages:number, bodyPages:number, frontPages:number, pageOf:Map<string,number>}}
 */
export function paginate(host, { blocks, meta, tpl, outline, images, diagrams }) {
  const work = stage();

  // 先排內文, 目錄才知道每一章落在第幾頁。目錄自己佔幾頁不會影響內文的頁碼
  //（內文從 1 重新數）, 所以這個順序不會咬到自己 —— 除非模板選了連續編號,
  // 那種情況下面再迭代收斂。
  const bodyNodes = [];
  blocks.forEach((block, i) => {
    bodyNodes.push(...blockNodes(block, tpl, images, { first: i === 0, diagrams }));
  });
  const bodyPages = flow(bodyNodes, tpl, work);

  const pageOf = new Map();
  bodyPages.forEach((page, index) => {
    for (const h of page.querySelectorAll(".md2-h[id]")) {
      if (!pageOf.has(h.id)) pageOf.set(h.id, index + 1);
    }
  });

  const coverPages = tpl.cover.enabled ? flow(coverNodes(meta, tpl), tpl, work) : [];
  for (const page of coverPages) page.classList.add("is-cover");

  let tocPages = [];
  if (tpl.toc.enabled && outline.length) {
    // 連續編號時, 目錄上的頁碼要把封面與目錄自己算進去 —— 但「目錄自己幾頁」
    // 又要排完才知道。從估一頁開始跑, 頁數不再變動就收斂了（最多三輪）。
    const continuous = tpl.sections.frontMatter === "continue";
    let guess = 1;
    for (let round = 0; round < 3; round += 1) {
      for (const page of tocPages) page.remove();
      const offset = continuous ? coverPages.length + guess : 0;
      tocPages = flow(tocNodes(outline, tpl, pageOf, offset), tpl, work);
      if (!continuous || tocPages.length === guess) break;
      guess = tocPages.length;
    }
    for (const page of tocPages) page.classList.add("is-front");
  }

  stampBands(coverPages, tocPages, bodyPages, meta, tpl);

  // 量完了才搬到看得到的地方, 順序改成封面 → 目錄 → 內文。
  host.replaceChildren(...coverPages, ...tocPages, ...bodyPages);

  return {
    pages: coverPages.length + tocPages.length + bodyPages.length,
    bodyPages: bodyPages.length,
    frontPages: coverPages.length + tocPages.length,
    pageOf,
  };
}

/** 填頁首頁尾。封面不放, 前置頁與內文各自從 1 開始數。 */
function stampBands(coverPages, tocPages, bodyPages, meta, tpl) {
  const useRoman = tpl.sections.frontMatter === "roman";
  const continuous = tpl.sections.frontMatter === "continue";
  const hidden = tpl.sections.frontMatter === "none";

  const write = (pages, { start, total, fmt, show }) => {
    pages.forEach((page, i) => {
      const n = start + i;
      const label = fmt === "roman" ? roman(n) : String(n);
      const values = { ...meta, page: label, pages: String(total) };
      page.header.textContent = show ? fill(tpl.header.text, values) : "";
      page.footer.textContent = show ? fill(tpl.footer.text, values) : "";
    });
  };

  write(coverPages, { start: 1, total: 1, fmt: "decimal", show: false });
  if (continuous) {
    const all = [...tocPages, ...bodyPages];
    write(all, { start: coverPages.length + 1, total: coverPages.length + all.length, fmt: "decimal", show: true });
  } else {
    write(tocPages, { start: 1, total: tocPages.length, fmt: useRoman ? "roman" : "decimal", show: !hidden });
    write(bodyPages, { start: 1, total: bodyPages.length, fmt: "decimal", show: true });
  }
}
