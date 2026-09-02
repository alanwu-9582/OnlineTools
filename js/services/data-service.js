// js/services/data-service.js — 載入並快取 data/ 底下的 JSON。
//
// data/entries.json 與 data/search-index.json 由 tools/build-data.mjs 產生，
// 請不要手動編輯。

import { loadJSON } from "../utils/utils.js";

const SITE_URL = "data/site.json";
const ENTRIES_URL = "data/entries.json";
const SEARCH_INDEX_URL = "data/search-index.json";
const LINKS_URL = "data/links.json";

/** 每個網址只抓一次；失敗時把自己清掉，之後重試才有機會成功。 */
function cached() {
  const store = new Map();
  return (url, transform) => {
    if (!store.has(url)) {
      store.set(url, loadJSON(url)
        .then(transform)
        .catch((err) => { store.delete(url); throw err; }));
    }
    return store.get(url);
  };
}
const load = cached();

/** data/site.json 全部內容: 站台資訊、類別與標籤。 */
export async function getSite() {
  return load(SITE_URL, (data) => data || {});
}

/** labels.js 需要的 { categories, tags }。 */
export async function getConfig() {
  const site = await getSite();
  return { categories: site.categories || {}, tags: site.tags || {} };
}

/** 所有內容（工具 + 文檔），已依發佈日期由新到舊排好。 */
export async function getEntries() {
  return load(ENTRIES_URL, (data) => (Array.isArray(data) ? data : data.entries || []));
}

/** 只要某一種: `"tool"` 或 `"doc"`。 */
export async function getEntriesByKind(kind) {
  const entries = await getEntries();
  return kind ? entries.filter((doc) => doc.type === kind) : entries;
}

/**
 * 全文索引: Map<entryId, Array<{h, i, t}>>（標題 / 標題 id / 內文）。
 * 延後載入 —— 只有第一次搜尋要付這個成本。
 */
export async function getSearchIndex() {
  return load(SEARCH_INDEX_URL, (data) =>
    new Map((data.entries || []).map((doc) => [doc.id, doc.blocks || []])));
}

/** data/links.json: 其他人做的工具網站。 */
export async function getLinks() {
  return load(LINKS_URL, (data) => ({
    groups: data.groups || {},
    sites: data.sites || [],
  }));
}

/** 用 id 找單筆內容。 */
export async function getEntryById(id) {
  const entries = await getEntries();
  return entries.find((doc) => doc.id === id) || null;
}

/**
 * 相鄰內容，給檢視頁的上／下一篇用。只在同一種類型裡面找，
 * 從工具翻頁不會突然翻到教學文檔。
 * 清單是由新到舊，所以「上一篇」是時間上更早的那一篇。
 */
export async function getNeighbours(id) {
  const entries = await getEntries();
  const current = entries.find((doc) => doc.id === id);
  if (!current) return { prev: null, next: null };
  const family = entries.filter((doc) => doc.type === current.type);
  const i = family.findIndex((doc) => doc.id === id);
  return { prev: family[i + 1] || null, next: family[i - 1] || null };
}
