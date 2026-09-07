// js/tools/rail-map/network.js — 把 OSM 的原始關聯整理成路網模型。
//
// 這支跟 geo.js 一樣不碰 DOM: tools/build-rail.mjs（Node）與工具裡的
// 「線上更新」都 import 它, 兩條路徑算出來的路網才保證一致。
//
// 整理的重點在於, OSM 的鐵路資料有兩種完全不同的長相:
//
//   捷運、輕軌、高鐵 —— route 關聯裡有依序排好的停靠站節點
//   臺鐵各線         —— route 關聯只有軌道 way, 一個站都沒有
//
// 所以這裡不看停靠站成員, 一律走「軌道折線 + 把車站吸附上去」這一條路:
// 車站是獨立的 railway=station 元素, 量它到折線的距離就知道屬於哪條線, 
// 量它在折線上的里程就知道排第幾站。新開的車站只要有人標進 OSM, 
// 下次重新產生資料時就會自己出現在對的位置, 不必有人去改圖。

import { project, dist, stitch, simplify, snap, polylineLength, bounds } from "./geo.js";

/* ============================ 系統 ============================ */

/**
 * 各家系統。`match` 用來比對 OSM 的 operator / network 標籤。
 *
 * `family` 是「能不能配對」的分組: 只有同族群的車站與路線才會被湊在一起。
 * 沒有這一層, 臺北車站底下並排的臺鐵、高鐵與捷運軌道會互相認親 ——
 * 高鐵曾經因此被算出 41 個車站（實際只有 12 個）。
 */
export const SYSTEMS = [
  {
    id: "tra", name: "臺鐵", nameEn: "TRA", family: "tra", region: "national",
    match: /臺灣鐵路|台灣鐵路|臺鐵|台鐵|\bTRA\b/,
  },
  {
    id: "thsr", name: "高鐵", nameEn: "THSR", family: "thsr", region: "national",
    match: /高速鐵路|高鐵|\bTHSR\b/,
  },
  {
    id: "trtc", name: "臺北捷運", nameEn: "Taipei Metro", family: "metro", region: "taipei",
    match: /臺北大眾捷運|台北大眾捷運|臺北捷運|台北捷運/,
  },
  {
    id: "ntmc", name: "新北捷運", nameEn: "New Taipei Metro", family: "metro", region: "taipei",
    match: /新北大眾捷運|新北捷運|淡海輕軌|安坑輕軌/,
  },
  {
    id: "tymc", name: "桃園捷運", nameEn: "Taoyuan Metro", family: "metro", region: "taoyuan",
    match: /桃園大眾捷運|桃園捷運|桃園國際機場捷運/,
  },
  {
    id: "tmrt", name: "臺中捷運", nameEn: "Taichung Metro", family: "metro", region: "taichung",
    match: /臺中捷運|台中捷運/,
  },
  {
    id: "krtc", name: "高雄捷運", nameEn: "Kaohsiung Metro", family: "metro", region: "kaohsiung",
    match: /高雄捷運|環狀輕軌|高雄輕軌/,
  },
  {
    id: "afr", name: "阿里山林鐵", nameEn: "Alishan Forest Railway", family: "forest", region: "national",
    match: /阿里山|林業及自然保育署|林區管理處/,
  },
];

/** 依 operator / network / 名稱認出是哪一家。認不出來回 null。 */
export function classify(...texts) {
  const text = texts.filter(Boolean).join(" ");
  if (!text) return null;
  for (const system of SYSTEMS) if (system.match.test(text)) return system;
  return null;
}

/**
 * 路線屬於哪個族群。
 *
 * 不能只靠 classify(): 板南線與文湖線的關聯在 OSM 上沒有 network 標籤, 
 * 名字也只寫「捷運文湖線」「南港-板橋-土城線」, 比不到任何一家業者 ——
 * 早期版本就是這樣把這兩條線整條弄丟的。
 *
 * 但 `route` 標籤本身就說了它是什麼: subway / light_rail 一定是都會軌道。
 * 族群定下來就夠吸附車站了, 至於是哪一家, 等吸到站之後看那些站屬於誰
 * 更準（見 buildNetwork）。
 */
export function familyOf(tags) {
  if (/^(subway|light_rail|monorail|tram)$/.test(tags.route || "")) return "metro";
  if (tags.route !== "railway") return null;
  const system = classify(tags.network, tags.operator, tags.name);
  if (system) return system.family;
  return null;
}

