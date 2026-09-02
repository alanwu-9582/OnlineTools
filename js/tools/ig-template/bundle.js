// js/tools/ig-template/bundle.js — 標準模板。
//
// 一份模板 = 一個 ZIP，裡面長這樣: 
//
//   template.json          版面資料（canvas、layers）
//   preview.png            參考成品，讓使用者知道做完會是什麼樣子
//   assets/header.svg      模板自帶的素材（頁眉、logo、裝飾）
//   fonts/BrandSans.woff2  模板自帶的字型（檔名就是字型選單顯示的名稱）
//   photos/main.jpg        使用者放上去的照片（勾了「含照片」才會有）
//
// 圖層用相對路徑指到素材（"assets/header.svg"），不再是塞在 JSON 裡的
// data URI —— 素材維持原本的檔案，使用者解開 zip 就能替換掉再壓回去。
//
// 站上內建的範例模板則是直接以資料夾放在 assets/templates/ 底下，不打包。
// 理由: 純文字的 template.json 進得了 git diff，二進位的 zip 進不去。
// 兩條路徑最後都收斂成同一個 Bundle 物件，下游不用分。

import { readZip, writeZip, looksLikeZip } from "./zip.js";
import { parseTemplate, serializeTemplate } from "./schema.js";
import { importPptx, looksLikePptx } from "./import-pptx.js";

export const MANIFEST = "template.json";
export const PHOTO_DIR = "photos/";
export const FONT_DIR = "fonts/";
export const PREVIEW = "preview.jpg";

const MIME = {
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  webp: "image/webp", gif: "image/gif", avif: "image/avif",
};
const IMAGE_EXT = Object.keys(MIME);
const FONT_EXT = new Set(["ttf", "otf", "woff", "woff2"]);

const extOf = (path) => String(path).split(".").pop().toLowerCase();
export const mimeOf = (path) => MIME[extOf(path)] || "application/octet-stream";

/** 從 MIME 反推副檔名，給上傳的檔案命名用。 */
export function extForType(type) {
  const hit = Object.entries(MIME).find(([, v]) => v === type);
  return hit ? hit[0] : "png";
}

/**
 * 一份載進來的模板，連同它的素材。
 *
 * 素材以 blob URL 提供給 <img> 用。blob URL 是同源的，畫進 canvas 不會
 * taint，所以匯出圖片不會失敗 —— 這是不用把素材轉成 data URI 的關鍵。
 * 用完一定要 dispose()，不然每載一次模板就漏掉幾百 KB。
 */
export class Bundle {
  constructor(template, warnings = []) {
    this.template = template;
    this.warnings = warnings;
    /** @type {Map<string, {bytes:Uint8Array, type:string, url:string}>} */
    this.assets = new Map();
    /** @type {Array<{family:string, value:string, label:string, face:FontFace|null}>} */
    this.fonts = [];
    this.previewPath = "";
    // 從 .pptx 匯入時記著來源，UI 才能在不重讀檔案的情況下換頁。
    this.source = null;
  }

  /** 放一份素材進來，回傳可以直接餵給 <img> 的網址。 */
  put(path, bytes, type = mimeOf(path)) {
    const old = this.assets.get(path);
    if (old) URL.revokeObjectURL(old.url);
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    this.assets.set(path, { bytes, type, url });
    return url;
  }

  /**
   * 把圖層的 src 解成真的可以載入的網址。
   * 支援包內路徑與 data URI；遠端網址一律擋掉（畫進 canvas 會讓匯出爆掉）。
   */
  resolve(src) {
    if (!src) return null;
    if (src.startsWith("data:image/")) return src;
    return this.assets.get(src)?.url || null;
  }

  get previewUrl() {
    return this.previewPath ? this.assets.get(this.previewPath)?.url || null : null;
  }

  /** 註冊 fonts/ 裡的字型；以檔名（不含副檔名）作為 font-family。 */
  async loadFonts() {
    const files = [...this.assets.keys()].filter((path) => (
      path.toLowerCase().startsWith(FONT_DIR) && FONT_EXT.has(extOf(path))
    ));
    if (!files.length) return;
    if (typeof FontFace === "undefined" || !document.fonts) {
      this.warnings.push("瀏覽器不支援載入標準模板內的字型，將使用系統備援字型。");
      return;
    }

    await Promise.all(files.map(async (path) => {
      const family = path.split("/").pop().replace(/\.[^.]+$/, "");
      if (!family || this.fonts.some((font) => font.family === family)) return;
      const asset = this.assets.get(path);
      try {
        const face = await new FontFace(family, `url("${asset.url}")`).load();
        document.fonts.add(face);
        this.fonts.push({ family, value: `"${family.replace(/"/g, "\\\"")}"`, label: family, face });
      } catch {
        this.warnings.push(`字型「${path}」載入失敗，已略過。`);
      }
    }));
  }

