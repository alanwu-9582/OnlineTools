// js/tools/md2docs/math.js — LaTeX 數學式。
//
// 預覽走 KaTeX（網站本來就載了, 不是新的相依）, .docx 走 OMML ——
// Word 自己的數學格式, 進到 Word 裡是可以點進去編輯的真公式, 不是一張圖。
//
// 中間那一段轉換不是自己刻 LaTeX 解析器: KaTeX 可以輸出 MathML,
// 而 MathML → OMML 的對應是一張很直接的表（msup→sSup、mfrac→f、msqrt→rad…）。
// 難的部分（解析 LaTeX）交給 KaTeX, 這裡只做搬運。
//
// 支援到的範圍: 上下標、分式、根號、上下極限與大運算子、重音（bar/hat/vec）、
// 矩陣、成對括號、函數名（lim/sin 保持正體）。超出範圍的節點會原樣輸出文字,
// 不會整份轉換失敗。

const KATEX_FALLBACK = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css";

/** Word 的數學字型。不指定的話公式會用內文字型排, 符號會缺字。 */
const MATH_FONT = '<w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/></w:rPr>';

/** 看不見的控制字元（函數套用、不可見乘號…）, 搬到 Word 只會變成豆腐。 */
const INVISIBLE = new Set(["⁡", "⁢", "⁣", "⁤", "​"]);

// \left … \right 的成對括號。不在這張表裡的（|、∥ 之類）跟自己配對。
const OPENERS = "([{⟨⌈⌊";
const CLOSERS = ")]}⟩⌉⌋";