/* ============================ 顏色 ============================ */

/**
 * 路線識別色。
 *
 * OSM 上的 colour 標籤時有時無, 而且偶爾跟官方識別色對不起來
 * （桃園機場捷運被標成淡紫 #d4cde7, 官方是深紫）。識別色屬於品牌, 
 * 不會因為多開一個車站而改變, 放在這裡是安全的 —— 沒列到的線會退回
 * OSM 的標籤, 再不行才用下面的調色盤, 所以漏了誰也不會畫不出來。
 */
const LINE_COLOURS = [
  // 支線要排在幹線前面: 小碧潭支線的 ref 也是 G, 先比到 code 就會拿到松山新店線的綠。
  { system: "trtc", name: /新北投/, colour: "#f890a5" },
  { system: "trtc", name: /小碧潭/, colour: "#cedc00" },
  { system: "trtc", code: "BR", colour: "#c48c31" },
  { system: "trtc", code: "BL", colour: "#0070bd" },
  { system: "trtc", code: "R", colour: "#e3002c" },
  { system: "trtc", code: "G", colour: "#008659" },
  { system: "trtc", code: "O", colour: "#f8b61c" },
  { system: "trtc", code: "Y", colour: "#ffdb00" },
  { system: "ntmc", name: /環狀/, colour: "#ffdb00" },
  { system: "tymc", code: "A", colour: "#8246af" },
  { system: "tmrt", colour: "#a4d65e" },
  { system: "krtc", code: "R", colour: "#ee1c25" },
  { system: "krtc", code: "O", colour: "#f7941d" },
  { system: "krtc", name: /輕軌/, colour: "#a6ce39" },
  { system: "ntmc", name: /淡海/, colour: "#e2007a" },
  { system: "ntmc", name: /安坑/, colour: "#a3743c" },
  { system: "thsr", colour: "#e8730c" },
];

/** 沒有官方識別色的線（臺鐵各線居多）從這裡取。 */
const PALETTE = [
  "#4d8fd1", "#68a357", "#c9683c", "#8f6fb5", "#3fa39b",
  "#c25d8a", "#9a8f3c", "#5c7fa8", "#a4643c", "#6b8f4e",
  "#7b6bb0", "#b8823c", "#4f9d7a", "#a35a5a", "#5f7fbf", "#8a9b3c",
];

const isHex = (value) => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(value || "").trim());

/** 官方識別色, 或 OSM 標的色。都沒有就回 null, 交給下面的調色盤分配。 */
function pickColour(systemId, code, name, osmColour) {
  for (const rule of LINE_COLOURS) {
    if (rule.system !== systemId) continue;
    if (rule.code && rule.code !== code) continue;
    if (rule.name && !rule.name.test(name)) continue;
    return rule.colour;
  }
  return isHex(osmColour) ? String(osmColour).trim().toLowerCase() : null;
}

/**
 * 把調色盤發給沒有識別色的線, 相鄰的線不會拿到同一個顏色。
 *
 * 之前試過「照順序依序取」與「用線名雜湊」兩種, 都不行:
 * 依序取的話, OSM 多一條線就會讓後面每一條的顏色位移, 使用者按一次更新
 * 整張圖的臺鐵支線就換色；雜湊雖然穩定, 但分佈很差 —— 實測平溪線、成追線、
 * 宜蘭線、南迴線、海岸線五條全部拿到同一個綠色。
 *
 * 改成貪婪配色: 依線名排序（結果可重現）, 每條線避開所有「靠得夠近」的線
 * 已經用掉的顏色。臺鐵各線的外框幾乎彼此重疊, 等於強制全部不同色。
 */
