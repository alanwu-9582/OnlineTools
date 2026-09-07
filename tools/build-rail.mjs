// tools/build-rail.mjs — 從 OpenStreetMap 重新產生 data/rail-network.json。
//
//   node tools/build-rail.mjs           重新抓、寫檔
//   node tools/build-rail.mjs --check   只比對, 有落差就以非 0 結束
//   node tools/build-rail.mjs --dry     抓下來只印摘要, 不寫檔
//
// 這支存在的理由, 是不要有人手工維護路線圖。
// 捷運通車、臺鐵加開新站的時候, 該做的事只有「重跑一次」——
// 站點座標、屬於哪條線、排第幾站全部由資料算出來, 沒有需要照著改的圖檔。
// 排進 CI 定期跑, 連跑都不必自己跑。
//
// 實際做事的是 js/tools/rail-map/{source,network}.js, 跟工具裡「線上更新」
// 走的是同一份程式；這裡只負責把結果寫進檔案。

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { fetchLive } from "../js/tools/rail-map/source.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "data", "rail-network.json");

const CHECK_ONLY = process.argv.includes("--check");
const DRY_RUN = process.argv.includes("--dry");

/** 有禮貌地表明身分。Overpass 會用 406 擋掉沒有 User-Agent 的請求。 */
const USER_AGENT = "OnlineTools rail-map builder (+https://github.com/alanwu-9582)";

/** 座標留到公尺就夠畫圖了, 小數點下的位數只會讓檔案變大。 */
function round(network) {
  const trim = (n) => Math.round(n);
  return {
    ...network,
    lines: network.lines.map((line) => ({
      ...line,
      paths: line.paths.map((path_) => path_.map(([x, y]) => [trim(x), trim(y)])),
    })),
    stations: network.stations.map((station) => ({
      ...station,
      x: trim(station.x),
      y: trim(station.y),
    })),
  };
}

function summarise(network) {
  const perSystem = new Map();
  for (const line of network.lines) {
    perSystem.set(line.system, (perSystem.get(line.system) || 0) + 1);
  }
  const names = new Map(network.systems.map((s) => [s.id, s.name]));
  console.log(`v ${network.lines.length} 條路線、${network.stations.length} 座車站`);
  for (const [id, count] of perSystem) {
    const lines = network.lines.filter((line) => line.system === id);
    const stops = new Set(lines.flatMap((line) => line.stations)).size;
    console.log(`    ${String(names.get(id) || id).padEnd(12)} ${String(count).padStart(2)} 線 ${String(stops).padStart(3)} 站`);
  }
}

/* ---------- 主流程 ---------- */

let network;
try {
  network = round(await fetchLive({
    userAgent: USER_AGENT,
    onProgress: (text) => console.log(`  ${text}`),
  }));
} catch (error) {
  console.error(`x 抓不到資料: ${error.message}`);
  process.exit(2);
}

if (!network.lines.length || !network.stations.length) {
  // 空的結果一定是查詢或上游出了問題。覆蓋上去會讓工具整個開天窗, 
  // 舊快照再舊也比沒有好。
  console.error("x 產生出來的路網是空的, 不覆蓋既有檔案");
  process.exit(2);
}

const output = `${JSON.stringify(network, null, 0)}\n`;

if (DRY_RUN) {
  summarise(network);
  console.log(`  （--dry, 沒有寫檔）${(Buffer.byteLength(output) / 1024).toFixed(0)} KB`);
  process.exit(0);
}

const previous = (() => {
  try { return readFileSync(OUT, "utf8"); } catch { return ""; }
})();

/** 只差在 generated 日期不算有變動, 否則每天跑都會產生一筆假的差異。 */
const withoutDate = (text) => text.replace(/"generated":"[^"]*",/, "");
const changed = withoutDate(previous.trim()) !== withoutDate(output.trim());

if (CHECK_ONLY) {
  summarise(network);
  if (changed) {
    console.error("x data/rail-network.json 與 OSM 現況不同, 請執行: node tools/build-rail.mjs");
    process.exit(1);
  }
  console.log("v 路網資料已是最新");
} else {
  writeFileSync(OUT, output);
  summarise(network);
  console.log(`v ${(Buffer.byteLength(output) / 1024).toFixed(0)} KB -> data/rail-network.json${changed ? "" : "（內容沒有變動）"}`);
}
