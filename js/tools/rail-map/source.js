// js/tools/rail-map/source.js — 路網資料從哪裡來。
//
// 三個來源, 由快到慢:
//
//   1. 隨站台一起發佈的快照 data/rail-network.json（預設, 離線也讀得到）
//   2. 瀏覽器快取（使用者按過「線上更新」之後留下來的）
//   3. Overpass API 直接抓 OpenStreetMap 的最新資料（約 10 秒）
//
// 快照是 tools/build-rail.mjs 產生的, 那支也是呼叫這裡的查詢與 buildNetwork(), 
// 所以「開發者跑腳本」跟「使用者按更新」得到的東西一模一樣 ——
// 兩邊各寫一套的話, 遲早會出現只有其中一邊才有的 bug。

import { buildNetwork } from "./network.js";

/** 官方主機最穩, 但偶爾會排隊；排不進去就換下一個。 */
export const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.osm.jp/api/interpreter",
];

/**
 * 全臺灣的車站。
 * 車站在 OSM 上有時是節點、有時是站房的面, 所以三種型別都要查, 
 * 再用 `out center` 讓面與關聯也回報一個中心點。
 */
export const STATION_QUERY = `[out:json][timeout:180];
area["ISO3166-1"="TW"][admin_level=2]->.tw;
(
  node["railway"~"^(station|halt)$"](area.tw);
  way["railway"~"^(station|halt)$"](area.tw);
  relation["railway"~"^(station|halt)$"](area.tw);
);
out center tags;`;

/**
 * 全臺灣的路線關聯, 連軌道幾何一起要（out geom）。
 *
 * 這裡只收 route=railway 與捷運類, **不收 route=train** ——
 * route=train 在臺灣被拿來標「個別車次」, 光台灣高鐵就有 173 個
 * （「台灣高鐵 603 南港->左營」這種）, 那是時刻表不是路線。
 */
export const ROUTE_QUERY = `[out:json][timeout:300];
area["ISO3166-1"="TW"][admin_level=2]->.tw;
(
  relation["type"="route"]["route"="railway"](area.tw);
  relation["type"="route"]["route"~"^(subway|light_rail|monorail|tram)$"](area.tw);
);
out geom;`;

/**
 * 送一次 Overpass 查詢, 主機掛掉就換下一台。
 *
 * `userAgent` 只有在 Node 裡要傳: Overpass 會用 406 擋掉沒有 User-Agent 的請求, 
 * 而瀏覽器把 User-Agent 列為禁止改寫的標頭（也本來就會自己帶）。
 */
export async function overpass(query, { endpoints = OVERPASS_ENDPOINTS, signal, userAgent } = {}) {
  const failures = [];
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          ...(userAgent ? { "User-Agent": userAgent } : {}),
        },
        body: `data=${encodeURIComponent(query)}`,
        signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (signal?.aborted) throw error;
      failures.push(`${new URL(endpoint).hostname}: ${error.message}`);
    }
  }
  throw new Error(`Overpass 都連不上（${failures.join("；")}）`);
}

/* ============================ 車站運量 ============================ */

const WIKIDATA_SPARQL = "https://query.wikidata.org/sparql";

/**
 * 從 Wikidata 抓每座車站的年運量, 用來評車站等級。
 *
 * OSM 幾乎每座臺鐵車站都標了 wikidata id, 而 Wikidata 有 P3872（客流量）。
 * 取歷年最大值而不是最近一年: 缺哪一年不影響結果, 也不會被疫情那幾年壓低。
 *
 * 只有臺鐵與高鐵查得到（各 97%、100%）, 捷運幾乎沒有（4%）, 
 * 所以這份資料拿不到也不影響地圖能不能畫 —— 抓失敗就回空的, 
 * 車站等級改用路線交會數去推。
 *
 * @returns {Promise<Map<string, number>>} wikidata id → 年運量
 */
export async function fetchRidership(stationData, { signal, userAgent, batchSize = 180 } = {}) {
  const ids = [...new Set(
    (stationData.elements || [])
      .map((element) => (element.tags || {}).wikidata)
      .filter((id) => /^Q[0-9]+$/.test(id || "")),
  )];

  const found = new Map();
  for (let from = 0; from < ids.length; from += batchSize) {
    const chunk = ids.slice(from, from + batchSize);
    const query = `SELECT ?item (MAX(?p) AS ?peak) WHERE {
      VALUES ?item { ${chunk.map((id) => `wd:${id}`).join(" ")} }
      ?item wdt:P3872 ?p .
    } GROUP BY ?item`;

    const response = await fetch(WIKIDATA_SPARQL, {
      method: "POST",
      headers: {
        Accept: "application/sparql-results+json",
        "Content-Type": "application/x-www-form-urlencoded",
        ...(userAgent ? { "User-Agent": userAgent } : {}),
      },
      body: `query=${encodeURIComponent(query)}`,
      signal,
    });
    if (!response.ok) throw new Error(`Wikidata HTTP ${response.status}`);

    for (const row of (await response.json()).results.bindings) {
      const id = row.item.value.split("/").pop();
      const value = Number(row.peak.value);
      if (Number.isFinite(value)) found.set(id, value);
    }
  }
  return found;
}

/**
 * 直接從 OpenStreetMap 重新建一份路網。
 * @param {{onProgress?: (text: string) => void}} options
 */
export async function fetchLive({ onProgress = () => {}, signal, userAgent, ...rest } = {}) {
  const transport = { signal, userAgent };
  onProgress("正在取得車站…");
  const stations = await overpass(STATION_QUERY, transport);
  onProgress("正在取得路線與軌道…");
  const routes = await overpass(ROUTE_QUERY, transport);

  // 運量只影響車站點的大小, 抓不到就算了, 不要讓整張圖跟著失敗。
  onProgress("正在取得車站運量…");
  let weights = new Map();
  try {
    weights = await fetchRidership(stations, transport);
  } catch (error) {
    if (signal?.aborted) throw error;
    onProgress(`運量資料抓不到（${error.message}）, 車站等級改用路線交會數推算`);
  }

  onProgress("正在整理路網…");
  return buildNetwork(stations, routes, { ...rest, weights });
}

/* ============================ 瀏覽器端 ============================ */

const CACHE_KEY = "onlinetools.rail-map.network";
/** 快照的位置。source.js 在 js/tools/rail-map/ 底下, 往上三層就是站台根目錄。 */
const SNAPSHOT_URL = new URL("../../../data/rail-network.json", import.meta.url).href;

/** 隨站台發佈的快照。 */
export async function loadSnapshot() {
  const response = await fetch(SNAPSHOT_URL);
  if (!response.ok) throw new Error(`讀不到路網快照（HTTP ${response.status}）`);
  return response.json();
}

/** 使用者上次「線上更新」的結果。壞掉或不存在都回 null。 */
export function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && Array.isArray(parsed.lines) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeCache(network) {
  // 存不進去（無痕模式、容量滿了）不是什麼大事, 這一份本來就只是快取。
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(network));
    return true;
  } catch {
    return false;
  }
}

/**
 * 開啟工具時要顯示的那一份: 有快取就用快取, 否則用快照。
 * @returns {Promise<{network: object, from: "cache"|"snapshot"}>}
 */
export async function loadInitial() {
  const cached = readCache();
  if (cached) return { network: cached, from: "cache" };
  return { network: await loadSnapshot(), from: "snapshot" };
}