function assignPaletteColours(lines) {
  const boxOf = new Map(lines.map((line) => [line.id, bounds(line.paths.flat())]));

  /** 兩條線的外框相距多遠, 重疊就是 0。 */
  const gap = (a, b) => {
    const x = boxOf.get(a.id);
    const y = boxOf.get(b.id);
    return Math.hypot(
      Math.max(0, x[0] - y[2], y[0] - x[2]),
      Math.max(0, x[1] - y[3], y[1] - x[3]),
    );
  };

  const uses = new Map(PALETTE.map((colour) => [colour, 0]));
  const done = [];

  for (const line of lines) {
    if (line.colour) { done.push(line); continue; }

    // 每個顏色的分數是「已經用了這個顏色的線裡, 離我最近的那條有多遠」, 
    // 沒人用過就是無限遠。取分數最高的, 同分時用得少的優先。
    //
    // 不用「硬性排除鄰居」是因為顏色比路線少的時候一定得有人共用, 
    // 硬排除法在全部都被擋掉時只能退回固定的第一個顏色 ——
    // 實測那會讓縱貫線跟從它分出去的內灣線撞色, 正好是最不該撞的一對。
    let best = null;
    let bestGap = -1;
    for (const colour of PALETTE) {
      const owners = done.filter((other) => other.colour === colour);
      const nearest = owners.length ? Math.min(...owners.map((other) => gap(line, other))) : Infinity;
      if (nearest > bestGap || (nearest === bestGap && uses.get(colour) < uses.get(best))) {
        best = colour;
        bestGap = nearest;
      }
    }
    line.colour = best;
    uses.set(best, uses.get(best) + 1);
    done.push(line);
  }
}


/* ============================ 車站 ============================ */

/** OSM 元素的座標: 節點直接有, way / relation 要靠 out center。 */
function centre(element) {
  const lon = element.lon ?? element.center?.lon;
  const lat = element.lat ?? element.center?.lat;
  return Number.isFinite(lon) && Number.isFinite(lat) ? project(lon, lat) : null;
}

/** 站名尾巴的「車站」「站」對不上別的寫法, 比對前先拿掉。 */
const bareName = (name) => String(name || "").replace(/(火車)?車?站$/, "").trim();

/**
 * 挑出所有車站, 同一座站的重複元素合併掉。
 *
 * 為什麼要合併: 同一座車站在 OSM 上常常有好幾個元素（站房的面、月台的點、
 * 不同時期匯入的節點）。不合併的話地圖上會出現兩個疊在一起的圓點。
 * 判斷同一座站的條件是「同一個系統 + 距離很近 + 名字對得上」——
 * 只看距離會把臺鐵與高鐵的同名車站併成一個, 它們其實要分開畫、
 * 再用轉乘記號連起來。
 */
function collectStations(elements, { mergeRadius = 200 } = {}) {
  const raw = [];
  for (const element of elements) {
    const tags = element.tags || {};
    if (!/^(station|halt)$/.test(tags.railway || "")) continue;
    const point = centre(element);
    if (!point) continue;
    // 只認 operator 與 network, 不看站名: 「五分車高鐵站」是糖廠的觀光小火車站, 
    // 「高鐵桃園站」是桃園捷運 A18, 兩個都會因為名字裡有「高鐵」被算成高鐵的車站。
    const system = classify(tags.operator, tags.network);
    if (!system) continue;
    raw.push({
      id: `${element.type[0]}${element.id}`,
      name: tags.name || tags["name:zh"] || "",
      nameEn: tags["name:en"] || "",
      // 一站多線的站號分隔符沒有統一: 「R10;BL12」「O5/R10」都有人這樣寫。
      codes: String(tags.ref || "").split(/[;/,、\s]+/).map((s) => s.trim()).filter(Boolean),
      wikidata: tags.wikidata || "",
      system: system.id,
      family: system.family,
      point,
    });
  }

  const merged = [];
  const taken = new Array(raw.length).fill(false);
  for (let i = 0; i < raw.length; i++) {
    if (taken[i]) continue;
    taken[i] = true;
    const group = [raw[i]];
    for (let k = i + 1; k < raw.length; k++) {
      if (taken[k] || raw[k].system !== raw[i].system) continue;
      if (dist(raw[i].point, raw[k].point) > mergeRadius) continue;
      // 名字差太多就不是同一座, 只是剛好蓋在一起。
      const a = bareName(raw[i].name);
      const b = bareName(raw[k].name);
      if (a && b && a !== b && !a.includes(b) && !b.includes(a)) continue;
      taken[k] = true;
      group.push(raw[k]);
    }
    // 挑資訊最多的那個當代表。
    const best = group.slice().sort(
      (a, b) => (b.codes.length - a.codes.length) || ((b.nameEn ? 1 : 0) - (a.nameEn ? 1 : 0)),
    )[0];
    merged.push({
      ...best,
      wikidata: group.map((g) => g.wikidata).find(Boolean) || "",
      name: best.name || group.find((g) => g.name)?.name || "",
      nameEn: best.nameEn || group.find((g) => g.nameEn)?.nameEn || "",
      codes: [...new Set(group.flatMap((g) => g.codes))],
      lines: [],
    });
  }
  return merged;
}