  dispose() {
    for (const font of this.fonts) {
      if (font.face) document.fonts?.delete(font.face);
    }
    this.fonts = [];
    for (const asset of this.assets.values()) URL.revokeObjectURL(asset.url);
    this.assets.clear();
  }
}

/** 圖層裡所有指向包內路徑的 src。 */
function referencedPaths(template) {
  const out = new Set();
  for (const layer of template.layers) {
    if (layer.src && !layer.src.startsWith("data:")) out.add(layer.src);
  }
  return out;
}

/** 找出包裡當作參考成品的那張圖。 */
function findPreview(names, declared) {
  if (declared && names.includes(declared)) return declared;
  return names.find((n) => /^preview\.(png|jpe?g|webp|gif|avif)$/i.test(n)) || "";
}

/* ---------------- 讀 ---------------- */

/**
 * 讀一個使用者丟進來的檔案。ZIP 或單獨的 .json 都吃。
 * @param {File|Blob} file
 * @returns {Promise<Bundle>}
 */
export async function readBundle(file) {
  const buffer = await file.arrayBuffer();

  if (!looksLikeZip(buffer)) {
    // 單獨一份 JSON —— 舊格式，也讓人可以只手寫版面不帶素材。
    let raw;
    try {
      raw = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer)));
    } catch {
      throw new Error("這個檔案既不是 ZIP 標準模板，也不是有效的 JSON。");
    }
    const { template, warnings } = parseTemplate(raw);
    const bundle = new Bundle(template, warnings);
    const missing = [...referencedPaths(template)];
    if (missing.length) {
      bundle.warnings.push(`這份是單獨的 JSON，裡面指到的素材（${missing.join("、")}）不在檔案裡，那幾層會是空的。`);
    }
    return bundle;
  }

  return bundleFromFiles(await readZip(buffer), { source: "ZIP" });
}

/* ---------------- 解壓縮後的資料夾 ---------------- */

/** 值得收進來的檔案。其餘（.DS_Store、Thumbs.db 之類）直接略過。 */
function wantedInFolder(name) {
  const base = name.split("/").pop();
  if (!base || base.startsWith(".")) return false;
  if (base === MANIFEST) return true;
  const ext = extOf(name);
  // 解開的 .pptx 資料夾也吃，所以 xml / rels / fntdata 一併收。
  return IMAGE_EXT.includes(ext) || FONT_EXT.has(ext)
    || ext === "xml" || ext === "rels" || ext === "fntdata";
}

/**
 * 從 drop 事件取出 entry 清單。
 *
 * **一定要同步呼叫**：await 之後 DataTransfer 的 items 就失效了，
 * webkitGetAsEntry() 會回 null。所以這裡只做「取 entry」，不做讀檔。
 *
 * @returns {Array<FileSystemEntry>}
 */
export function dropEntries(dataTransfer) {
  const out = [];
  for (const item of dataTransfer?.items || []) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) out.push(entry);
  }
  return out;
}

/** entry.file() / reader.readEntries() 的 promise 包裝。 */
const entryFile = (entry) => new Promise((res, rej) => entry.file(res, rej));
const readDir = (reader) => new Promise((res, rej) => reader.readEntries(res, rej));

async function walkEntry(entry, prefix, out) {
  if (entry.isFile) {
    const path = prefix + entry.name;
    if (!wantedInFolder(path)) return;
    const file = await entryFile(entry);
    out.set(path, new Uint8Array(await file.arrayBuffer()));
    return;
  }
  if (!entry.isDirectory) return;
  const reader = entry.createReader();
  // readEntries 一次最多給 100 筆，要一直讀到回空陣列為止 ——
  // 少了這個迴圈，超過 100 個檔案的資料夾會被默默截斷。
  for (;;) {
    const batch = await readDir(reader);
    if (!batch.length) break;
    for (const child of batch) await walkEntry(child, `${prefix}${entry.name}/`, out);
  }
}

