// js/tools/md2docs/index.js — MD2DOCS: 用 Markdown 寫報告, 產出可以繳交的 .docx / PDF。
//
// 介面刻意只有兩欄: 左邊寫字, 右邊就是印出來的樣子。中間沒有「設定」分頁,
// 因為使用者真正要調的只有一件事 —— 換一個模板去符合這門課的要求。
//
// 流程:
//   Markdown ──extractMeta──▶ 封面欄位 + 內文
//                              │
//                     buildDocument（marked 斷詞 + 編號）
//                              │
//                  ┌───────────┴───────────┐
//              paginate（量測分頁）      buildDocx（OOXML）
//                  │                        ▲
//                  └── 每章在第幾頁 ─────────┘
//
// 頁碼只算一次, 預覽、列印、.docx 目錄拿到的是同一組數字。

import {
  panel, actions, field, button, select, textArea, status, note, subhead, el,
} from "../kit.js";
import { notify } from "../../ui/notifications.js";
import { loadMarkdownLibs } from "../../utils/markdown.js";
import { escapeHtml, debounce } from "../../utils/utils.js";
import { extractMeta } from "./meta.js";
import { buildDocument, outlineOf } from "./doc-model.js";
import { presets, presetById, normalizeTemplate, toEditableJson } from "./templates.js";
import { collectImageSources, resolveImages } from "./images.js";
import { collectDiagrams, renderDiagrams } from "./diagram.js";
import { ensureMathFonts, katexHref } from "./math.js";
import { paginate, createPaperSurface, paperStyles } from "./paper.js";
import { buildDocx } from "./docx.js";

export const styles = new URL("./md2docs.css", import.meta.url).href;
export const meta = { title: "MD2DOCS" };

const STORE_KEY = "md2docs:v1";

/**
 * 開箱看到的預設內容。
 *
 * 刻意排成一份像樣的報告, 而不是一張語法清單 —— 使用者第一眼要看到的是
 * 「原來交出去會長這樣」。但它同時把每一種支援的寫法都用過一遍:
 * 封面註解、三層標題、有序／無序／巢狀／待辦清單、行內樣式、上下標、
 * 連結、表格（含對齊與粗體標題）、引言、程式碼、行內與獨立公式、
 * 流程圖、分隔線、強制分頁。改掉哪一段都還是一份完整的報告。
 */
const SAMPLE = `<!--
  school: 國立臺北科技大學
  department: 材料及資源工程系
  course: 材料科學實驗
  title: 金相組織觀察與硬度量測
  subtitle: 第三次實驗報告
  instructor: 王大明
  class: 材料三甲
  group: 第 4 組
  student_id: 112345678
  author: 王小明
-->

# 實驗目的

觀察低碳鋼在不同**冷卻速率**下的金相組織, 量測其硬度, 並建立*組織與機械性質*之間的關聯。

試片依 [ASTM E3](https://www.astm.org/e0003-11r17.html) 的流程製備, 腐蝕液為 2 % 硝酸酒精（HNO~3~ 與 C~2~H~5~OH）, 腐蝕時間約 10^1^ 秒。

## 分工與進度

- [x] 試片編號與熱處理條件對照
- [x] 硬度計校正
- [ ] 晶粒尺寸量測（下週補做）

# 實驗原理

## 相變化

低碳鋼加熱至沃斯田鐵區後, 冷卻速率決定最終的組織:

- **爐冷** —— 肥粒鐵 + 波來鐵
  - 冷卻速率最慢
  - 晶粒最粗大
- **空冷** —— 細波來鐵
- **水淬** —— 麻田散鐵

## 硬度換算

硬度與抗拉強度的經驗關係為 $\\sigma_{UTS} \\approx 3.45 \\times HB$（單位 MPa）。

晶粒尺寸與降伏強度之間則是 Hall–Petch 關係:

$$
\\sigma_y = \\sigma_0 + \\frac{k_y}{\\sqrt{d}}
$$

其中 $d$ 為平均晶粒直徑, $k_y$ 為材料常數。

### 量測條件

洛氏硬度 B 標尺, 荷重 100 kgf, 每個試片取五點後取平均。

# 實驗步驟

**金相試片的製備流程**

\`\`\`mermaid =75%
flowchart LR
  A[取樣] --> B[鑲埋]
  B --> C[研磨]
  C --> D[拋光]
  D --> E{表面平整?}
  E -->|否| C
  E -->|是| F[腐蝕]
  F --> G[顯微鏡觀察]
\`\`\`

原始數據以下列格式記錄, 再交給試算表計算平均:

\`\`\`python
samples = [
    {"id": "A", "cooling": "furnace", "hrb": 68},
    {"id": "B", "cooling": "air",     "hrb": 82},
]
mean = sum(s["hrb"] for s in samples) / len(samples)
\`\`\`

<!-- pagebreak -->

# 實驗結果

**各試片的硬度與主要組織**

| 試片 | 冷卻方式 | 硬度 (HRB) | 主要組織 |
| :--- | :---: | ---: | :--- |
| A | 爐冷 | 68 | 肥粒鐵 + 波來鐵 |
| B | 空冷 | 82 | 細波來鐵 |
| C | 水淬 | 97 | 麻田散鐵 |

> 水淬試片的邊緣出現微裂紋, 推測為淬火應力所致。
>
> 已拍照存檔, 影像判讀見下一節。

---

# 結論

1. 冷卻速率越快, 硬度越高, 與理論預期一致。
2. 水淬試片硬度最高, 但韌性明顯下降:
   1. 邊緣出現微裂紋
   2. 需要再經過回火處理
3. 若要兼顧強度與韌性, 應在淬火後回火。

~~原本預計加做衝擊試驗~~（設備維修中, 改列入下次實驗）。

插圖的寫法是 \`![說明](圖.png "說明 =60%")\`, 把圖檔一起拖進工具, 就會用檔名對上。
`;

