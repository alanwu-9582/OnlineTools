// js/tools/rail-map/layout.js — 把地理路網整理成拓撲圖。
//
// 車站仍放在真實投影座標上, 保留東西南北與城市的相對位置；線路則改成站與站
// 之間的拓撲連接。這能濾掉軌道的小彎、上下行線與 OSM way 的碎裂, 同時避免
// 「縱貫線包含整條海岸線」這類上位路線把同一段再畫一次。

import { dist, bounds } from "./geo.js";

/* ============================ 視窗 ============================ */

/**
 * 算出「把 box 這塊區域塞進 width × height」的縮放與平移。
 * y 要翻過來 —— 投影座標往北是正的, SVG 往下才是正的。
 */
export function fitTransform(box, width, height, padding = 24) {
  const spanX = Math.max(1, box[2] - box[0]);
  const spanY = Math.max(1, box[3] - box[1]);
  const scale = Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY);
  return {
    scale,
    tx: padding + (width - padding * 2 - spanX * scale) / 2 - box[0] * scale,
    // box[3] 是最北邊, 翻過來之後它要落在最上面。
    ty: padding + (height - padding * 2 - spanY * scale) / 2 + box[3] * scale,
  };
}

/** 公尺 → 畫面。 */
export const toScreen = (view, x, y) => [x * view.scale + view.tx, view.ty - y * view.scale];

/** 畫面 → 公尺。滑鼠指到哪裡、以哪裡為中心縮放都要用它。 */
export const toWorld = (view, sx, sy) => [(sx - view.tx) / view.scale, (view.ty - sy) / view.scale];

/** 某些系統（或全部）涵蓋的範圍。地區切換就是換一個 box。 */
export function boundsOf(network, systemIds) {
  const wanted = systemIds && systemIds.length ? new Set(systemIds) : null;
  const points = network.stations
    .filter((station) => !wanted || wanted.has(station.system))
    .map((station) => [station.x, station.y]);
  return points.length ? bounds(points) : [0, 0, 1, 1];
}

/**
 * 判斷兩個站名是否只是業者前綴、車站後綴或「台／臺」寫法不同。
 * 「高鐵臺中站」與「台中」會視為同名；「新烏日」仍是另一個應保留的名稱。
 */
export function stationNameKey(name) {
  return String(name || "")
    .replace(/臺/g, "台")
    .replace(/^(高鐵|台鐵|捷運|輕軌)/, "")
    .replace(/(火車)?車?站$/, "")
    .trim();
}

/** 代表名稱放前面, 再依原始站體保留真正不同的別名。 */
export function stationGroupNames(group, head = group[0]) {
  const ordered = [head, ...group.filter((station) => station !== head)];
  const keys = new Set();
  const distinct = ordered.filter((station) => {
    const key = stationNameKey(station.name);
    if (!key || keys.has(key)) return false;
    keys.add(key);
    return true;
  });
  const hasAliases = distinct.length > 1;
  return distinct.map((station) => {
    // 名稱不同的共站若只寫「台中／新烏日」, 看不出前者是高鐵；補上系統前綴, 
    // 但不改掉資料裡真正的站名。只有一種名稱的臺北、板橋等不需要這個前綴。
    if (hasAliases && station.system === "thsr" && !/^高鐵/.test(station.name)) {
      return `高鐵${station.name}`;
    }
    return station.name;
  });
}

/* ============================ 拓撲整理 ============================ */

/**
 * 以地理距離建立一棵最小生成樹。鐵路線可以有分支, 不能只把資料陣列依序相連；
 * OSM 關聯被拆成幾段時, 那個陣列也不一定是實際站序。
 */
function stationTree(ids, byId) {
  if (ids.length < 2) return [];
  const linked = new Set([ids[0]]);
  const left = new Set(ids.slice(1));
  const edges = [];

  while (left.size) {
    let best = null;
    for (const from of linked) {
      const a = byId.get(from);
      for (const to of left) {
        const b = byId.get(to);
        const length = dist([a.x, a.y], [b.x, b.y]);
        if (!best || length < best.length) best = { from, to, length };
      }
    }
    edges.push([best.from, best.to]);
    linked.add(best.to);
    left.delete(best.to);
  }
  return edges;
}

const edgeKey = (a, b) => [a, b].sort().join("|");

