// js/utils/markdown.js — Markdown → HTML 的渲染流程。
//
// 需要時才從 jsdelivr 載入: marked@4（舊版 renderer API）、highlight.js、
// KaTeX（含 auto-render）、mermaid。
// 支援圖片、圖片連結、原生 HTML（工具佔位就是靠它）、程式碼區塊（語法上色）、
// 表格、清單、LaTeX（$…$、$$…$$）、Mermaid，以及標題大綱。

import { escapeHtml, slugify } from "./utils.js";

/** 相對路徑的圖片基準資料夾。 */
const DEFAULT_IMAGE_BASE = "assets/images/content";

const CDN = {
  marked: "https://cdn.jsdelivr.net/npm/marked@4.3.0/marked.min.js",
  hljs: "https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.9.0/highlight.min.js",
  katex: "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js",
  katexCss: "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css",
  katexAuto: "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js",
  mermaid: "https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js",
};

let libsPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-md-src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded) return resolve();
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error(`載入失敗: ${src}`)));
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = false;
    s.dataset.mdSrc = src;
    s.addEventListener("load", () => { s.dataset.loaded = "1"; resolve(); });
    s.addEventListener("error", () => reject(new Error(`載入失敗: ${src}`)));
    document.head.appendChild(s);
  });
}