/* ============================ 路線 ============================ */

const DIRECTION = "順向|逆向|順行|逆行|上行|下行|北向|南向|東向|西向|北上|南下";

/**
 * 把一個 route 關聯的名字洗成路線名。
 *
 * OSM 上同一條線的名字五花八門, 含的雜訊大致有三類:
 *
 *   方向    「高雄環狀輕軌 (順行)」「宜蘭線 (逆行)」
 *   起訖    「高雄捷運紅線 小港-岡山車站」「台電大樓 => 松山」
 *   英譯    「捷運紅線 (新北投支線) MRT red line (Xinbeitou Branch Line)」
 *
 * 起訖那一段只在「有空白隔開、而且後段看得出是兩個地名」時才砍 ——
 * 「南港-板橋-土城線」本身沒有空白, 是真正的線名, 不能動到它。
 */
export function tidyLineName(name) {
  let out = String(name || "")
    .replace(new RegExp(`[（(][^）)]*(${DIRECTION})[^）)]*[）)]`, "g"), " ")
    .replace(new RegExp(`\\s*(${DIRECTION})\\s*$`), "")
    .replace(/\s*\S+\s*=>\s*\S+\s*/g, " ")
    .replace(/[（(][^）)]*[A-Za-z][^）)]*[）)]/g, " ")   // 純英文的括號註解
    .replace(/[\sA-Za-z.]+$/, "")                       // 尾巴的英譯
    .trim();

  // 末段像「小港-岡山車站」這種起訖對就砍掉, 但「淡水線-信義線」要留 ——
  // 差別在於後者是線名, 字面上有「線」。
  const parts = out.split(/\s+/);
  const tail = parts[parts.length - 1];
  if (parts.length > 1 && /[-–—→]/.test(tail) && !tail.includes("線")) {
    out = parts.slice(0, -1).join(" ");
  }
  out = out.replace(/\s{2,}/g, " ").trim();

  // 「捷運紅線 (新北投支線)」——括號裡的才是大家在叫的名字。
  const branch = out.match(/[（(]\s*([^）)]*支線)\s*[）)]/);
  return branch ? branch[1] : out;
}

/**
 * 系統名當前綴是多餘的, 畫面上本來就照系統分組了。
 * 但砍完要還看得出是哪條線:「台北捷運中和新蘆線」砍成「中和新蘆線」很好, 
 * 「臺中捷運綠線」砍成「綠線」就太禿了。
 */
function dropSystemPrefix(name) {
  const trimmed = name.replace(/^(臺北捷運|台北捷運|新北捷運|桃園捷運|臺中捷運|台中捷運|高雄捷運)\s*/, "");
  return trimmed.length >= 4 ? trimmed : name;
}

/** 兩個字串的共同開頭。 */
function commonPrefix(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.slice(0, i);
}

/**
 * 從同一條線的一群名字裡挑一個。
 *
 * 先試共同開頭: 同一條線的兩個方向常常只差結尾（「臺中捷運綠線北屯總站方向」
 * 與「臺中捷運綠線高鐵台中站方向」→「臺中捷運綠線」）, 這比逐條寫規則去剝
 * 「…方向」可靠得多, 因為要剝掉幾個字得看站名有多長。
 *
 * 共同開頭太短就退回「出現最多次、再短者優先」——「淡水信義線」與
 * 「臺北捷運 淡水線-信義線」開頭完全不同, 這時短的那個才是大家在講的名字。
 */
export function lineName(names) {
  const cleaned = names.map(tidyLineName).filter(Boolean);
  if (!cleaned.length) return "";

  // 系統名要留到最後才砍。先砍的話「臺中捷運綠線北屯總站方向」與
  // 「臺中捷運綠線高鐵台中站方向」的共同開頭只剩「綠線」, 短到用不了, 
  // 結果會挑到其中一個帶方向的全名。
  const prefix = cleaned.reduce(commonPrefix).replace(/[\s（(・-]+$/, "").trim();
  if (prefix.length >= 3) return dropSystemPrefix(prefix);

  const tally = new Map();
  for (const name of cleaned) tally.set(name, (tally.get(name) || 0) + 1);
  const best = [...tally].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0][0];
  return dropSystemPrefix(best);
}