/**
 * 把拖進來的 entry（可能是資料夾）讀成「路徑 → 內容」。
 * @param {Array<FileSystemEntry>} entries
 * @returns {Promise<Map<string, Uint8Array>>}
 */
export async function filesFromEntries(entries) {
  const out = new Map();
  for (const entry of entries) await walkEntry(entry, "", out);
  return out;
}

/**
 * 從 <input type="file" webkitdirectory> 的 FileList 讀。
 * webkitRelativePath 會帶著資料夾的相對路徑，正是我們要的。
 */
export async function filesFromInput(fileList) {
  const out = new Map();
  for (const file of fileList) {
    const path = file.webkitRelativePath || file.name;
    if (!wantedInFolder(path)) continue;
    out.set(path, new Uint8Array(await file.arrayBuffer()));
  }
  return out;
}

/**
 * 把一組「路徑 → 內容」組成 Bundle。
 *
 * ZIP 解出來的東西、跟使用者把解壓縮後的資料夾整個拖進來，長相是一樣的，
 * 所以兩條路徑共用這裡 —— 差別只在錯誤訊息要講得對得上使用者做的事。
 *
 * @param {Map<string, Uint8Array>} files
 * @param {{source?:string}} opts  出錯時用來描述來源（"ZIP" / "資料夾"）
 * @returns {Promise<Bundle>}
 */
export async function bundleFromFiles(files, { source = "ZIP" } = {}) {
  // 先把根目錄找出來再判斷是什麼。順序反過來的話，多包一層資料夾的
  // 解壓縮結果就全都認不出來。
  const rebased = rebaseOnRoot(files);

  // .pptx 也是 ZIP。用內容判斷而不是副檔名 —— 使用者從 Canva 下載回來的
  // 檔名不一定可靠，而 ppt/presentation.xml 在不在是確定的。
  if (looksLikePptx(rebased)) return bundleFromPptx(rebased, { slide: 0 });

  const manifest = rebased.get(MANIFEST);
  if (!manifest) {
    throw new Error(`這個${source}裡找不到 ${MANIFEST}，也不是 .pptx。`
      + "標準模板的根目錄要有 template.json；"
      + "想從設計稿做模板的話，在 Canva 用「分享 → 下載 → PowerPoint (.pptx)」匯出就可以直接讀。");
  }

  let raw;
  try {
    raw = JSON.parse(new TextDecoder().decode(manifest));
  } catch (err) {
    throw new Error(`${MANIFEST} 不是有效的 JSON: ${err.message}`);
  }
  const { template, warnings } = parseTemplate(raw);
  const bundle = new Bundle(template, warnings);

  for (const [name, bytes] of rebased) {
    if (name === MANIFEST) continue;
    if (!IMAGE_EXT.includes(extOf(name)) && !FONT_EXT.has(extOf(name))) continue;
    bundle.put(name, bytes);
  }
  await bundle.loadFonts();
  bundle.previewPath = findPreview([...bundle.assets.keys()], template.preview);

  for (const path of referencedPaths(template)) {
    if (!bundle.assets.has(path)) {
      bundle.warnings.push(`模板指到「${path}」，但${source}裡沒有這個檔案，那一層會是空的。`);
    }
  }
  return bundle;
}

/** 用來認出根目錄的標記檔：標準模板的 template.json，或解開的 .pptx。 */
const ROOT_MARKERS = [MANIFEST, "ppt/presentation.xml"];

/**
 * 讓標記檔所在的那一層變成根目錄。
 *
 * 壓縮軟體常常會多包一層（MyTemplate/MyTemplate/template.json），
 * 拖資料夾進來時最外層也一定會多一層。不處理的話 assets/ 的相對路徑就全對不上。
 */
function rebaseOnRoot(files) {
  for (const marker of ROOT_MARKERS) {
    if (files.has(marker)) return files;
  }
  // 挑最淺的那個標記 —— 巢狀資料夾裡可能有好幾份。
  let best = null;
  for (const name of files.keys()) {
    for (const marker of ROOT_MARKERS) {
      if (!name.endsWith(`/${marker}`)) continue;
      const depth = name.split("/").length;
      if (!best || depth < best.depth) best = { prefix: name.slice(0, -marker.length), depth };
    }
  }
  if (!best) return files;

  const out = new Map();
  for (const [name, bytes] of files) {
    if (name.startsWith(best.prefix)) out.set(name.slice(best.prefix.length), bytes);
  }
  return out;
}

