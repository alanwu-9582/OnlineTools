// js/tools/ig-template/schema.js — 模板資料的讀取、檢查與輸出。這一層不碰 DOM。
//
// 畫布一律 1:1 正方形。IG 的資訊型貼文就是正方形，讓尺寸可調只會多出一堆
// 「為什麼我的字跑掉了」——所以只留一個邊長。
//
// 圖層的 src 是「模板包裡的相對路徑」（例如 "assets/header.svg"），
// 素材本體放在 zip 裡。data URI 也還吃，這樣單獨一份 .json 也能用。
// 唯一不放行的是遠端網址：遠端圖片畫進 canvas 會讓 toBlob() 丟
// SecurityError，與其等到使用者按匯出才爆，不如在格式上就擋掉。

export const FORMAT = "ig-template";
export const VERSION = 2;

/** IG 貼文的輸出邊長。1080 是 IG 的原生解析度。 */
export const DEFAULT_SIZE = 1080;
const MIN_SIZE = 512;
const MAX_SIZE = 2048;

const LAYER_TYPES = new Set(["photo", "text", "rect", "image"]);

/**
 * 工具列上可以選的字型。
 * 前兩套是站上自己載的，一定有；其餘是系統字型，附上退路字串 ——
 * 沒裝的話瀏覽器會往後找，不會變成豆腐字。
 */
export const FONT_FAMILIES = [
  { value: '"IBM Plex Sans JP", sans-serif', label: "IBM Plex Sans JP" },
  { value: '"JetBrains Mono", monospace', label: "JetBrains Mono" },
  { value: '"Noto Sans TC", "Microsoft JhengHei", "PingFang TC", sans-serif', label: "黑體（思源／微軟正黑）" },
  { value: '"Noto Serif TC", "PMingLiU", "Songti TC", serif', label: "明體／宋體" },
  { value: '"Arial Black", "Impact", sans-serif', label: "Arial Black（標題用）" },
  { value: "sans-serif", label: "系統無襯線" },
];

export const WEIGHTS = [
  { value: "300", label: "細" },
  { value: "400", label: "一般" },
  { value: "500", label: "中等" },
  { value: "700", label: "粗" },
  { value: "900", label: "特粗" },
];

const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * 檢查一個圖片來源能不能用。
 * 允許 data URI 與模板包內的相對路徑，其他一律擋。
 */
function safeSrc(src, warnings, where) {
  if (typeof src !== "string" || !src) return "";
  if (src.startsWith("data:image/")) return src;
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//")) {
    warnings.push(`${where}：src 是遠端網址，已忽略。素材要放進模板包裡，不然匯出時瀏覽器會擋下來。`);
    return "";
  }
  if (src.startsWith("/") || src.split("/").includes("..")) {
    warnings.push(`${where}：src「${src}」不是合法的包內路徑，已忽略。`);
    return "";
  }
  return src;
}

/**
 * 讀一份模板。壞掉的圖層會跳過並回報，不會整份丟掉 ——
 * 手寫 JSON 難免打錯字，把還能用的部分留下來比較好修。
 *
 * @param {unknown} raw  JSON.parse 之後的東西
 * @returns {{template:object, warnings:string[]}}
 * @throws {Error} 連 layers 都沒有的時候
 */