/** 從 route 關聯取出軌道折線（已投影、已接成鏈）。 */
function routeChains(relation) {
  const ways = (relation.members || [])
    .filter((member) => member.type === "way" && Array.isArray(member.geometry))
    .map((member) => member.geometry.map((g) => project(g.lon, g.lat)));
  return stitch(ways).filter((chain) => polylineLength(chain) > 300);
}

/**
 * 用站號把吸錯的站踢掉。
 *
 * 光看距離會出事的地方是並行、共構的路段: 淡海輕軌 V01 紅樹林就緊貼著
 * 淡水信義線的軌道, 兩座站都屬於「都會軌道」這個族群, 於是 V01 被算成
 * 淡水信義線的一站。但捷運站的站號本來就標了它屬於哪條線 ——
 * R27 是紅線、V01 是淡海輕軌、C3 是高雄輕軌 —— 拿線號去比就分得開。
 *
 * 只在「這條線的站號本來就對得上」時才動手（六成以上吻合）。
 * 臺鐵沒有線號、臺中捷運的站號是純數字 103–119, 這些情況一律放行, 
 * 免得規則反過來把整條線清空。
 */
function pruneByCode(claimed, stations, lineCode) {
  if (!lineCode || claimed.size < 2) return;

  const byId = new Map(stations.map((station) => [station.id, station]));
  // 比前綴就好, 不要求後面接數字: 高雄紅線的終點站是 RK1, 接的是字母。
  const pattern = new RegExp(`^${lineCode.replace(/[^\w]/g, "")}`, "i");
  const ids = [...claimed.keys()];
  const matched = ids.filter((id) => (byId.get(id)?.codes || []).some((code) => pattern.test(code)));

  if (matched.length < 2 || matched.length < ids.length * 0.6) return;
  const keep = new Set(matched);
  for (const id of ids) if (!keep.has(id)) claimed.delete(id);
}

/**
 * 把車站吸附到路線的各條鏈上。
 *
 * 一座站可能同時靠近同一條線的兩條鏈（例如折返線）, 所以先全部量過一輪, 
 * 每座站只留最近的那一條, 再依里程排序。里程要分鏈各自算 ——
 * 混在一起排會得到「楠梓、竹南、橋頭」這種跳來跳去的順序。
 */
function attach(chains, stations, family, radius, lineCode) {
  const claimed = new Map();

  chains.forEach((chain, chainIndex) => {
    for (const station of stations) {
      if (station.family !== family) continue;
      const hit = snap(station.point, chain);
      if (hit.distance > radius) continue;
      const prior = claimed.get(station.id);
      if (!prior || hit.distance < prior.distance) {
        claimed.set(station.id, { chainIndex, chainage: hit.chainage, distance: hit.distance });
      }
    }
  });

  pruneByCode(claimed, stations, lineCode);

  return chains.map((chain, chainIndex) => ({
    chain,
    stations: [...claimed.entries()]
      .filter(([, hit]) => hit.chainIndex === chainIndex)
      .sort((a, b) => a[1].chainage - b[1].chainage)
      .map(([id]) => id),
  }));
}

/**
 * 判斷兩條 route 關聯是不是同一條線。
 *
 * 不比名稱也不比 ref: 同一條淡水信義線在 OSM 上有「淡水信義線」與
 * 「臺北捷運 淡水線-信義線 (北向)」兩種寫法, 而松山新店線與小碧潭支線
 * 卻共用 ref=G。改看車站集合就沒有這些問題 ——
 *
 *   重疊 / 較少的那條 ≥ 0.6   兩條走的是同一段路
 *   較少 / 較多      ≥ 0.5   規模也相當
 *
 * 第二個條件是必要的: 少了它, 23 站的臺中線會被 100 站的縱貫線整條吞掉, 
 * 而 2 站的小碧潭支線會被 21 站的松山新店線吃掉。
 */
function sameLine(a, b) {
  if (a.system !== b.system) return false;
  // 兩條都沒有車站就只剩線號可以比（三鶯線的上下行是兩個關聯）。
  if (a.partial && b.partial) return Boolean(a.code) && a.code === b.code;
  const setA = new Set(a.stationIds);
  const overlap = b.stationIds.filter((id) => setA.has(id)).length;
  if (!overlap) return false;
  const small = Math.min(a.stationIds.length, b.stationIds.length);
  const large = Math.max(a.stationIds.length, b.stationIds.length);
  return overlap / small >= 0.6 && small / large >= 0.5;
}