/* ============================ 小工具 ============================ */

function safeFileName(name) {
  return String(name || "報告").replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 80) || "報告";
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.markdown === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function highlightInline(source) {
  const pattern = /(`[^`\n]+`)|(!?\[[^\]\n]*\]\([^\n)]*\))|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(~~[^~\n]+~~)|(\$[^$\n]+\$)|(<[^>\n]+>)/g;
  let html = "";
  let at = 0;
  for (const match of source.matchAll(pattern)) {
    html += escapeHtml(source.slice(at, match.index));
    const kind = match[1] ? "code" : match[2] ? "link" : match[3] ? "strong"
      : match[4] ? "strike" : match[5] ? "math" : "tag";
    html += `<span class="md2-syn-${kind}">${escapeHtml(match[0])}</span>`;
    at = match.index + match[0].length;
  }
  return html + escapeHtml(source.slice(at));
}

/* ============================ 編輯器的鍵盤行為 ============================ */

/**
 * 所有改動都走 execCommand("insertText")。
 *
 * 直接寫 textarea.value 會把瀏覽器的復原堆疊整個清掉 —— 使用者按 Ctrl+Z
 * 只會跳回很久以前, 或者根本沒反應。execCommand 是目前唯一能「以使用者的名義」
 * 改內容、讓復原／重做照常運作的方法, 雖然它掛著 deprecated 的名字。
 */
function typeInto(area, text) {
  area.focus();
  if (!document.execCommand("insertText", false, text)) {
    // 真的不支援時退而求其次: 內容正確優先, 復原紀錄只好放棄。
    const { selectionStart: from, selectionEnd: to } = area;
    area.setRangeText(text, from, to, "end");
    area.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

/** 游標所在的那一行（含首尾位置）。 */
function currentLine(area) {
  const value = area.value;
  const start = value.lastIndexOf("\n", area.selectionStart - 1) + 1;
  let end = value.indexOf("\n", area.selectionEnd);
  if (end < 0) end = value.length;
  return { start, end, text: value.slice(start, end) };
}

const INDENT = "  ";

/** Tab／Shift+Tab: 縮排。有選取就整段一起動, 沒選取就只在游標處插兩格。 */
function handleIndent(area, outdent) {
  const value = area.value;
  const from = value.lastIndexOf("\n", area.selectionStart - 1) + 1;
  let to = value.indexOf("\n", area.selectionEnd);
  if (to < 0) to = value.length;
  const multi = value.slice(area.selectionStart, area.selectionEnd).includes("\n");

  if (!multi && !outdent) { typeInto(area, INDENT); return; }

  const lines = value.slice(from, to).split("\n");
  const next = lines.map((line) => (outdent
    ? line.replace(/^(\t| {1,2})/, "")
    : (line.trim() ? INDENT + line : line)));
  if (next.join("\n") === lines.join("\n")) return;
  area.setSelectionRange(from, to);
  typeInto(area, next.join("\n"));
  area.setSelectionRange(from, from + next.join("\n").length);
}

/** 清單／引言的行首記號。 */
const ITEM = /^(\s*)(?:([-+*])|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?/;
const QUOTE = /^(\s*>+\s?)/;

/**
 * Enter: 自動接續清單與引言。
 * 空項目上再按一次 Enter 就結束清單 —— 跟每個編輯器的習慣一樣。
 * @returns {boolean} 有沒有接手這次按鍵
 */
function handleEnter(area) {
  if (area.selectionStart !== area.selectionEnd) return false;
  const line = currentLine(area);
  // 游標不在行尾就照原本的行為斷行, 免得在句子中間硬塞一個項目記號。
  if (area.selectionStart !== line.end) return false;

  const item = line.text.match(ITEM);
  if (item) {
    const [marker] = item;
    if (line.text.length === marker.length) {
      // 空項目 = 想結束清單: 把記號清掉。
      area.setSelectionRange(line.start, line.end);
      typeInto(area, "");
      return true;
    }
    const [, indent, bullet, num, delim, space, task] = item;
    const next = bullet
      ? `${indent}${bullet}${space}`
      : `${indent}${Number(num) + 1}${delim}${space}`;
    typeInto(area, `\n${next}${task ? "[ ] " : ""}`);
    return true;
  }

  const quote = line.text.match(QUOTE);
  if (quote) {
    if (line.text.trim() === quote[1].trim()) {
      area.setSelectionRange(line.start, line.end);
      typeInto(area, "");
      return true;
    }
    typeInto(area, `\n${quote[1]}`);
    return true;
  }
  return false;
}

/**
 * 游標前面有幾個標題。
 *
 * 用來把「正在編輯的位置」對到「預覽的第幾頁」: 數出來的第 n 個標題,
 * 就是文件模型裡的第 n 個標題, 它在第幾頁分頁時就算好了。
 * 程式碼區塊與註解裡的 # 不算, 跟真正的解析保持一致。
 */
function headingIndexAt(text, caret) {
  const lines = String(text).slice(0, caret).split("\n");
  let count = 0;
  let inFence = false;
  let inComment = false;
  let prev = "";
  for (const line of lines) {
    if (inFence) {
      if (/^\s*(```|~~~)/.test(line)) inFence = false;
      prev = "";
      continue;
    }
    if (inComment) {
      if (line.includes("-->")) inComment = false;
      prev = "";
      continue;
    }
    if (/^\s*(```|~~~)/.test(line)) { inFence = true; prev = ""; continue; }
    if (line.includes("<!--") && !line.includes("-->", line.indexOf("<!--") + 4)) {
      inComment = true;
      prev = "";
      continue;
    }
    if (/^\s{0,3}#{1,6}\s/.test(line)) count += 1;
    // 底線式標題: 上一行是普通文字, 這一行整行都是 = 或 -。
    else if (prev.trim() && /^\s{0,3}(=+|-+)\s*$/.test(line) && !/^\s{0,3}([-+*]|\d+[.)])\s/.test(prev)) {
      count += 1;
    }
    prev = line;
  }
  // 游標剛好停在某個標題那一行時, 要算它自己。
  return Math.max(0, count - 1);
}

/** 輕量 Markdown 著色；只改顯示層，真正輸入內容仍由 textarea 保管。 */
function highlightMarkdown(source) {
  const text = String(source);
  let inFence = false;
  let inComment = false;
  const html = text.split("\n").map((line) => {
    if (inFence) {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = false;
        return `<span class="md2-syn-fence">${escapeHtml(line)}</span>`;
      }
      return `<span class="md2-syn-codeblock">${escapeHtml(line)}</span>`;
    }
    if (inComment) {
      if (line.includes("-->")) inComment = false;
      return `<span class="md2-syn-comment">${escapeHtml(line)}</span>`;
    }
    if (line.includes("<!--")) {
      if (!line.includes("-->", line.indexOf("<!--") + 4)) inComment = true;
      return `<span class="md2-syn-comment">${escapeHtml(line)}</span>`;
    }
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = true;
      return `<span class="md2-syn-fence">${escapeHtml(line)}</span>`;
    }

    let match = line.match(/^(\s*)(#{1,6})(\s+)(.*)$/);
    if (match) return `${escapeHtml(match[1])}<span class="md2-syn-marker">${match[2]}</span>${escapeHtml(match[3])}<span class="md2-syn-heading">${highlightInline(match[4])}</span>`;
    match = line.match(/^(\s*)([-+*]|\d+[.)])(\s+)(.*)$/);
    if (match) return `${escapeHtml(match[1])}<span class="md2-syn-list">${escapeHtml(match[2])}</span>${escapeHtml(match[3])}${highlightInline(match[4])}`;
    match = line.match(/^(\s*)(>+)(\s?)(.*)$/);
    if (match) return `${escapeHtml(match[1])}<span class="md2-syn-quote">${escapeHtml(match[2])}</span>${escapeHtml(match[3])}<span class="md2-syn-quote-text">${highlightInline(match[4])}</span>`;
    if (/^\s*(---+|___+|\*\*\*+)\s*$/.test(line)) return `<span class="md2-syn-rule">${escapeHtml(line)}</span>`;
    return highlightInline(line);
  }).join("\n");
  // <pre> 會折疊結尾的空白行；只在原文真的以換行結尾時補一個佔位。
  return text.endsWith("\n") ? `${html} ` : html;
}

/* ============================ 掛載 ============================ */

export async function mount(host) {
  // 樣式要先拿到手: 紙的 shadow root 是同步塞 <style> 進去的, 晚一步的話
  // 第一次分頁會量到沒有樣式的版面。
  await Promise.all([loadMarkdownLibs(), paperStyles()]);

  const saved = load();
  const state = {
    markdown: saved?.markdown ?? SAMPLE,
    templateId: saved?.templateId ?? "report",
    customJson: "",
    showTemplate: false,
  };
  // 自訂模板一定要有一份起始內容: 空字串會被 JSON.parse 成 {},
  // 正規化之後是一個沒有標題樣式、沒有封面欄位的空模板。
  state.customJson = saved?.customJson || toEditableJson(presetById(state.templateId));
  /** 檔名（小寫）→ File。Markdown 裡的相對路徑靠這個對回真正的檔案。 */
  const attachments = new Map();
  /** 上一輪從 .md 讀到的 template 指令, 用來分辨「文件換了模板」與「使用者自己選的」。 */
  let lastDocTemplate = state.templateId;
  let latest = null;

  const save = () => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        markdown: state.markdown,
        templateId: state.templateId,
        customJson: state.customJson,
      }));
    } catch { /* 無痕模式或容量滿了都不該擋住編輯 */ }
  };

  /* ---------------- 左欄: 編輯 ---------------- */

  /** 正在用輸入法組字。組到一半重排版沒有意義, 還會拖慢打字。 */
  let composing = false;

  const editor = textArea({
    value: state.markdown,
    rows: 24,
    placeholder: "在這裡寫你的報告…",
    onInput: () => {
      state.markdown = editor.value;
      paintHighlight();
      save();
      // 組字中先不排版: 注音還沒選字的那幾個字根本不是最後的內容。
      if (!composing) schedule();
    },
  });
  editor.classList.add("md2-editor");
  const editorHighlight = el("pre", { class: "md2-editor-highlight", "aria-hidden": "true" });
  const editorShell = el("div", { class: "md2-editor-shell" }, editorHighlight, editor);

  function syncHighlightScroll() {
    editorHighlight.scrollTop = editor.scrollTop;
    editorHighlight.scrollLeft = editor.scrollLeft;
  }

  function paintHighlight() {
    editorHighlight.innerHTML = highlightMarkdown(editor.value);
    syncHighlightScroll();
  }

  editor.addEventListener("scroll", syncHighlightScroll, { passive: true });

  editor.addEventListener("compositionstart", () => {
    composing = true;
    editorShell.classList.add("is-composing");
  });
  editor.addEventListener("compositionend", () => {
    composing = false;
    editorShell.classList.remove("is-composing");
    state.markdown = editor.value;
    paintHighlight();
    save();
    schedule();
  });

  editor.addEventListener("keydown", (e) => {
    if (e.isComposing || e.altKey || e.metaKey || e.ctrlKey) return;
    if (e.key === "Tab") {
      e.preventDefault();
      handleIndent(editor, e.shiftKey);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && handleEnter(editor)) e.preventDefault();
  });

  /**
   * 讓預覽跟著游標走。
   *
   * 七頁的預覽配一個長長的編輯區, 不同步的話根本不知道自己正在改哪一頁。
   * 對位只做到「章節」這一層 —— 精確到行需要把每個區塊的原始行號一路帶下來,
   * 而章節已經夠用了, 又不會在段落中間亂跳。
   * 只有真的換到別頁才捲, 否則會跟使用者自己捲預覽打架。
   */
  let syncedPage = -1;
  function syncPreviewToCaret() {
    if (!latest || document.activeElement !== editor) return;
    const heads = latest.blocks.filter((b) => b.kind === "heading");
    const head = heads[Math.min(headingIndexAt(editor.value, editor.selectionStart), heads.length - 1)];
    const bodyPage = head ? latest.result.pageOf.get(head.id) : 1;
    if (!bodyPage) return;
    const index = latest.result.frontPages + bodyPage - 1;
    if (index === syncedPage) return;
    const page = paper.children[index];
    if (!page) return;
    syncedPage = index;
    const scale = parseFloat(surface.style.transform.replace(/[^\d.]/g, "")) || 1;
    // 直接跳而不是平滑捲動: 跨五頁的動畫又長又晃, 而且分頁標籤已經說了現在是第幾頁。
    viewport.scrollTop = page.offsetTop * scale;
  }
  for (const type of ["keyup", "click", "focus"]) {
    editor.addEventListener(type, () => { if (!composing) syncPreviewToCaret(); });
  }

  const editorResize = new ResizeObserver(() => {
    editorShell.style.height = `${editor.offsetHeight}px`;
  });
  editorResize.observe(editor);
  paintHighlight();

  const mdInput = el("input", {
    type: "file", accept: ".md,.markdown,.txt,text/markdown", hidden: true,
    onchange: async () => {
      const file = mdInput.files?.[0];
      if (!file) return;
      editor.value = await file.text();
      state.markdown = editor.value;
      paintHighlight();
      save();
      schedule();
      notify.success(`已載入 ${file.name}`);
      mdInput.value = "";
    },
  });

  const imgInput = el("input", {
    type: "file", accept: "image/*", multiple: true, hidden: true,
    onchange: () => { addFiles(imgInput.files); imgInput.value = ""; },
  });

  const fileList = el("div", { class: "md2-files" });

  function addFiles(files) {
    let added = 0;
    for (const file of files || []) {
      if (!file.type.startsWith("image/")) continue;
      attachments.set(file.name.toLowerCase(), file);
      added += 1;
    }
    if (!added) return;
    paintFiles();
    schedule();
  }

  function paintFiles() {
    fileList.replaceChildren();
    if (!attachments.size) {
      fileList.appendChild(el("span", {}, "還沒有附加圖片。"));
      return;
    }
    for (const name of [...attachments.keys()].sort()) {
      fileList.appendChild(el("span", { class: "md2-chip" }, name,
        el("button", {
          type: "button", title: `移除 ${name}`, "aria-label": `移除 ${name}`,
          onclick: () => { attachments.delete(name); paintFiles(); schedule(); },
        }, "×")));
    }
  }

  /** 收下一批檔案: .md 換掉內文, 圖片變成附件。拖放與貼上共用。 */
  async function acceptFiles(files) {
    const list = [...(files || [])];
    const md = list.find((f) => /\.(md|markdown|txt)$/i.test(f.name));
    if (md) {
      editor.value = await md.text();
      state.markdown = editor.value;
      paintHighlight();
      save();
      notify.success(`已載入 ${md.name}`);
    }
    addFiles(list.filter((f) => f !== md));
    schedule();
  }

  const drop = el("div", { class: "md2-drop" }, "拖曳 .md 或圖片檔到這裡, 截圖也可以直接貼上");

  /** 拖放的視覺回饋與收檔。編輯區自己也要收 —— 拖到文字上放開是很自然的動作,
      不接的話瀏覽器會把檔案路徑當成文字插進去。 */
  function acceptDrops(node, hot) {
    for (const type of ["dragenter", "dragover"]) {
      node.addEventListener(type, (e) => {
        if (!e.dataTransfer?.types?.includes("Files")) return;
        e.preventDefault();
        hot?.classList.add("is-over");
      });
    }
    for (const type of ["dragleave", "dragend"]) {
      node.addEventListener(type, () => hot?.classList.remove("is-over"));
    }
    node.addEventListener("drop", (e) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      hot?.classList.remove("is-over");
      acceptFiles(e.dataTransfer.files);
    });
  }
  acceptDrops(drop, drop);
  acceptDrops(editor, drop);

  /**
   * 貼上圖片。截圖存檔再拖進來太繞了, 剪貼簿裡的圖直接收成附件,
   * 順手在游標處補一行 Markdown, 貼完就看得到。
   */
  let pasteCount = 0;
  editor.addEventListener("paste", (e) => {
    const images = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
    if (!images.length) return;
    e.preventDefault();
    const names = images.map((file) => {
      pasteCount += 1;
      const ext = (file.type.split("/")[1] || "png").replace("jpeg", "jpg");
      const name = `paste-${pasteCount}.${ext}`;
      attachments.set(name, new File([file], name, { type: file.type }));
      return name;
    });
    paintFiles();
    typeInto(editor, `\n\n${names.map((n) => `![](${n})`).join("\n\n")}\n\n`);
  });

  /* ---------------- 模板 ---------------- */

  const builtIn = presets();
  const templateSelect = select({
    options: [
      ...builtIn.map((t) => ({ value: t.id, label: t.name })),
      { value: "custom", label: "自訂（下方 JSON）" },
    ],
    value: state.templateId,
    onChange: () => {
      state.templateId = templateSelect.value;
      lastDocTemplate = state.templateId;
      if (state.templateId !== "custom") {
        // 換內建模板時把 JSON 一起換掉, 使用者要微調就從這一份開始改。
        state.customJson = toEditableJson(presetById(state.templateId));
        jsonBox.value = state.customJson;
      }
      templateNote.textContent = describeTemplate();
      save();
      schedule();
    },
  });

  const jsonBox = textArea({
    value: state.customJson,
    rows: 14,
    placeholder: "模板 JSON",
    onInput: () => { state.customJson = jsonBox.value; save(); schedule(); },
  });
  jsonBox.classList.add("md2-json");

  const templateNote = el("p", { class: "tool-note" });
  const templatePane = el("div", { class: "md2-pane", hidden: true },
    note("改完即時套用。數值超出範圍會自動夾回, 不會整份壞掉。"),
    jsonBox,
    actions(
      button("套用成自訂模板", {
        variant: "ghost",
        onClick: () => {
          templateSelect.value = "custom";
          state.templateId = "custom";
          lastDocTemplate = "custom";
          templateNote.textContent = describeTemplate();
          save();
          schedule();
          notify.success("已切換到自訂模板");
        },
      }),
      button("還原成這個內建模板", {
        variant: "ghost",
        onClick: () => {
          const base = state.templateId === "custom" ? "report" : state.templateId;
          state.customJson = toEditableJson(presetById(base));
          jsonBox.value = state.customJson;
          save();
          schedule();
        },
      }),
    ),
  );

  const templateToggle = button("編輯模板", {
    variant: "ghost",
    onClick: () => {
      state.showTemplate = !state.showTemplate;
      templatePane.hidden = !state.showTemplate;
      templateToggle.lastChild.textContent = state.showTemplate ? "收起模板" : "編輯模板";
    },
  });

  function describeTemplate() {
    const found = builtIn.find((t) => t.id === state.templateId);
    return found ? found.note : "自訂模板: 以下的 JSON 就是實際套用的設定。";
  }
  templateNote.textContent = describeTemplate();

  /* ---------------- 右欄: 預覽 ---------------- */

  // 紙畫在 shadow DOM 裡, 網站的 .doc-content 樣式進不去 —— 看到的跟印出來的
  // 才是同一份東西。縮放掛在外面的 host 上, 紙本身不帶任何 transform。
  const surface = el("div", { class: "md2-surface" });
  const paper = createPaperSurface(surface);
  const scaler = el("div", { class: "md2-scaler" }, surface);
  const viewport = el("div", { class: "md2-viewport" }, scaler);
  const line = status();

  const zoomSelect = select({
    options: [
      { value: "fit", label: "符合寬度" },
      { value: "1", label: "100%" },
      { value: "0.75", label: "75%" },
      { value: "0.5", label: "50%" },
    ],
    value: "fit",
    onChange: fitPreview,
  });

  /**
   * 紙是原尺寸畫的, 這裡只負責縮到看得舒服, 並把外框撐成縮完之後的大小 ——
   * transform 不會改變元素佔的版面空間, 不補這一下捲軸會以為紙還是原尺寸。
   */
  function fitPreview() {
    const first = paper.firstElementChild;
    if (!first) { scaler.style.height = "0px"; return; }
    const natural = first.offsetWidth;
    if (!natural) return;
    const chosen = Number(zoomSelect.value);
    const scale = Number.isFinite(chosen) && chosen > 0
      ? chosen
      : Math.min(1, Math.max(0.15, (viewport.clientWidth - 32) / natural));
    surface.style.transform = `scale(${scale})`;
    scaler.style.width = `${natural * scale}px`;
    scaler.style.height = `${surface.offsetHeight * scale}px`;
  }

  const resize = new ResizeObserver(fitPreview);
  resize.observe(viewport);

  /* ---------------- 重新產生 ---------------- */

  let renderToken = 0;

  async function render() {
    const token = renderToken += 1;
    const source = state.markdown;
    const parsed = extractMeta(source);

    // .md 裡寫了 <!-- template: thesis --> 就跟著換, 但使用者自己選過之後不再覆蓋。
    const wanted = String(parsed.meta.template || "").trim();
    if (wanted && wanted !== lastDocTemplate) {
      const hit = builtIn.find((t) => t.id === wanted || t.name === wanted);
      if (hit) {
        state.templateId = hit.id;
        templateSelect.value = hit.id;
        templateNote.textContent = describeTemplate();
      }
      lastDocTemplate = wanted;
    }

    let tpl;
    let templateError = "";
    if (state.templateId === "custom") {
      try {
        tpl = normalizeTemplate(JSON.parse(state.customJson || "{}"));
      } catch (err) {
        tpl = presetById("report");
        templateError = `模板 JSON 有語法錯誤（${err.message}）, 先用標準書面報告排版。`;
      }
    } else {
      tpl = presetById(state.templateId);
    }

    let blocks;
    try {
      blocks = buildDocument(parsed.body, tpl);
    } catch (err) {
      line.set(`解析失敗: ${err.message}`, "error");
      return;
    }

    const [{ images, missing }, { diagrams, errors: diagramErrors }] = await Promise.all([
      resolveImages(collectImageSources(blocks), attachments),
      renderDiagrams(collectDiagrams(blocks), tpl),
      // 公式的字型要先載完才量得準, 沒有公式就不用等。
      blocks.some(hasMath) ? ensureMathFonts() : null,
    ]);
    if (token !== renderToken) return; // 使用者又打字了, 這一輪作廢

    const outline = outlineOf(blocks, tpl.toc.depth);
    const result = paginate(paper, { blocks, meta: parsed.meta, tpl, outline, images, diagrams });

    // 預覽才有的頁次標籤, 列印時用 CSS 藏起來。
    [...paper.children].forEach((page, i) => {
      page.appendChild(el("div", { class: "md2-pageno" }, `${i + 1} / ${result.pages}`));
    });
    fitPreview();

    latest = { blocks, meta: parsed.meta, tpl, outline, images, diagrams, result };
    // 重排之後頁碼會變, 讓預覽重新對準游標所在的章節。
    syncedPage = -1;
    syncPreviewToCaret();

    const words = parsed.body.replace(/\s+/g, "").length;
    const bits = [`${result.pages} 頁`, `正文 ${result.bodyPages} 頁`, `${words} 字`];
    const badMath = paper.querySelectorAll(".md2-math.md2-missing, .md2-math-inline.md2-missing").length;
    const problems = [
      missing.length ? `找不到 ${missing.length} 張圖: ${missing.join("、")}` : "",
      diagramErrors.length ? `流程圖: ${diagramErrors.join("、")}` : "",
      badMath ? `${badMath} 條公式有語法錯誤` : "",
      templateError,
    ].filter(Boolean);
    line.set(problems.length ? `${bits.join(" · ")}　${problems.join("；")}` : bits.join(" · "),
      problems.length ? "warn" : "ok");
  }

  /** 這個區塊（或它的子區塊）裡有沒有公式。 */
  function hasMath(block) {
    if (block.kind === "math") return true;
    if ((block.inlines || []).some((r) => r.math)) return true;
    if (block.blocks?.some(hasMath)) return true;
    return !!block.items?.some((item) => item.blocks.some(hasMath));
  }

  const schedule = debounce(() => { render().catch((err) => {
    console.error(err);
    line.set(`排版時出錯: ${err.message}`, "error");
  }); }, 350);

  /* ---------------- 輸出 ---------------- */

  async function exportDocx() {
    if (!latest) return;
    const { blocks, meta: docMeta, tpl, outline, images, diagrams, result } = latest;
    try {
      const warnings = [];
      const blob = await buildDocx({
        blocks, meta: docMeta, tpl, outline, images, diagrams,
        pageOf: result.pageOf, warnings,
      });
      download(blob, `${safeFileName(docMeta.title)}.docx`);
      if (warnings.length) notify.warning(`已產生 .docx, 但 ${warnings.length} 條公式轉不進 Word: ${warnings[0]}`);
      else notify.success("已產生 .docx");
    } catch (err) {
      console.error(err);
      notify.danger(`產生 .docx 失敗: ${err.message}`);
    }
  }

  /**
   * 列印。把排好的頁面原樣搬進一個隱藏的 iframe 再叫它列印。
   * 用 iframe 而不是 window.open: 不會被擋彈出視窗, 也不會把使用者的分頁換掉。
   */
  async function printPdf() {
    if (!latest) return;
    const { tpl } = latest;
    // 跟預覽的 shadow root 用同一份樣式（同一次 fetch）, 不會有「改了 CSS 但
    // 列印出來還是舊樣子」這種落差。
    const css = await paperStyles();
    const frame = el("iframe", {
      style: "position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0",
      title: "列印",
    });
    document.body.appendChild(frame);
    const doc = frame.contentDocument;
    doc.open();
    doc.write(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">`
      + `<title>${escapeHtml(latest.meta.title || "報告")}</title>`
      + `<link rel="stylesheet" href="${escapeHtml(katexHref())}">`
      + `<style>${css}</style>`
      + `<style>@page { size: ${tpl.page.width}mm ${tpl.page.height}mm; margin: 0; }`
      + `body { margin: 0; background: #fff; }</style></head><body>`
      + `<div class="md2-paper">${paper.innerHTML}</div></body></html>`);
    doc.close();

    // 圖片都是 data:, 但還是要等瀏覽器解完才印, 否則會印出空框。
    const images = [...doc.images];
    await Promise.all(images.map((img) => (img.complete ? null : new Promise((done) => {
      img.addEventListener("load", done, { once: true });
      img.addEventListener("error", done, { once: true });
    }))));
    // 公式的字型是 KaTeX 從 CDN 拉的, 沒載完就列印會印出備援字型的怪樣子。
    await doc.fonts?.ready;
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 60000);
    notify.info("列印視窗已開啟。目的地選「另存為 PDF」, 邊界選「無」, 並把「頁首及頁尾」取消勾選。");
  }

  /* ---------------- 組裝 ---------------- */

  host.appendChild(panel(
    el("div", { class: "md2-shell" },
      el("div", { class: "md2-toolbar" },
        field("模板", templateSelect),
        templateToggle,
        el("span", { class: "md2-spacer" }),
        button("載入 .md", { variant: "ghost", onClick: () => mdInput.click() }),
        button("附加圖片", { variant: "ghost", onClick: () => imgInput.click() }),
        button("下載 .docx", { variant: "primary", onClick: exportDocx }),
        button("列印 / 存成 PDF", { variant: "ghost", onClick: printPdf }),
      ),
      templateNote,
      templatePane,
      el("div", { class: "md2-split" },
        el("div", { class: "md2-pane" },
          subhead("Markdown"),
          editorShell,
          drop,
          fileList,
        ),
        el("div", { class: "md2-pane" },
          el("div", { class: "md2-pane-head" },
            subhead("預覽"),
            el("span", { class: "md2-spacer" }),
            zoomSelect,
          ),
          viewport,
          line,
        ),
      ),
      mdInput,
      imgInput,
    ),
  ));

  paintFiles();
  await render();

  return () => {
    editorResize.disconnect();
    resize.disconnect();
    document.getElementById("md2-stage")?.remove();
  };
}