export function parseTemplate(raw) {
  const warnings = [];
  if (!raw || typeof raw !== "object") throw new Error("這不是一個 JSON 物件。");
  if (raw.format && raw.format !== FORMAT) {
    throw new Error(`format 應該是 "${FORMAT}"，這份是 "${raw.format}"。`);
  }
  if (num(raw.version, 1) > VERSION) {
    warnings.push(`這份模板的 version 是 ${raw.version}，比工具支援的 ${VERSION} 新，可能有讀不懂的欄位。`);
  }
  if (!Array.isArray(raw.layers)) throw new Error("少了 layers 陣列。");

  // 舊格式寫的是 width / height。取長邊當邊長，非正方形就講清楚它被改了。
  const declared = raw.canvas || {};
  const legacyW = num(declared.width, 0);
  const legacyH = num(declared.height, 0);
  let size = num(declared.size, 0) || Math.max(legacyW, legacyH) || DEFAULT_SIZE;
  size = clamp(Math.round(size), MIN_SIZE, MAX_SIZE);
  if (legacyW && legacyH && legacyW !== legacyH) {
    warnings.push(`這份模板原本是 ${legacyW} × ${legacyH}，已改成正方形 ${size} × ${size}，靠下的圖層可能要重新調位置。`);
  }

  const canvas = {
    size,
    // 讓 render 那邊還能沿用 width / height，不用到處改。
    width: size,
    height: size,
    background: typeof declared.background === "string" ? declared.background : "#ffffff",
  };

  const seen = new Set();
  const layers = [];
  raw.layers.forEach((input, i) => {
    const at = `第 ${i + 1} 層`;
    if (!input || typeof input !== "object") { warnings.push(`${at}：不是物件，已跳過。`); return; }
    const type = String(input.type || "").toLowerCase();
    if (!LAYER_TYPES.has(type)) {
      warnings.push(`${at}：不認得的 type「${input.type}」，已跳過。可用的是 photo / text / rect / image。`);
      return;
    }
    const rect = input.rect || {};
    if (![rect.x, rect.y, rect.w, rect.h].every((v) => Number.isFinite(Number(v)))) {
      warnings.push(`${at}：rect 要有 x / y / w / h 四個數字，已跳過。`);
      return;
    }

    // id 是圖層面板、上傳照片對照用的，重複會對錯層。
    let id = String(input.id || `${type}${i + 1}`);
    if (seen.has(id)) {
      const fixed = `${id}-${i + 1}`;
      warnings.push(`${at}：id「${id}」重複，改成「${fixed}」。`);
      id = fixed;
    }
    seen.add(id);

    const layer = {
      id,
      type,
      label: String(input.label || id),
      rect: {
        x: num(rect.x, 0), y: num(rect.y, 0),
        w: Math.max(1, num(rect.w, 100)), h: Math.max(1, num(rect.h, 100)),
      },
      opacity: clamp(num(input.opacity, 1), 0, 1),
      radius: Math.max(0, num(input.radius, 0)),
      // 繞著自己 rect 的中心轉。側邊直排的字就是靠這個，rect 照原本的
      // 未旋轉座標寫，比較好手算。
      rotate: num(input.rotate, 0) % 360,
      // 鎖住的圖層在畫布上點不到（背景色塊、裝飾），只能從圖層面板選。
      locked: input.locked === true,
    };

    if (type === "photo" || type === "image") {
      // photo = 使用者要換的照片框；image = 模板自帶的素材（頁眉、logo）。
      // 兩者都是「一個圖槽」，差別只在預設 fit 與匯出時算不算個人照片。
      const defaultFit = type === "photo" ? "cover" : "contain";
      layer.fit = input.fit === "cover" || input.fit === "contain" ? input.fit : defaultFit;
      layer.placeholder = String(input.placeholder || (type === "photo" ? "點這裡放照片" : "點這裡放素材"));
      layer.src = safeSrc(input.src, warnings, at);
      // 調好的縮放與位移要能存回模板，不然「匯出再載入」就接不下去。
      layer.scale = clamp(num(input.scale, 1), 0.1, 10);
      layer.dx = num(input.dx, 0);
      layer.dy = num(input.dy, 0);
    } else if (type === "text") {
      layer.text = typeof input.text === "string" ? input.text : "";
      layer.font = {
        family: typeof input.font?.family === "string" ? input.font.family : FONT_FAMILIES[0].value,
        size: clamp(num(input.font?.size, 48), 6, 400),
        weight: clamp(Math.round(num(input.font?.weight, 400) / 100) * 100, 100, 900),
        lineHeight: clamp(num(input.font?.lineHeight, 1.35), 0.8, 3),
        letterSpacing: clamp(num(input.font?.letterSpacing, 0), -20, 40),
      };
      layer.color = typeof input.color === "string" ? input.color : "#222222";
      layer.align = ["left", "center", "right"].includes(input.align) ? input.align : "left";
      layer.valign = ["top", "middle", "bottom"].includes(input.valign) ? input.valign : "top";
      // 字太多就自動縮小塞進框裡。IG 標題最常出事的就是這個。
      layer.autoShrink = input.autoShrink !== false;
    } else if (type === "rect") {
      layer.color = typeof input.color === "string" ? input.color : "#000000";
      // 漸層。海報式的色塊幾乎都是漸層，只有純色會做不出來。
      const g = input.gradient;
      if (g && typeof g.from === "string" && typeof g.to === "string") {
        layer.gradient = { from: g.from, to: g.to, angle: num(g.angle, 90) % 360 };
      }
    }

    // 完全跑到畫布外面的圖層照樣留著 —— 有時候是刻意的出血設計。
    const r = layer.rect;
    if (r.x > size || r.y > size || r.x + r.w < 0 || r.y + r.h < 0) {
      warnings.push(`${at}（${layer.label}）：整個在畫布外面，畫出來會看不到。`);
    }
    layers.push(layer);
  });

  if (!layers.length) throw new Error("一個有效的圖層都沒有。");

  return {
    template: {
      format: FORMAT,
      version: VERSION,
      name: String(raw.name || "未命名模板"),
      // 包內的參考成品路徑。
      preview: typeof raw.preview === "string" ? raw.preview : "",
      note: typeof raw.note === "string" ? raw.note : "",
      canvas,
      layers,
    },
    warnings,
  };
}