/**
 * 一條鏈上「離既有路線夠遠」的連續段落 —— 也就是這條分支多出來的那一截。
 *
 * 拿來補畫支線。中和新蘆線在 OSM 上是兩個關聯（迴龍、蘆洲）, 兩條都走完
 * 整段幹線, 只有北端不同；淡海輕軌的綠山線與藍海線也是這樣。
 * 只取站數多的那一條會整條支線不見, 兩條都畫又會把幹線畫兩次、顏色糊掉。
 * 所以只挑出對方有、而我沒有的那一段接上去。
 *
 * 兩端各多留一個點, 支線才接得回幹線, 不會浮在半空中。
 */
function novelRuns(chain, reference, threshold = 150, minPoints = 2) {
  const far = chain.map(
    (point) => reference.every((path) => snap(point, path).distance > threshold),
  );

  const runs = [];
  let start = -1;
  for (let i = 0; i <= chain.length; i++) {
    if (i < chain.length && far[i]) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      const from = Math.max(0, start - 1);
      const to = Math.min(chain.length, i + 1);
      if (to - from >= minPoints) runs.push(chain.slice(from, to));
      start = -1;
    }
  }
  return runs;
}

/* ============================ 轉乘 ============================ */

/** 比對站名前先抹平寫法差異: 「臺北」「台北」「台北車站」要算同一個。 */
const canonName = (name) => bareName(name).replace(/臺/g, "台");

/**
 * 找出跨系統的轉乘站。
 *
 * 同一個系統內的轉乘不必算 —— 一座站本來就掛著它所有的路線（臺北車站
 * 同時是 R10 與 BL12）。要處理的是不同系統各有各的站體那種:
 * 臺北車站底下的臺鐵、高鐵與捷運是三個獨立的 OSM 元素。
 *
 * 只靠距離不夠。臺北車站與善導寺之間不到 600 公尺, 中山與雙連也很近, 
 * 所以還要求站名對得上, 才不會把相鄰站連成轉乘。
 */
function findTransfers(stations, radius = 400) {
  const parent = stations.map((_, index) => index);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));

  for (let i = 0; i < stations.length; i++) {
    for (let k = i + 1; k < stations.length; k++) {
      if (stations[i].system === stations[k].system) continue;
      if (dist(stations[i].point, stations[k].point) > radius) continue;
      const a = canonName(stations[i].name);
      const b = canonName(stations[k].name);
      if (!a || !b || (a !== b && !a.includes(b) && !b.includes(a))) continue;
      parent[find(i)] = find(k);
    }
  }

  const groups = new Map();
  stations.forEach((station, index) => {
    const root = find(index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(station.id);
  });
  return [...groups.values()].filter((group) => group.length > 1);
}

/* ============================ 車站等級 ============================ */

/**
 * 年運量的分級門檻。對照臺鐵自己的站等, 這三個值切出來的結果相當接近:
 * 10M 以上是臺北、桃園、高雄、中壢、臺南、臺中、新竹、板橋這一批（特等與一等）, 
 * 3M 以上是彰化、嘉義、花蓮、基隆、宜蘭、瑞芳那一層。
 */
const RIDERSHIP_TIERS = [10e6, 3e6, 700e3];

/**
 * 給每座車站一個 0–3 的等級, 畫圖時用來決定點的大小與標籤優先度。
 *
 * 臺鐵與高鐵看年運量 —— 臺鐵的站等本來就是照運量與營收評的, 用運量分級
 * 等於在還原同一件事, 而且是算出來的, 不必維護一張兩百多筆的站等表。
 * 運量取自 Wikidata（97% 的臺鐵車站查得到）。
 *
 * 捷運沒有這種資料（Wikidata 上只有 4% 的捷運站有運量）, 但捷運圖的層級
 * 本來就不是運量而是結構: 幾條線交會、是不是端點。所以改看結構。
 * 兩邊取大值, 運量小卻是大轉運點的站（例如新左營）才不會被畫成小點。
 */
