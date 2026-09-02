// js/tools/ig-template/zip.js — 最小可用的 ZIP 讀寫。零依賴。
//
// 為什麼自己寫: 模板要把「版面資料 + 素材圖 + 參考成品」放在同一個檔案裡，
// ZIP 是唯一使用者手上一定有工具能打開來看、能自己改完再壓回去的格式。
// 引一個 zip 函式庫進來就違反了整站「不外掛 JS 套件」的規則。
//
// 壓縮本身不用自己實作 —— CompressionStream("deflate-raw") 就是 DEFLATE，
// 瀏覽器原生。這裡只負責 CRC32 與那幾個 header 結構。
//
// 不支援 ZIP64（4 GB 以上、65535 筆以上）與加密。模板不會長那樣，
// 真的遇到會明確報錯而不是靜靜讀出壞資料。

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const UTF8_FLAG = 0x0800;

/** 固定的 DOS 時間戳（2026-01-01 00:00）。輸出要能重現，才 diff 得出來。 */
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME = 0;

/* ---------------- CRC32 ---------------- */

let crcTable = null;
function getCrcTable() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  return crcTable;
}

/** @param {Uint8Array} bytes @returns {number} 無號 32 位元 */
export function crc32(bytes) {
  const table = getCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ---------------- DEFLATE（借瀏覽器的） ---------------- */

const hasDeflate = typeof CompressionStream !== "undefined";
const hasInflate = typeof DecompressionStream !== "undefined";

async function pipe(bytes, stream) {
  const writer = stream.writable.getWriter();
  // 不 await write()，只 await close() —— 對小資料 write 的 promise 可能要等
  // 讀端開始抽才會 resolve，先 await 會直接卡死。
  writer.write(bytes);
  const done = writer.close();
  const out = new Uint8Array(await new Response(stream.readable).arrayBuffer());
  await done;
  return out;
}

async function deflateRaw(bytes) {
  if (!hasDeflate) return null;
  try {
    return await pipe(bytes, new CompressionStream("deflate-raw"));
  } catch {
    return null;
  }
}

async function inflateRaw(bytes) {
  if (!hasInflate) throw new Error("這個瀏覽器不支援解壓縮（DecompressionStream），請改用未壓縮的 ZIP。");
  return pipe(bytes, new DecompressionStream("deflate-raw"));
}

/* ---------------- 讀 ---------------- */

/**
 * 這是不是一個 ZIP？看前四個位元組就夠了。
 * @param {ArrayBuffer|Uint8Array} buf
 */
export function looksLikeZip(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

/** 從尾巴往前找 EOCD。註解最長 65535，所以最多往前找 65557 個位元組。 */
function findEocd(view, size) {
  const from = Math.max(0, size - 65557);
  for (let i = size - 22; i >= from; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * 讀出 ZIP 裡的所有檔案。
 *
 * @param {ArrayBuffer} buffer
 * @returns {Promise<Map<string, Uint8Array>>} 路徑（用 /）→ 內容
 */
export async function readZip(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const size = bytes.length;
  if (size < 22) throw new Error("檔案太小，不是一個 ZIP。");

  const eocd = findEocd(view, size);
  if (eocd < 0) throw new Error("找不到 ZIP 的結尾紀錄，檔案可能不完整或不是 ZIP。");

  const count = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOffset === 0xffffffff) {
    throw new Error("這是 ZIP64 格式，這個工具讀不了。");
  }

  const files = new Map();
  const decoder = new TextDecoder("utf-8");
  let p = cdOffset;

  for (let i = 0; i < count; i += 1) {
    if (p + 46 > size || view.getUint32(p, true) !== CENTRAL_SIG) {
      throw new Error(`ZIP 的目錄在第 ${i + 1} 筆壞掉了。`);
    }
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const csize = view.getUint32(p + 20, true);
    const usize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const rawName = bytes.subarray(p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x0001) throw new Error("ZIP 有加密，這個工具讀不了。");

    const name = decoder.decode(rawName);
    // 目錄項目沒有內容，直接略過。
    if (name.endsWith("/")) continue;
    // 路徑穿越防護: 模板只該有相對路徑。
    if (name.startsWith("/") || name.includes("..")) {
      throw new Error(`ZIP 裡有可疑的路徑「${name}」。`);
    }

    if (localOffset + 30 > size || view.getUint32(localOffset, true) !== LOCAL_SIG) {
      throw new Error(`「${name}」的檔頭位置不對。`);
    }
    // 資料的起點要用 local header 自己的長度算 —— 它的 extra 欄位常常
    // 跟目錄裡那份不一樣（對齊用的 padding）。
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    if (start + csize > size) throw new Error(`「${name}」的內容超出檔案範圍。`);
    const chunk = bytes.subarray(start, start + csize);

    let data;
    if (method === 0) data = chunk;
    else if (method === 8) data = await inflateRaw(chunk);
    else throw new Error(`「${name}」用了不支援的壓縮方式（method ${method}）。`);

    if (data.length !== usize) {
      throw new Error(`「${name}」解出來的長度不對（${data.length} ≠ ${usize}）。`);
    }
    if (crc32(data) !== crc) throw new Error(`「${name}」的 CRC 不符，檔案可能損壞。`);

    files.set(name, data);
  }
  return files;
}

/* ---------------- 寫 ---------------- */

/**
 * 打包成 ZIP。
 *
 * 每一筆都先試 DEFLATE，壓不小就退回 STORE —— JPEG／PNG 本來就壓過了，
 * 硬壓只會變大。JSON 跟 SVG 反而能小掉八成以上。
 *
 * @param {Array<{name:string, data:Uint8Array|string}>} entries
 * @returns {Promise<Blob>}
 */
export async function writeZip(entries) {
  const encoder = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
    const crc = crc32(data);

    let method = 0;
    let payload = data;
    if (data.length > 64) {
      const packed = await deflateRaw(data);
      if (packed && packed.length < data.length) { method = 8; payload = packed; }
    }

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, LOCAL_SIG, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, UTF8_FLAG, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, payload.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, CENTRAL_SIG, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, UTF8_FLAG, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, payload.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local, payload);
    centrals.push(central);
    offset += local.length + payload.length;
  }

  const cdSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, EOCD_SIG, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  return new Blob([...locals, ...centrals, eocd], { type: "application/zip" });
}