/**
 * 把目前的狀態存回模板資料。
 *
 * @param {object} template
 * @param {Map<string, object>} slots  layerId -> { path, scale, dx, dy }
 * @param {{includePhotos?:boolean}} opts
 *   includePhotos false 時把 photos/ 底下的照片參照拿掉，只留版面 ——
 *   把模板分享給別人時不會連自己的照片一起送出去。
 */
export function serializeTemplate(template, slots = new Map(), { includePhotos = true } = {}) {
  return {
    format: FORMAT,
    version: VERSION,
    name: template.name,
    ...(template.preview ? { preview: template.preview } : {}),
    ...(template.note ? { note: template.note } : {}),
    canvas: { size: template.canvas.size, background: template.canvas.background },
    layers: template.layers.map((layer) => {
      const out = {
        id: layer.id,
        type: layer.type,
        label: layer.label,
        rect: { ...layer.rect },
      };
      if (layer.opacity !== 1) out.opacity = layer.opacity;
      if (layer.radius) out.radius = layer.radius;
      if (layer.rotate) out.rotate = layer.rotate;
      if (layer.locked) out.locked = true;

      if (layer.type === "photo" || layer.type === "image") {
        out.fit = layer.fit;
        out.placeholder = layer.placeholder;
        const slot = slots.get(layer.id);
        const path = slot?.path || layer.src;
        const isPersonal = typeof path === "string" && path.startsWith("photos/");
        if (path && (includePhotos || !isPersonal)) {
          out.src = path;
          const scale = slot?.scale ?? layer.scale;
          const dx = slot?.dx ?? layer.dx;
          const dy = slot?.dy ?? layer.dy;
          if (scale !== 1) out.scale = scale;
          if (dx) out.dx = dx;
          if (dy) out.dy = dy;
        }
      } else if (layer.type === "text") {
        out.text = layer.text;
        out.font = { ...layer.font };
        out.color = layer.color;
        out.align = layer.align;
        out.valign = layer.valign;
        if (!layer.autoShrink) out.autoShrink = false;
      } else if (layer.type === "rect") {
        out.color = layer.color;
        if (layer.gradient) out.gradient = { ...layer.gradient };
      }
      return out;
    }),
  };
}