function gradeStations(stations, lines, transfers, weights) {
  const termini = new Set();
  for (const line of lines) {
    if (!line.stations.length) continue;
    termini.add(line.stations[0]);
    termini.add(line.stations[line.stations.length - 1]);
  }

  const groupSize = new Map();
  for (const group of transfers) for (const id of group) groupSize.set(id, group.length);

  for (const station of stations) {
    const meeting = station.lines.length;
    const shared = groupSize.get(station.id) || 1;
    const structural = meeting >= 3 || shared >= 3 ? 3
      : meeting >= 2 || shared >= 2 ? 2
        : termini.has(station.id) ? 1 : 0;

    const riders = weights.get(station.wikidata);
    if ((station.family === "tra" || station.family === "thsr") && riders != null) {
      const tier = RIDERSHIP_TIERS.findIndex((floor) => riders >= floor);
      const byRiders = tier < 0 ? 0 : 3 - tier;
      // 有運量資料就以運量為準, 結構最多把它往上抬一級。
      // 直接取兩者最大值的話, 追分這種「三條線交會但一天沒幾個人」的小站
      // 會被畫得跟臺北一樣大 —— 它交會的是山線、海線與成追線, 結構分滿分, 
      // 實際上是個三等站。
      station.grade = Math.min(Math.max(byRiders, structural), byRiders + 1);
      station.riders = riders;
    } else {
      station.grade = structural;
    }
  }
}

/* ============================ 組裝 ============================ */

/**
 * OSM 回應 → 路網模型。
 *
 * @param {{elements: Array}} stationData railway=station 的查詢結果
 * @param {{elements: Array}} routeData   route 關聯的查詢結果（要有 out geom）
 */
