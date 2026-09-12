// js/core/storage.js — 這個網站在你電腦上留了什麼, 以及怎麼清掉。
//
// 兩種東西, 性質完全不同, 所以分開處理也分開問:
//
//   離線快取   sw.js 存下來的頁面與程式碼。刪掉只是下次要重新下載, 不會損失任何東西。
//   工具資料   各工具存在 localStorage 的草稿與設定。刪掉就真的沒了。
//
// 清單不維護白名單: localStorage 上整個來源都是這個站的, 所以是「全部列出來、
// 全部清掉」。新工具不必來這裡註冊, 自動就被涵蓋 —— 白名單遲早會漏。
// 名字則是拿 key 去比對 entries.json 裡的工具 id, 也不需要人工對照表。

import { getEntries } from "../services/data-service.js";

const CACHE_PREFIX = "onlinetools-";

function bytesOf(value) {
  // localStorage 存的是 UTF-16, 但顯示用途看數量級就好, 用 UTF-8 長度估。
  return new TextEncoder().encode(String(value ?? "")).length;
}

export function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/**
 * 現在存了哪些東西。
 * @returns {Promise<{offline:{files:number,bytes:number}, items:Array<{key,bytes,label}>}>}
 */
export async function inspectStorage() {
  const entries = await getEntries().catch(() => []);
  const tools = entries.filter((e) => e.type === "tool");

  const items = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      const raw = localStorage.getItem(key) ?? "";
      // key 裡通常帶著工具 id（md2docs:v1、onlinetools.split-bill.v1）, 拿來換成標題。
      const owner = tools.find((t) => key.includes(t.id));
      items.push({ key, bytes: bytesOf(key) + bytesOf(raw), label: owner ? owner.title : key });
    }
  } catch {
    /* 無痕模式會直接擋住 localStorage, 當作沒有東西可清 */
  }
  items.sort((a, b) => b.bytes - a.bytes);

  const offline = { files: 0 };
  if ("caches" in window) {
    try {
      for (const name of await caches.keys()) {
        if (!name.startsWith(CACHE_PREFIX)) continue;
        offline.files += (await (await caches.open(name)).keys()).length;
      }
    } catch {
      /* 拿不到就顯示 0, 不影響清除 */
    }
  }

  // 整個來源用了多少。這個數字涵蓋快取以外的東西, 所以標成「這個網站總共」,
  // 不能拿去當成離線快取的大小 —— 要精確算快取得把每個回應整份讀出來, 太貴。
  let usage = 0;
  try { usage = (await navigator.storage?.estimate?.())?.usage || 0; } catch { usage = 0; }

  return { offline, items, usage };
}

/**
 * 清除。
 * @param {{offline?:boolean, data?:boolean}} what
 * @returns {Promise<{offline:number, data:number}>} 各清掉幾項
 */
export async function clearStorage({ offline = false, data = false } = {}) {
  const result = { offline: 0, data: 0 };

  if (offline && "caches" in window) {
    for (const name of await caches.keys()) {
      if (!name.startsWith(CACHE_PREFIX)) continue;
      if (await caches.delete(name)) result.offline += 1;
    }
  }

  if (data) {
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i += 1) keys.push(localStorage.key(i));
      for (const key of keys) localStorage.removeItem(key);
      result.data = keys.length;
    } catch {
      /* 擋住就當作沒有東西可清 */
    }
    try { sessionStorage.clear(); } catch { /* 同上 */ }
  }

  return result;
}