function x(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ============================ 預覽（KaTeX） ============================ */

/**
 * @param {string} tex
 * @param {boolean} display 獨立成行的公式
 * @returns {{html: string, error: string}}
 */
export function renderMath(tex, display = false) {
  if (!window.katex) return { html: "", error: "KaTeX 尚未載入" };
  try {
    // output:"html" —— 預設會同時輸出一份藏起來的 MathML, 萬一 CSS 沒到位
    // 就會兩份疊著顯示。預覽不需要那份無障礙標記。
    return {
      html: window.katex.renderToString(tex, {
        displayMode: display, output: "html", throwOnError: true,
      }),
      error: "",
    };
  } catch (err) {
    return { html: "", error: err.message.replace(/^KaTeX parse error:\s*/, "") };
  }
}

/** 實際載入中的 KaTeX 樣式表網址。 */
export function katexHref() {
  return document.querySelector("link[data-md-css]")?.href || KATEX_FALLBACK;
}

/**
 * KaTeX 的樣式表內容, 字型網址改成絕對路徑。
 *
 * 紙畫在 shadow DOM 裡, <head> 那份 KaTeX CSS 照不進去, 必須把內容一起塞進影子。
 * 但 CSS 一旦變成 <style> 的文字, 裡面的 url(fonts/…) 就會相對於「文件」而不是
 * 原本那支 CSS, 字型全部 404 —— 所以要先補成絕對網址。
 *
 * 讀不到內容是有前例的: Service Worker 可能先替 <link> 收了一份 opaque 回應,
 * 之後這裡 fetch 同一個網址就會拿到那一份, `.text()` 回傳空字串而且不報錯。
 * 所以拿到空的時候換一個查詢字串再試一次, 繞過那筆快取。
 */
export async function katexStyles() {
  const href = katexHref();
  const base = href.replace(/[^/]*$/, "");
  const grab = async (url) => {
    const res = await fetch(url);
    if (res.type === "opaque") return "";
    return res.text();
  };
  let css = "";
  try { css = await grab(href); } catch { css = ""; }
  if (!css.includes("KaTeX_Main")) {
    try { css = await grab(`${href}${href.includes("?") ? "&" : "?"}md2docs=1`); } catch { css = ""; }
  }
  if (!css.includes("KaTeX_Main")) return "";
  return css.replace(/url\((['"]?)(?!https?:|data:|\/)/g, `url($1${base}`);
}

let fontsReady = null;

/**
 * 先把 KaTeX 的字型逼出來載完再排版。
 * 字型還沒到就量高度的話, 公式會用備援字型的尺寸算, 分頁位置跟著錯。
 */
export function ensureMathFonts() {
  if (fontsReady) return fontsReady;
  fontsReady = (async () => {
    if (!window.katex || !document.fonts) return;
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;left:-9999px;top:0;visibility:hidden";
    probe.innerHTML = renderMath("\\sum_{i=1}^{n}\\frac{\\sqrt{x_i}}{\\alpha}", true).html;
    document.body.appendChild(probe);
    try { await document.fonts.ready; } finally { probe.remove(); }
  })();
  return fontsReady;
}

/* ============================ .docx（OMML） ============================ */

function runXml(text, { plain = false } = {}) {
  const body = [...String(text)].filter((c) => !INVISIBLE.has(c)).join("");
  if (!body) return "";
  const style = plain ? '<m:rPr><m:sty m:val="p"/></m:rPr>' : "";
  return `<m:r>${style}${MATH_FONT}<m:t xml:space="preserve">${x(body)}</m:t></m:r>`;
}

const elementsOf = (node) => [...node.children];

function wrap(tag, inner) {
  return `<${tag}>${inner || runXml("")}</${tag}>`;
}

/**
 * 成對的括號 → m:d, Word 會自己把括號撐到跟內容一樣高。
 *
 * 只認 fence="true" —— KaTeX 只有在 \left … \right 才會標這個屬性。
 * 直接打的 `(` 是普通字元, 本來就不該自動放大, 留著當一般文字才對。
 */
function fenceChar(node) {
  if (node.tagName !== "mo" || node.getAttribute("fence") !== "true") return "";
  const ch = node.textContent.trim();
  return ch.length === 1 ? ch : "";
}

function matchingClose(nodes, from, open) {
  const want = OPENERS.includes(open) ? CLOSERS[OPENERS.indexOf(open)] : open;
  let depth = 0;
  for (let i = from + 1; i < nodes.length; i += 1) {
    const ch = fenceChar(nodes[i]);
    if (!ch) continue;
    if (ch === open && want !== open) { depth += 1; continue; }
    if (ch === want) {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
}

function seriesToOmml(nodes) {
  let out = "";
  for (let i = 0; i < nodes.length; i += 1) {
    const open = fenceChar(nodes[i]);
    const close = open ? matchingClose(nodes, i, open) : -1;
    if (close > 0) {
      const inner = seriesToOmml(nodes.slice(i + 1, close));
      const endChar = fenceChar(nodes[close]);
      out += "<m:d><m:dPr>"
        + `<m:begChr m:val="${x(open)}"/><m:endChr m:val="${x(endChar)}"/>`
        + "</m:dPr>" + wrap("m:e", inner) + "</m:d>";
      i = close;
      continue;
    }
    out += toOmml(nodes[i]);
  }
  return out;
}

function childrenToOmml(node) {
  return seriesToOmml(elementsOf(node));
}

function toOmml(node) {
  const kids = elementsOf(node);
  const c = (i) => (kids[i] ? toOmml(kids[i]) : "");

  switch (node.tagName) {
    case "annotation":
    case "mphantom":
      return "";
    case "math":
    case "semantics":
    case "mrow":
    case "mstyle":
    case "mpadded":
    case "menclose":
    case "mtd":
      return childrenToOmml(node);
    case "mi":
      // 一個字母是變數（Word 自動斜體）, 多個字母是函數名, 要保持正體。
      return runXml(node.textContent, {
        plain: node.getAttribute("mathvariant") === "normal" || node.textContent.trim().length > 1,
      });
    case "mn":
    case "mo":
      return runXml(node.textContent);
    case "mtext":
      return runXml(node.textContent, { plain: true });
    case "mspace":
      return runXml(" ", { plain: true });
    case "msup":
      return `<m:sSup>${wrap("m:e", c(0))}${wrap("m:sup", c(1))}</m:sSup>`;
    case "msub":
      return `<m:sSub>${wrap("m:e", c(0))}${wrap("m:sub", c(1))}</m:sSub>`;
    case "msubsup":
      return `<m:sSubSup>${wrap("m:e", c(0))}${wrap("m:sub", c(1))}${wrap("m:sup", c(2))}</m:sSubSup>`;
    case "mfrac":
      return `<m:f><m:fPr><m:type m:val="bar"/></m:fPr>`
        + `${wrap("m:num", c(0))}${wrap("m:den", c(1))}</m:f>`;
    case "msqrt":
      return '<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/>'
        + wrap("m:e", childrenToOmml(node)) + "</m:rad>";
    case "mroot":
      return '<m:rad><m:radPr><m:degHide m:val="0"/></m:radPr>'
        + `${wrap("m:deg", c(1))}${wrap("m:e", c(0))}</m:rad>`;
    case "mover": {
      // accent="true" 是 \bar \hat \vec 這一類, 要貼著字母；其餘是上限。
      if (node.getAttribute("accent") === "true") {
        const chr = kids[1]?.textContent.trim() || "";
        return `<m:acc><m:accPr><m:chr m:val="${x(chr)}"/></m:accPr>${wrap("m:e", c(0))}</m:acc>`;
      }
      return `<m:limUpp>${wrap("m:e", c(0))}${wrap("m:lim", c(1))}</m:limUpp>`;
    }
    case "munder":
      return `<m:limLow>${wrap("m:e", c(0))}${wrap("m:lim", c(1))}</m:limLow>`;
    case "munderover":
      return "<m:limUpp>"
        + wrap("m:e", `<m:limLow>${wrap("m:e", c(0))}${wrap("m:lim", c(1))}</m:limLow>`)
        + wrap("m:lim", c(2))
        + "</m:limUpp>";
    case "mtable": {
      const rows = elementsOf(node).filter((r) => r.tagName === "mtr");
      const cols = Math.max(1, ...rows.map((r) => elementsOf(r).length));
      const body = rows.map((r) =>
        `<m:mr>${elementsOf(r).map((cell) => wrap("m:e", toOmml(cell))).join("")}</m:mr>`).join("");
      return "<m:m><m:mPr><m:mcs><m:mc><m:mcPr>"
        + `<m:count m:val="${cols}"/><m:mcJc m:val="center"/>`
        + "</m:mcPr></m:mc></m:mcs></m:mPr>" + body + "</m:m>";
    }
    default:
      return kids.length ? childrenToOmml(node) : runXml(node.textContent);
  }
}

/**
 * LaTeX → OMML。
 * @returns {{omml: string, error: string}} 轉不出來時 omml 為空字串。
 */
export function mathToOmml(tex, display = false) {
  if (!window.katex) return { omml: "", error: "KaTeX 尚未載入" };
  let mathml;
  try {
    mathml = window.katex.renderToString(tex, {
      displayMode: display, output: "mathml", throwOnError: true,
    });
  } catch (err) {
    return { omml: "", error: err.message.replace(/^KaTeX parse error:\s*/, "") };
  }
  const doc = new DOMParser().parseFromString(mathml, "text/html");
  const root = doc.querySelector("math");
  if (!root) return { omml: "", error: "KaTeX 沒有輸出 MathML" };
  const body = toOmml(root);
  return { omml: body ? `<m:oMath>${body}</m:oMath>` : "", error: "" };
}
