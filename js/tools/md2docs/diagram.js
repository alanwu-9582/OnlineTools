// js/tools/md2docs/diagram.js — ```mermaid 區塊。
//
// 預覽與列印放 SVG（向量, 印出來是清楚的線）, .docx 放同一張圖轉出來的 PNG
// —— Word 對 SVG 的支援要看版本, 舊版會顯示成一個紅叉, 點陣圖到哪都開得起來。
//
// 兩個非改不可的設定, 兩個都是為了讓那張圖離得開瀏覽器:
//
//   htmlLabels: false  節點文字改用 <text> 而不是 <foreignObject> 包 HTML。
//                      foreignObject 裡的 HTML 在 canvas 上畫不出來, 轉 PNG 會是空的。
//   theme: base + 白底 網站的 mermaid 設定是深色主題（配深色頁面）, 直接拿來用
//                      會在白紙上印出一張看不見的圖。

/** 每一張圖都要有自己的 id: mermaid 產出的 <style> 是用 #id 去限定範圍的。 */
let counter = 0;

/**
 * 畫好的圖存起來。
 *
 * mermaid 畫一張圖要一秒上下, 而預覽是每次停下打字就重排一遍 —— 沒有這層快取,
 * 每打一個字都要為了一張沒有動過的流程圖卡住一秒。key 要含模板, 因為字型與
 * 顏色是從模板來的, 換模板等於換一張圖。
 */
const cache = new Map();
const CACHE_LIMIT = 40;

function cacheKey(source, tpl) {
  return `${tpl.fonts.latin}|${tpl.fonts.cjk}|${tpl.body.size}|${source}`;
}

function remember(key, value) {
  cache.set(key, value);
  // 邊改邊存會一直長, 超過就從最舊的丟（Map 記得插入順序）。
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return value;
}

/** 走訪所有區塊, 收集 mermaid 原始碼。 */
export function collectDiagrams(blocks) {
  const out = new Set();
  const visit = (list) => {
    for (const b of list || []) {
      if (b.kind === "mermaid" && b.text.trim()) out.add(b.text);
      if (b.blocks) visit(b.blocks);
      if (b.items) for (const item of b.items) visit(item.blocks);
    }
  };
  visit(blocks);
  return [...out];
}

/** 把模板的字型與白底塞進去。使用者自己寫了 init 指令就讓他的優先。 */
function initDirective(tpl) {
  const config = {
    theme: "base",
    themeVariables: {
      background: "#ffffff",
      primaryColor: "#ffffff",
      primaryTextColor: "#000000",
      primaryBorderColor: "#000000",
      secondaryColor: "#f2f2f2",
      tertiaryColor: "#ffffff",
      lineColor: "#000000",
      textColor: "#000000",
      mainBkg: "#ffffff",
      nodeBorder: "#000000",
      clusterBkg: "#fafafa",
      clusterBorder: "#999999",
      edgeLabelBackground: "#ffffff",
      fontFamily: `${tpl.fonts.latin}, ${tpl.fonts.cjk}, serif`,
      fontSize: `${tpl.body.size}pt`,
    },
    flowchart: { htmlLabels: false, useMaxWidth: false },
    sequence: { useMaxWidth: false },
    gantt: { useMaxWidth: false },
    class: { htmlLabels: false, useMaxWidth: false },
  };
  return `%%{init: ${JSON.stringify(config)}}%%\n`;
}

/** SVG → PNG。放大幾倍再畫, 印出來才不會糊。 */
async function rasterize(svg, width, height, scale = 3) {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("SVG 轉點陣圖失敗"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const g = canvas.getContext("2d");
    // 白底: 沒有的話 PNG 是透明的, 貼進 Word 的深色佈景就看不到線。
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("轉存 PNG 失敗");
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}

function base64(bytes) {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

/**
 * 把所有 mermaid 原始碼畫成圖。
 *
 * @returns {Promise<{diagrams: Map<string, object>, errors: string[]}>}
 *   每一張: {svg, width, height, bytes, mime, ext}
 */
export async function renderDiagrams(sources, tpl) {
  const diagrams = new Map();
  const errors = [];
  if (!sources.length) return { diagrams, errors };
  if (!window.mermaid) {
    return { diagrams, errors: ["Mermaid 尚未載入"] };
  }

  const prefix = initDirective(tpl);
  // 一張一張畫: mermaid 內部有共用狀態, 同時丟進去會互相蓋掉。
  for (const source of sources) {
    const key = cacheKey(source, tpl);
    if (cache.has(key)) {
      const hit = cache.get(key);
      if (hit.error) errors.push(hit.error);
      else diagrams.set(source, hit.art);
      continue;
    }
    counter += 1;
    const id = `md2-mmd-${Date.now().toString(36)}-${counter}`;
    try {
      const hasOwnInit = /^\s*%%\{\s*init\s*:/.test(source);
      const { svg } = await window.mermaid.render(id, (hasOwnInit ? "" : prefix) + source);
      const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
      const root = doc.documentElement;
      if (root.tagName !== "svg") throw new Error("mermaid 沒有輸出 SVG");
      const width = Number(root.getAttribute("width")) || 600;
      const height = Number(root.getAttribute("height")) || 400;
      // width/height 拿掉, 改由版面決定大小；viewBox 留著才縮得對。
      root.removeAttribute("width");
      root.removeAttribute("height");
      root.setAttribute("preserveAspectRatio", "xMidYMid meet");
      const clean = new XMLSerializer().serializeToString(root);
      const bytes = await rasterize(svg, width, height);
      diagrams.set(source, remember(key, {
        art: {
          svg: clean,
          width,
          height,
          bytes,
          mime: "image/png",
          ext: "png",
          dataUrl: `data:image/png;base64,${base64(bytes)}`,
        },
      }).art);
    } catch (err) {
      const first = source.trim().split("\n")[0].slice(0, 30);
      const message = `${first}…（${err.message || "畫不出來"}）`;
      // 畫壞的也要記, 否則一個打到一半的流程圖會讓每次重排都重試一次。
      errors.push(remember(key, { error: message }).error);
      // mermaid 失敗時會在 body 留下一個暫時的容器, 自己收掉。
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  }
  return { diagrams, errors };
}