export function buildNetwork(stationData, routeData, options = {}) {
  const {
    snapRadius = 150,   // 站到軌道的容許距離。實測九成的站落在 15 公尺內。
    tolerance = 40,     // 折線簡化容差（公尺）
    minStations = 2,    // 少於這個站數的線不要 —— 側線、糖鐵遺跡會自己被濾掉
    weights = new Map(),  // wikidata id → 年運量, 用來評車站等級（沒有也能跑）
  } = options;

  const stations = collectStations(stationData.elements || []);
  const stationById = new Map(stations.map((station) => [station.id, station]));

  /* ---- 每個 route 關聯各自算一次 ---- */
  const candidates = [];
  for (const relation of routeData.elements || []) {
    if (relation.type !== "relation") continue;
    const tags = relation.tags || {};
    if (tags.type !== "route") continue;
    if (!/^(railway|subway|light_rail|monorail|tram)$/.test(tags.route || "")) continue;

    const family = familyOf(tags);
    if (!family) continue;

    const chains = routeChains(relation);
    if (!chains.length) continue;

    // 臺鐵的 ref 是注音縮寫（縱貫線寫成「ㄗㄍㄒ」）, 當不了線號。
    const rawCode = String(tags.ref || "").trim();
    const code = /^[A-Za-z0-9]{1,4}$/.test(rawCode) ? rawCode : "";

    const attached = attach(chains, stations, family, snapRadius, code);
    const stationIds = attached.flatMap((entry) => entry.stations);

    // 站數不夠通常代表這是側線、貨運線那類雜訊, 丟掉。
    // 但若這條線在 OSM 上被好好標過（有線號、有識別色）而且夠長, 那多半是
    // 還沒有人標車站的新線 —— 三鶯線就是這樣, 整條軌道都在, 卻一個
    // railway=station 都沒有。這種留著, 畫成虛線並註明沒有站點資料。
    const curated = Boolean(code) && isHex(tags.colour);
    const metres = chains.reduce((sum, chain) => sum + polylineLength(chain), 0);
    const enough = stationIds.length >= minStations;
    if (!enough && !(curated && metres > 2000)) continue;

    // 業者看吸到的站, 不看關聯自己的標籤 —— 標籤常常是空的或只寫「捷運」。
    //
    // 但站點不全的線要反過來看標籤: 三鶯線在 OSM 上一個車站都還沒標, 
    // 只有終點頂埔碰得到板南線的站, 照多數決會把整條三鶯線判成臺北捷運。
    const tally = new Map();
    for (const id of stationIds) {
      const owner = stationById.get(id).system;
      tally.set(owner, (tally.get(owner) || 0) + 1);
    }
    const system = enough
      ? [...tally].sort((a, b) => b[1] - a[1])[0][0]
      : classify(tags.network, tags.operator, tags.name)?.id;
    if (!system) continue;

    candidates.push({
      system,
      code,
      rawName: tags.name || "",
      osmColour: tags.colour,
      attached,
      stationIds,
      partial: !enough,
    });
  }

  /* ---- 同一條線的多個關聯併起來 ---- */
  const parent = candidates.map((_, index) => index);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < candidates.length; i++) {
    for (let k = i + 1; k < candidates.length; k++) {
      if (sameLine(candidates[i], candidates[k])) parent[find(i)] = find(k);
    }
  }

  const groups = new Map();
  candidates.forEach((candidate, index) => {
    const root = find(index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(candidate);
  });

  /* ---- 每組挑一個代表, 產出路線 ---- */
  const lines = [];
  const usedIds = new Set();

  for (const group of groups.values()) {
    // 站數最多的那條最完整, 就用它的幾何 —— 用全部的話, 
    // 上下行兩條幾乎重疊的軌道會被畫兩次, 線看起來糊糊的。
    const best = group.slice().sort((a, b) => b.stationIds.length - a.stationIds.length)[0];
    const code = group.map((candidate) => candidate.code).find(Boolean) || "";
    const name = lineName(group.map((candidate) => candidate.rawName)) || code || "未命名路線";

    const base = `${best.system}-${(code || name).toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "")}`;
    let id = base;
    for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
    usedIds.add(id);

    const paths = best.attached
      .map((entry) => simplify(entry.chain, tolerance))
      .filter((path) => path.length > 1);
    const stationIds = best.attached.flatMap((entry) => entry.stations);

    // 同一組裡其他關聯若還帶著別的站（＝支線）, 把那些站與那一截軌道補進來。
    const seen = new Set(stationIds);
    for (const other of group) {
      if (other === best) continue;
      const extra = other.stationIds.filter((stationId) => !seen.has(stationId));
      if (!extra.length) continue;
      for (const stationId of extra) seen.add(stationId);
      stationIds.push(...extra);
      for (const entry of other.attached) {
        paths.push(...novelRuns(simplify(entry.chain, tolerance), paths));
      }
    }

    const line = {
      id,
      system: best.system,
      code,
      name,
      colour: pickColour(best.system, code, name, best.osmColour),
      paths,
      stations: stationIds,
      // 站點資料不全的線畫成虛線, 並在圖例標出來。
      ...(group.every((candidate) => candidate.partial) ? { partial: true } : {}),
    };
    for (const stationId of line.stations) stationById.get(stationId)?.lines.push(line.id);
    lines.push(line);
  }

  // 配色排在最後: 要先知道每條線畫在哪裡, 才知道誰跟誰相鄰。
  //
  // 站多的先配。顏色不夠時最後幾條只能跟別人共用, 而最後處理的如果是縱貫線
  // 這種橫跨全島的幹線, 它跟誰都算相鄰, 只好挑一條 6 公里外的深澳線同色。
  // 反過來讓幹線先拿, 共用就會落在兩條相隔很遠的小支線上。
  // 同站數時用線名排序, 結果才可重現、跟 OSM 回傳順序無關。
  assignPaletteColours(lines.slice().sort(
    (a, b) => b.stations.length - a.stations.length || a.name.localeCompare(b.name, "zh-Hant"),
  ));

  /* ---- 只留真的在線上的車站 ---- */
  const kept = stations.filter((station) => station.lines.length);
  const transfers = findTransfers(kept);
  gradeStations(kept, lines, transfers, weights);

  return {
    generated: new Date().toISOString().slice(0, 10),
    attribution: "© OpenStreetMap contributors, ODbL",
    systems: SYSTEMS
      .filter((system) => lines.some((line) => line.system === system.id))
      .map(({ id, name, nameEn, family, region }) => ({ id, name, nameEn, family, region })),
    lines: lines.sort(
      (a, b) => a.system.localeCompare(b.system) || a.name.localeCompare(b.name, "zh-Hant"),
    ),
    transfers,
    stations: kept.map((station) => ({
      id: station.id,
      name: station.name,
      nameEn: station.nameEn,
      codes: station.codes,
      system: station.system,
      grade: station.grade,
      ...(station.riders ? { riders: station.riders } : {}),
      x: station.point[0],
      y: station.point[1],
      lines: [...new Set(station.lines)],
    })),
  };
}