/**
 * 補齊 OSM 名稱不同、但實際共站的高鐵／臺鐵站體。
 *
 * 新烏日／高鐵台中、六家／高鐵新竹、沙崙／高鐵台南、豐富／高鐵苗栗都在
 * 350 公尺內, 卻無法靠站名相同比對。只把規則套在高鐵與臺鐵之間, 才不會把
 * 萬華／龍山寺、楠梓／都會公園這類剛好相鄰但不是同一站的組合併在一起。
 */
function consolidateTransfers(network, stations, radius = 350) {
  const byId = new Map(stations.map((station, index) => [station.id, index]));
  const family = new Map(network.systems.map((system) => [system.id, system.family]));
  const parent = stations.map((_, index) => index);
  const find = (index) => (parent[index] === index
    ? index : (parent[index] = find(parent[index])));
  const join = (a, b) => { parent[find(a)] = find(b); };

  for (const group of network.transfers || []) {
    const indexes = group.map((id) => byId.get(id)).filter((index) => index != null);
    for (let i = 1; i < indexes.length; i++) join(indexes[0], indexes[i]);
  }

  for (let i = 0; i < stations.length; i++) {
    for (let k = i + 1; k < stations.length; k++) {
      const pair = new Set([family.get(stations[i].system), family.get(stations[k].system)]);
      if (!pair.has("tra") || !pair.has("thsr")) continue;
      if (dist([stations[i].x, stations[i].y], [stations[k].x, stations[k].y]) <= radius) join(i, k);
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

/**
 * 產生顯示專用的路網, 不改動下載來的原始資料。
 *
 * 若短線有八成以上的站也被某條長線收進去, 短線視為較具體的命名路線。
 * 長線在該區間的邊不再畫, 內部站也不再掛著長線；兩端仍保留兩條線, 才看得出
 * 分岔與銜接。典型例子是海岸線被縱貫線關聯完整包含。
 */
export function topologizeNetwork(network) {
  const stations = network.stations.map((station) => ({ ...station, lines: [...station.lines] }));
  const byId = new Map(stations.map((station) => [station.id, station]));
  const lines = network.lines.map((line) => ({ ...line, stations: [...line.stations] }));
  const trees = new Map();
  const memberships = new Map(lines.map((line) => [line.id, new Set(line.stations)]));

  for (const line of lines) {
    const ids = [...new Set(line.stations)].filter((id) => byId.has(id));
    trees.set(line.id, stationTree(ids, byId));
  }

  for (const broad of lines) {
    if (broad.partial) continue;
    const broadIds = new Set(broad.stations);
    for (const specific of lines) {
      if (specific === broad || specific.partial || specific.system !== broad.system) continue;
      if (specific.stations.length >= broad.stations.length) continue;
      const shared = specific.stations.filter((id) => broadIds.has(id));
      if (shared.length < 3 || shared.length / specific.stations.length < 0.8) continue;

      const specificEdges = trees.get(specific.id);
      const degree = new Map();
      for (const [a, b] of specificEdges) {
        degree.set(a, (degree.get(a) || 0) + 1);
        degree.set(b, (degree.get(b) || 0) + 1);
      }
      const terminals = new Set([...degree].filter(([, n]) => n === 1).map(([id]) => id));
      const covered = new Set(shared);
      trees.set(broad.id, trees.get(broad.id).filter(
        ([a, b]) => !(covered.has(a) && covered.has(b)),
      ));

      for (const id of shared) {
        if (terminals.has(id)) continue;
        memberships.get(broad.id).delete(id);
        const station = byId.get(id);
        station.lines = station.lines.filter((lineId) => lineId !== broad.id);
      }
    }
  }

  // 完全相同的站間邊仍只留一份；較短、較具體的路線優先。
  const owner = new Map();
  for (const line of [...lines].sort((a, b) => a.stations.length - b.stations.length)) {
    trees.set(line.id, trees.get(line.id).filter(([a, b]) => {
      const key = edgeKey(a, b);
      if (owner.has(key)) return false;
      owner.set(key, line.id);
      return true;
    }));
  }

  for (const line of lines) {
    const member = memberships.get(line.id);
    const edges = trees.get(line.id).filter(([a, b]) => member.has(a) && member.has(b));
    line.stations = line.stations.filter((id) => memberships.get(line.id).has(id));
    line.paths = edges.length
      ? edges.map(([a, b]) => [[byId.get(a).x, byId.get(a).y], [byId.get(b).x, byId.get(b).y]])
      : line.partial ? line.paths : [];
    line.topology = Boolean(edges.length);
  }

  return { ...network, lines, stations, transfers: consolidateTransfers(network, stations) };
}

/* ============================ 標籤 ============================ */

/**
 * 貼標籤, 會擋到別人的就不貼。
 *
 * 比較八個方向的留白與距離，優先放在鄰站及其他標籤較少的一側。
 * 已佔用的位置以矩形避讓，避免站名重疊。
 *
 * @param {Array<{x:number,y:number,text:string,priority:number}>} items 畫面座標
 */
export function placeLabels(items, {
  width, height, fontSize = 11, gap = 4, obstacles = [], majorPriority = Infinity,
} = {}) {
  const placed = [];
  const labels = [];        // 已經放好的標籤
  const marks = obstacles;  // 車站記號, 標籤不要壓在上面

  /** 相碰判定用嚴格不等式, 剛好貼齊邊界不算相碰。 */
  const hits = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
  const inside = (r) => r[0] >= 0 && r[1] >= 0 && r[2] <= width && r[3] <= height;

  /** 八方向候選位置；以實際字寬避讓，放不下就往外推。 */
  function candidates(item) {
    const textScale = 1 + (item.grade ?? 0) * 0.07;
    const labelWidth = item.labelWidth || [...item.text].reduce((sum, char) =>
      sum + (char.codePointAt(0) > 255 ? 1 : 0.62) * fontSize * textScale, 0);
    const labelHeight = item.labelHeight || fontSize + gap * 0.5;
    // 從記號的邊緣往外量, 不是從圓心 —— 等級高的站記號大, 從圓心量會被自己擋掉。
    const edge = Math.max(item.halfWidth || 0, item.halfHeight || 0, item.radius || 0) + gap;
    const out = [];

    for (const step of [0, 7, 16, 28]) {
      const d = edge + step;
      const spots = [
        { anchor: "start", x: item.x + d, y: item.y + fontSize * 0.36 },
        { anchor: "end", x: item.x - d, y: item.y + fontSize * 0.36 },
        { anchor: "start", x: item.x + d * 0.75, y: item.y - d * 0.75 },
        { anchor: "end", x: item.x - d * 0.75, y: item.y - d * 0.75 },
        { anchor: "start", x: item.x + d * 0.75, y: item.y + d * 0.75 + fontSize * 0.7 },
        { anchor: "end", x: item.x - d * 0.75, y: item.y + d * 0.75 + fontSize * 0.7 },
        { anchor: "middle", x: item.x, y: item.y - d },
        { anchor: "middle", x: item.x, y: item.y + d + fontSize },
      ];
      for (const spot of spots) {
        const left = spot.anchor === "start" ? spot.x
          : spot.anchor === "end" ? spot.x - labelWidth
            : spot.x - labelWidth / 2;
        const top = spot.y - fontSize;
        out.push({
          spot,
          step,
          rect: [left, top, left + labelWidth, top + labelHeight],
        });
      }
    }
    return out;
  }

  // 重要的先貼: 轉乘站與大站被擠掉的話, 地圖就沒有地標可以定位了。
  for (const item of [...items].sort((a, b) => b.priority - a.priority)) {
    // 同樣能放下時，選周圍留白較多的位置；限制外推距離以保留站名歸屬。
    const distance = (a, b) => Math.hypot(
      Math.max(0, a[0] - b[2], b[0] - a[2]),
      Math.max(0, a[1] - b[3], b[1] - a[3]),
    );
    const neighbours = marks.filter((rect) =>
      !(rect[0] <= item.x && rect[2] >= item.x && rect[1] <= item.y && rect[3] >= item.y));
    const options = candidates(item).map((option) => ({
      ...option,
      score: Math.min(32, ...[...neighbours, ...labels].map((rect) => distance(option.rect, rect)))
        - option.step * 1.5,
    })).sort((a, b) => b.score - a.score);

    let chosen = options.find((option) => inside(option.rect)
      && !labels.some((other) => hits(option.rect, other))
      && !marks.some((other) => hits(option.rect, other)));

    // 最後手段: 大站在密集區（臺北盆地裡上百個站擠成一團）不管往哪擺都會碰到
    // 別人的記號, 那寧可壓過一個記號, 也不要讓最該有名字的站沒有名字。
    if (!chosen && item.priority >= majorPriority) {
      chosen = options.find((option) => inside(option.rect)
        && !labels.some((other) => hits(option.rect, other)));
    }
    if (!chosen) continue;

    labels.push(chosen.rect);
    placed.push({ ...item, ...chosen.spot, labelRect: chosen.rect });
  }
  return placed;
}