function loadCss(href) {
  if (document.querySelector(`link[data-md-css="${href}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.dataset.mdCss = href;
  document.head.appendChild(link);
}

/** 確保渲染用的函式庫都載好了（重複呼叫安全）。 */
export function loadMarkdownLibs() {
  if (libsPromise) return libsPromise;
  loadCss(CDN.katexCss);
  // highlight.js 的配色寫在 css/viewer.css，全部走主題變數，所以不載 CDN 主題。
  libsPromise = (async () => {
    await Promise.all([loadScript(CDN.marked), loadScript(CDN.hljs)]);
    await loadScript(CDN.katex);
    await loadScript(CDN.katexAuto);
    await loadScript(CDN.mermaid);
    if (window.mermaid) {
      window.mermaid.initialize({
        startOnLoad: false,
        securityLevel: "loose",
        theme: "dark",
        fontFamily: "var(--font-family)",
        flowchart: {
          curve: "basis",
          nodeSpacing: 36,
          rankSpacing: 48,
          padding: 12,
          useMaxWidth: false,
          htmlLabels: true,
        },
        themeVariables: {
          background: "#121212",
          primaryColor: "#252525",
          primaryTextColor: "#ffffff",
          primaryBorderColor: "#8f8f8f",
          secondaryColor: "#393939",
          secondaryTextColor: "#ffffff",
          secondaryBorderColor: "#666666",
          tertiaryColor: "#121212",
          tertiaryTextColor: "#ffffff",
          tertiaryBorderColor: "#666666",
          lineColor: "#a0a0a0",
          textColor: "#ffffff",
          titleColor: "#ffffff",
          edgeLabelBackground: "#121212",
          clusterBkg: "#252525",
          clusterBorder: "#666666",
          fontSize: "15px",
        },
      });
    }
  })().catch((err) => { libsPromise = null; throw err; });
  return libsPromise;
}

/** 改寫圖片路徑: 先套舊前綴對照，其餘相對路徑補上基準資料夾。 */
function rewriteImageSrc(src) {
  const raw = String(src || "").trim();
  if (!raw) return raw;
  // 絕對網址、根路徑、已經指到 assets/ 的都原樣放行。
  if (/^(https?:)?\/\//i.test(raw) || raw.startsWith("/") ||
      raw.startsWith("data:") || raw.startsWith("assets/")) {
    return raw;
  }
  return `${DEFAULT_IMAGE_BASE}/${raw.replace(/^\.\//, "")}`;
}

function buildRenderer() {
  const renderer = new window.marked.Renderer();
  const usedIds = new Set();

  renderer.heading = (text, level, raw) => {
    const id = slugify(raw) || `sec-${level}`;
    let unique = id, n = 2;
    while (usedIds.has(unique)) unique = `${id}-${n++}`;
    usedIds.add(unique);
    // id 要留著（大綱與捲動定位都靠它），但不放可見的錨點符號。
    return `<h${level} id="${unique}" class="doc-heading" data-level="${level}">${text}</h${level}>\n`;
  };

  renderer.image = (href, title, text) => {
    const src = rewriteImageSrc(href);
    const alt = escapeHtml(text || "");
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    const img = `<img src="${escapeHtml(src)}" alt="${alt}"${titleAttr} loading="lazy" class="doc-img">`;
    // alt / title 會在滑過圖片時當成說明浮出來。用 <span>（樣式設成 block）而不是
    // <figure>: 後者放在 marked 產生的 <p> 裡不合法，會被 HTML parser 拉出去，把段落切斷。
    const caption = title || text || "";
    if (!caption) return img;
    return `<span class="doc-figure">${img}`
      + `<span class="doc-figure-cap">${escapeHtml(caption)}</span></span>`;
  };

  renderer.code = (code, infostring) => {
    const lang = (infostring || "").trim().split(/\s+/)[0].toLowerCase();
    if (lang === "mermaid") {
      return `<pre class="mermaid">${escapeHtml(code)}</pre>`;
    }
    const hljs = window.hljs;
    if (hljs && lang && hljs.getLanguage(lang)) {
      try {
        const out = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
        return `<pre class="code-block"><code class="hljs language-${lang}">${out}</code></pre>`;
      } catch { /* 落到下面的自動判斷 */ }
    }
    if (hljs) {
      try {
        const out = hljs.highlightAuto(code).value;
        return `<pre class="code-block"><code class="hljs">${out}</code></pre>`;
      } catch { /* 落到純文字 */ }
    }
    return `<pre class="code-block"><code>${escapeHtml(code)}</code></pre>`;
  };

  // 表格外包一層，圓角與 overflow 交給外層處理 —— border-collapse 的表格切不出自己的圓角。
  renderer.table = (header, body) => {
    const tbody = body ? `<tbody>${body}</tbody>` : "";
    return `<div class="table-wrap"><table><thead>${header}</thead>${tbody}</table></div>\n`;
  };

  // 外部連結開新分頁；站內 hash 連結維持原本行為。
  renderer.link = (href, title, text) => {
    const url = String(href || "");
    const external = /^https?:\/\//i.test(url);
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    const relTarget = external ? ' target="_blank" rel="noopener noreferrer"' : "";
    return `<a href="${escapeHtml(url)}"${titleAttr}${relTarget}>${text}</a>`;
  };

  return renderer;
}

/**
 * marked 4 遇到 `**文字（abbr）**: ` 這種、右括號後面直接接中文標點的情況，
 * 有時會整段不處理。先把這個特例換成語意 HTML，作者就能照常用中文標點。
 */
function normalizeStrongBeforeCjkPunctuation(markdown) {
  return String(markdown).replace(
    /\*\*([^*\r\n]+[)\]）】])\*\*(?=[: ；，。、！？])/g,
    "<strong>$1</strong>",
  );
}

/**
 * 把 Markdown 轉成 HTML 字串。
 * 呼叫前必須先 await loadMarkdownLibs()。
 */
export function renderMarkdown(mdText) {
  if (!window.marked) throw new Error("Markdown 函式庫尚未載入");
  window.marked.setOptions({
    renderer: buildRenderer(),
    gfm: true,
    breaks: false,
    headerIds: false, // 標題 id 由上面的 renderer 自己產生
    mangle: false,
    smartLists: true,
  });
  return window.marked.parse(normalizeStrongBeforeCjkPunctuation(mdText));
}

/** 對已經填好內容的容器跑 KaTeX 與 Mermaid。 */
export async function enhanceMarkdown(container) {
  if (!container) return;
  if (window.renderMathInElement) {
    try {
      window.renderMathInElement(container, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "$", right: "$", display: false },
          { left: "\\(", right: "\\)", display: false },
          { left: "\\[", right: "\\]", display: true },
        ],
        throwOnError: false,
      });
    } catch (err) { console.warn("KaTeX 渲染問題: ", err); }
  }
  const diagrams = container.querySelectorAll("pre.mermaid");
  if (diagrams.length && window.mermaid) {
    try { await window.mermaid.run({ nodes: diagrams }); }
    catch (err) { console.warn("Mermaid 渲染問題: ", err); }
  }
}

/** 從已渲染的 DOM 取出標題大綱。 */
export function extractOutline(container) {
  const nodes = container.querySelectorAll("h1, h2, h3, h4, h5, h6");
  return Array.from(nodes).map((node) => ({
    id: node.id,
    level: Number(node.dataset.level || node.tagName.slice(1)),
    text: node.textContent.trim(),
  }));
}

/** 去掉 .md 檔頭那一段 `<!-- key: value -->` 註解。 */
export function stripFrontmatterComments(md) {
  const lines = String(md).split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line === "" || /^<!--[\s\S]*-->$/.test(line)) i++;
    else break;
  }
  return lines.slice(i).join("\n");
}