/**
 * 從一份 .pptx 建出 Bundle。
 *
 * 會把 files 留在 bundle.source 上，讓 UI 可以在不重讀檔案的情況下換頁。
 *
 * @param {Map<string, Uint8Array>} files  readZip 的結果
 * @param {{slide?:number}} opts
 * @returns {Promise<Bundle>}
 */
export async function bundleFromPptx(files, { slide = 0 } = {}) {
  const imported = await importPptx(files, { slide });
  const { template, warnings } = parseTemplate(imported.raw);
  const bundle = new Bundle(template, [...imported.warnings, ...warnings]);

  for (const [path, asset] of imported.assets) {
    bundle.put(path, asset.bytes, asset.type);
  }
  // .pptx 內嵌的字型也一起註冊，排版才會跟原稿一樣。
  await bundle.loadFonts();
  // 匯入的模板沒有參考成品 —— 由 UI 拿第一次渲染的結果補上，
  // 那張就是「原稿的樣子」，之後換掉照片文字還看得到原本長怎樣。
  bundle.previewPath = "";
  bundle.source = { kind: "pptx", files, slideCount: imported.slideCount, slide: imported.slide };
  return bundle;
}

/**
 * 載入站上內建的模板資料夾（assets/templates/<name>/）。
 * @param {string} baseUrl 資料夾網址，結尾要有 /
 * @returns {Promise<Bundle>}
 */
export async function loadBuiltin(baseUrl) {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const res = await fetch(base + MANIFEST, { cache: "no-cache" });
  if (!res.ok) throw new Error(`載入模板失敗 (${res.status})`);
  const { template, warnings } = parseTemplate(await res.json());
  const bundle = new Bundle(template, warnings);

  // 素材照樣抓成 bytes 而不是直接用網址 —— 匯出標準模板的時候需要原始檔案內容。
  const wanted = referencedPaths(template);
  if (template.preview && !template.preview.startsWith("data:")) wanted.add(template.preview);

  await Promise.all([...wanted].map(async (path) => {
    try {
      const r = await fetch(base + path, { cache: "no-cache" });
      if (!r.ok) throw new Error(String(r.status));
      bundle.put(path, new Uint8Array(await r.arrayBuffer()));
    } catch (err) {
      bundle.warnings.push(`素材「${path}」載不到（${err.message}），那一層會是空的。`);
    }
  }));

  bundle.previewPath = findPreview([...bundle.assets.keys()], template.preview);
  return bundle;
}

/* ---------------- 寫 ---------------- */

/**
 * 打包成 .zip。
 *
 * @param {Bundle} bundle
 * @param {Map<string, object>} slots  layerId -> { path, scale, dx, dy }
 * @param {{includePhotos?:boolean, preview?:Blob}} opts
 *   includePhotos  false 時把 photos/ 底下的東西整個拿掉，只留模板本體 ——
 *                  分享版面給別人時不會連自己的照片一起送出去。
 *   preview        現在畫面上的成品，會存成 preview.png 當下一次的參考圖。
 * @returns {Promise<Blob>}
 */
export async function writeBundle(bundle, slots, { includePhotos = true, preview = null } = {}) {
  const data = serializeTemplate(bundle.template, slots, { includePhotos });
  const entries = [{ name: MANIFEST, data: `${JSON.stringify(data, null, 2)}\n` }];

  const used = new Set();
  for (const layer of data.layers) {
    if (layer.src && !layer.src.startsWith("data:")) used.add(layer.src);
  }

  for (const [path, asset] of bundle.assets) {
    // 舊的參考圖一律不帶，最後統一寫一張 preview.png。
    if (/^preview\.[a-z0-9]+$/i.test(path)) continue;
    if (path.startsWith(PHOTO_DIR) && !includePhotos) continue;
    // 已經沒有圖層在用的素材就不帶了，不然換過幾張照片檔案會一直變胖。
    if (!used.has(path) && !path.toLowerCase().startsWith(FONT_DIR)) continue;
    entries.push({ name: path, data: asset.bytes });
  }

  // 參考圖固定叫 preview.jpg。1080² 的 PNG 動輒 1.5 MB，而這張只是拿來對照的。
  if (preview) {
    entries.push({ name: PREVIEW, data: new Uint8Array(await preview.arrayBuffer()) });
  } else if (bundle.previewPath) {
    entries.push({ name: PREVIEW, data: bundle.assets.get(bundle.previewPath).bytes });
  }

  return writeZip(entries);
}
