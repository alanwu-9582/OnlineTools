// js/tools/rail-map/render.js — 把路網畫成 SVG。
//
// 畫法是捷運圖的畫法（八方向色帶、圓角轉折、轉乘站併成一個記號）, 車站則
// 保留地理座標, 所以資料一變, 圖仍會跟著變, 不需要人工挪節點。
//
// 每次縮放、平移都整張重畫。折線點總共只有兩千多個, 重畫一次幾毫秒, 
// 比維護一份「畫到一半的狀態」單純太多。

import { s, SVG_NS } from "../svg.js";
import { toScreen, stationGroupNames } from "./layout.js";

/**
 * 隨著縮放調整的尺寸。
 *
 * `scale` 的單位是「每公尺幾個畫素」: 全臺灣大約 0.002, 單一都會區大約 0.02。
 * 全圖的時候線要細, 不然整個西部會糊成一團；拉近之後才放粗。
 */
function metrics(scale) {
  if (scale < 0.005) return { line: 2.4, dot: 1.7, label: 0, font: 10 };
  if (scale < 0.012) return { line: 3.2, dot: 2.2, label: 1, font: 10.5 };
  if (scale < 0.03) return { line: 4, dot: 2.8, label: 2, font: 11 };
  return { line: 5, dot: 3.4, label: 3, font: 12 };
}

/**
 * 車站等級 0–3 對應的放大倍率。
 *
 * 等級怎麼來的見 network.js 的 gradeStations(): 臺鐵與高鐵看年運量
 * （臺鐵的站等本來就是照運量評的）, 捷運看交會的線數。
 */
const GRADE_SCALE = [1, 1.25, 1.6, 2.05];

/**
 * 貼標籤的先後順序。等級的權重要壓過交會線數 ——
 * 不然全臺圖上臺北盆地裡每個捷運轉乘站都跟臺北、高雄這種大站同分, 
 * 光北部就冒出幾十個標籤, 其他地方反而看不到地名。
 */
export const MAJOR_PRIORITY = 15;
const priorityOf = (grade, lines, interchange) =>
  grade * 5 + (lines - 1) * 2 + (interchange ? 2 : 0);

/** 只標真正的航廈／航空站, 避免把「機場旅館」也畫成機場。 */
const AIRPORT_STOP = /^(松山機場|高雄國際機場|機場第一航廈|機場第二航廈|第一航廈|第二航廈)$/;
const AIRPORT_ICON = new URL("../../../assets/icons/airport.svg", import.meta.url).href;

/**
 * 兩站之間只用水平、垂直與 45° 斜線。端點仍是真實站位, 較長的軸留一小段
 * 水平或垂直線來吸收差值；因此線像路網圖, 站的大致方位卻不會跑掉。
 */
function topologySegment(a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const diagonal = Math.min(Math.abs(dx), Math.abs(dy));
  if (diagonal < 1) return [b];

  if (Math.abs(dx) > Math.abs(dy)) {
    return [[b[0] - Math.sign(dx) * (Math.abs(dx) - diagonal), b[1]], b];
  }
  return [[b[0], b[1] - Math.sign(dy) * (Math.abs(dy) - diagonal)], b];
}

/** 折線 → path。拓撲線段會正規化成八方向, 尚無站點的規劃線保留原幾何。 */
function pathData(path, view, topology) {
  const points = path.map(([x, y]) => toScreen(view, x, y));
  if (!points.length) return "";
  const routed = [points[0]];
  for (let i = 1; i < points.length; i++) {
    routed.push(...(topology ? topologySegment(points[i - 1], points[i]) : [points[i]]));
  }
  let d = `M${routed[0][0].toFixed(1)} ${routed[0][1].toFixed(1)}`;
  for (let i = 1; i < routed.length; i++) {
    const point = routed[i], previous = routed[i - 1], next = routed[i + 1];
    if (!topology || !next) { d += `L${point[0].toFixed(1)} ${point[1].toFixed(1)}`; continue; }
    const before = Math.hypot(point[0] - previous[0], point[1] - previous[1]);
    const after = Math.hypot(next[0] - point[0], next[1] - point[1]);
    const radius = Math.min(8, before / 4, after / 4);
    if (!radius) continue;
    const entry = point.map((v, axis) => v + (previous[axis] - v) * radius / before);
    const exit = point.map((v, axis) => v + (next[axis] - v) * radius / after);
    d += `L${entry[0].toFixed(1)} ${entry[1].toFixed(1)}Q${point[0].toFixed(1)} ${point[1].toFixed(1)} ${exit[0].toFixed(1)} ${exit[1].toFixed(1)}`;
  }
  return d;
}

/**
 * 把車站分組, 一組畫成一個記號。
 *
 * 一座轉乘站在 OSM 上是好幾個獨立的元素 —— 臺北車站底下有臺鐵、高鐵與
 * 兩家捷運四個站體。各畫一個圓點再拉線連起來, 看起來像四座不同的車站擠在
 * 一起, 但實際上那就是同一座車站。捷運圖的畫法是併成一個記號, 這裡照做。
 */
function clustersOf(transfers, stations, present) {
  const taken = new Set();
  const groups = [];

  for (const group of transfers || []) {
    const members = group.filter((id) => present.has(id));
    if (members.length < 2) continue;
    groups.push(members);
    for (const id of members) taken.add(id);
  }
  for (const station of stations) {
    if (!taken.has(station.id)) groups.push([station.id]);
  }
  return groups;
}

/**
 * 畫一整張圖。
 *
 * @param {object} model
 * @param {object} model.network   路網
 * @param {object} model.view      fitTransform() 的結果
 * @param {Set<string>} model.visible  要顯示的路線 id
 * @param {string|null} model.focusLine   只留這條線, 其餘變淡
 * @param {object|null} model.selected    選起來的車站
 */
export function drawMap(model) {
  const { network, view, width, height, visible } = model;
  const size = metrics(view.scale);

  const root = s("svg", {
    class: "railmap-svg",
    viewBox: `0 0 ${width} ${height}`,
    width: "100%",
    height: "100%",
    preserveAspectRatio: "xMidYMid meet",
    role: "img",
    "aria-label": "臺灣鐵路與捷運路網圖",
  });

  const lines = network.lines.filter((line) => visible.has(line.id));
  const shown = new Set(lines.map((line) => line.id));
  const colourOf = new Map(lines.map((line) => [line.id, line.colour]));
  const stations = network.stations.filter(
    (station) => station.lines.some((id) => shown.has(id)),
  );
  const byId = new Map(stations.map((station) => [station.id, station]));
  const lineById = new Map(lines.map((line) => [line.id, line]));

  /* ---- 色帶 ---- */
  const trackLayer = s("g", { class: "railmap-tracks" });
  for (const line of lines) {
    const dim = model.focusLine && model.focusLine !== line.id;
    const group = s("g", {
      class: `railmap-line${dim ? " is-dim" : ""}`,
      "data-line": line.id,
    });
    line.paths.forEach((path) => {
      const d = pathData(path, view, line.topology);
      // 底下先鋪一條略粗的底色, 交會的地方才看得出哪條在上面。
      group.appendChild(s("path", { class: "railmap-casing", d, "stroke-width": size.line + 2.4 }));
      group.appendChild(s("path", {
        class: "railmap-track",
        d,
        stroke: line.colour,
        "stroke-width": size.line,
        // 站點還沒進 OSM 的線（例如三鶯線）畫成虛線, 跟有站的線區分開。
        "stroke-dasharray": line.partial ? `${(size.line * 2.4).toFixed(1)} ${(size.line * 1.6).toFixed(1)}` : null,
      }));
    });
    trackLayer.appendChild(group);
  }
  root.appendChild(trackLayer);

  /* ---- 車站 ---- */
  const stationLayer = s("g", { class: "railmap-stations" });
  const landmarkLayer = s("g", { class: "railmap-landmarks" });
  const marks = [];

  for (const members of clustersOf(network.transfers, stations, byId)) {
    const group = members.map((id) => byId.get(id)).filter(Boolean);
    if (!group.length) continue;

    const points = group.map((station) => toScreen(view, station.x, station.y));
    if (points.every(([x, y]) => x < -40 || y < -40 || x > width + 40 || y > height + 40)) continue;

    const own = [...new Set(group.flatMap((station) => station.lines))].filter((id) => shown.has(id));
    const grade = Math.max(...group.map((station) => station.grade ?? 0));
    const interchange = own.length > 1 || group.length > 1;
    const radius = size.dot * GRADE_SCALE[grade] * (interchange ? 1.35 : 1);

    // 代表這一組的是等級最高的那一站: 標籤掛它的名字, 點到也是選它。
    const head = group.slice().sort(
      (a, b) => (b.grade ?? 0) - (a.grade ?? 0) || b.lines.length - a.lines.length,
    )[0];
    const displayName = stationGroupNames(group, head).join("／");
    const anchor = points[group.indexOf(head)];
    const selected = model.selected && members.includes(model.selected.id);
    const classes = `railmap-stop${interchange ? " is-interchange" : ""}${selected ? " is-selected" : ""}`;
    const airport = group.some((station) => AIRPORT_STOP.test(station.name));

    let halfWidth = radius;
    let halfHeight = radius;
    let markX = anchor[0];
    let markY = anchor[1];
    if (interchange) {
      // 真正的轉乘站用較大塊的圓角矩形。跨系統站體即使座標略有差距, 也由
      // 同一塊記號包住, 避免看起來像幾顆互不相干的圓點。
      const xs = points.map(([x]) => x);
      const ys = points.map(([, y]) => y);
      const left = Math.min(...xs) - radius * 1.15;
      const right = Math.max(...xs) + radius * 1.15;
      const top = Math.min(...ys) - radius * 1.05;
      const bottom = Math.max(...ys) + radius * 1.05;
      const minWidth = radius * (2.8 + Math.min(own.length, 4) * 0.35);
      const boxWidth = Math.max(right - left, minWidth);
      const boxHeight = Math.max(bottom - top, radius * 2.25);
      const cx = (left + right) / 2;
      const cy = (top + bottom) / 2;
      markX = cx;
      markY = cy;
      halfWidth = boxWidth / 2;
      halfHeight = boxHeight / 2;
      stationLayer.appendChild(s("rect", {
        class: `railmap-transfer ${classes}`,
        x: (cx - halfWidth).toFixed(1),
        y: (cy - halfHeight).toFixed(1),
        width: boxWidth.toFixed(1),
        height: boxHeight.toFixed(1),
        rx: Math.min(radius, boxHeight * 0.28).toFixed(1),
        "data-station": head.id,
      }));
    } else {
      stationLayer.appendChild(s("circle", {
        class: classes,
        cx: anchor[0].toFixed(1),
        cy: anchor[1].toFixed(1),
        r: radius.toFixed(1),
        stroke: interchange ? null : colourOf.get(own[0]),
        "stroke-width": Math.max(1.2, radius * 0.62).toFixed(1),
        "data-station": head.id,
      }));
    }

    if (airport) {
      const iconX = markX + halfWidth + 4;
      const iconY = markY - 7;
      landmarkLayer.appendChild(s("image", {
        class: "railmap-landmark is-airport",
        x: iconX.toFixed(1),
        y: iconY.toFixed(1),
        width: 14,
        height: 14,
        href: AIRPORT_ICON,
        "aria-label": "機場",
      }));
    }

    const badgeCodes = group.flatMap((station) => station.codes.map((code) => {
      const line = station.lines.map((id) => lineById.get(id)).find(Boolean);
      return { code, colour: line?.colour || "#777" };
    })).filter((item, index, all) => all.findIndex((other) => other.code === item.code) === index)
      .slice(0, 3);
    const badge = size.label === 0 && grade >= 3;

    marks.push({
      id: head.id,
      x: markX,
      y: markY,
      text: displayName,
      grade,
      // 等級與交會線數決定誰先貼標籤 —— 縮小的時候只留得下最重要的幾個。
      priority: priorityOf(grade, own.length, interchange),
      radius,
      halfWidth,
      halfHeight,
      badge,
      badgeCodes,
      ...(badge ? {
        labelWidth: Math.max(78, Math.min(142, displayName.length * 12 + 28)),
        labelHeight: 35,
      } : {}),
    });
  }
  root.appendChild(stationLayer);
  root.appendChild(landmarkLayer);

  const obstacles = marks.map(
    (mark) => [
      mark.x - mark.halfWidth, mark.y - mark.halfHeight,
      mark.x + mark.halfWidth, mark.y + mark.halfHeight,
    ],
  );

  return { root, marks, obstacles, size };
}

/** 把算好位置的標籤畫上去。 */
export function drawLabels(root, placed, font) {
  const layer = s("g", { class: "railmap-labels" });
  for (const label of placed) {
    if (label.badge) {
      const [left, top, right, bottom] = label.labelRect;
      const badge = s("g", { class: "railmap-major-badge", "data-station": label.id },
        s("rect", {
          class: "railmap-major-badge-bg", x: left.toFixed(1), y: top.toFixed(1),
          width: (right - left).toFixed(1), height: (bottom - top).toFixed(1), rx: 5,
        }),
        // 小型車頭圖示, 讓黑底站牌即使沒有文字也能被辨識為鐵路樞紐。
        s("rect", { class: "railmap-major-train", x: left + 6, y: top + 6, width: 13, height: 14, rx: 3 }),
        s("path", { class: "railmap-major-train-detail", d: `M${left + 9} ${top + 10}h7M${left + 9} ${top + 14}h1M${left + 15} ${top + 14}h1M${left + 8} ${top + 22}l2-2M${left + 17} ${top + 22}l-2-2` }),
        s("text", { class: "railmap-major-name", x: left + 23, y: top + 14 }, label.text),
      );
      let chipX = left + 23;
      for (const item of label.badgeCodes) {
        const chipWidth = Math.max(19, item.code.length * 5.2 + 6);
        if (chipX + chipWidth > right - 3) break;
        badge.appendChild(s("rect", {
          class: "railmap-major-code-bg", x: chipX, y: top + 20,
          width: chipWidth, height: 10, rx: 2, fill: item.colour,
        }));
        badge.appendChild(s("text", {
          class: "railmap-major-code", x: chipX + chipWidth / 2, y: top + 27.7,
          "text-anchor": "middle",
        }, item.code));
        chipX += chipWidth + 3;
      }
      layer.appendChild(badge);
      continue;
    }
    // 底色描邊靠 CSS 的 paint-order 畫在字下面, 不必再複製一個節點墊著。
    layer.appendChild(s("text", {
      class: (label.grade ?? 0) >= 2 ? "is-major" : null,
      x: label.x.toFixed(1),
      y: label.y.toFixed(1),
      "text-anchor": label.anchor,
      // 大站的字大一點, 層級看得出來。
      "font-size": (font * (1 + (label.grade ?? 0) * 0.07)).toFixed(1),
      "data-station": label.id,
    }, label.text));
  }
  root.appendChild(layer);
  return layer;
}

/**
 * 產生一份可以單獨存檔的 SVG。
 *
 * 畫面上的樣式來自 rail-map.css, 檔案存出去就沒有了 —— 色帶外圍的底色、
 * 站點的填色、站名的描邊全都會不見, 變成一堆黑塊。所以複製一份, 
 * 把當下佈景的顏色算出來寫成 <style> 塞進去, 順便補一塊背景。
 *
 * @param {SVGElement} svg  畫面上的那一張
 * @param {Element} host    拿來讀 CSS 變數的元素
 */
export function standalone(svg, host) {
  const onMap = getComputedStyle(svg);
  const read = (name, fallback) => onMap.getPropertyValue(name).trim() || fallback;
  const paper = read("--map-paper", "#1a1a1a");
  const ink = read("--map-ink", "#e6e6e6");
  const inkStrong = read("--map-ink-strong", "#ffffff");
  const link = getComputedStyle(host).getPropertyValue("--link").trim() || "#4da3ff";

  const clone = svg.cloneNode(true);
  clone.setAttribute("width", svg.viewBox.baseVal.width || svg.clientWidth);
  clone.setAttribute("height", svg.viewBox.baseVal.height || svg.clientHeight);
  clone.setAttribute("xmlns", SVG_NS);

  const style = document.createElementNS(SVG_NS, "style");
  style.textContent = `
    .railmap-tracks path { fill: none; stroke-linecap: round; stroke-linejoin: round; }
    .railmap-casing { stroke: ${paper}; }
    .railmap-line.is-dim { opacity: 0.16; }
    .railmap-stop { fill: ${paper}; }
    .railmap-stop.is-interchange { stroke: ${inkStrong}; }
    .railmap-transfer { fill: ${paper}; stroke: ${inkStrong}; stroke-width: 2.4; }
    .railmap-stop.is-selected, .railmap-transfer.is-selected { stroke: ${link}; }
    .railmap-landmark { pointer-events: none; }
    .railmap-labels text {
      paint-order: stroke fill; fill: ${ink}; stroke: ${paper};
      stroke-width: 3.5; stroke-linejoin: round; font-weight: 500;
      font-family: system-ui, "Noto Sans TC", sans-serif;
    }
    .railmap-labels text.is-major { fill: ${inkStrong}; font-weight: 700; }
    .railmap-major-badge-bg { fill: #111; stroke: #c9c9c9; stroke-width: 1.5; }
    .railmap-major-train { fill: none; stroke: #fff; stroke-width: 1.4; }
    .railmap-major-train-detail { fill: none; stroke: #fff; stroke-width: 1.1; stroke-linecap: round; }
    .railmap-labels .railmap-major-name { fill: #fff; stroke: none; font-size: 11px; font-weight: 700; }
    .railmap-labels .railmap-major-code { fill: #fff; stroke: none; font: 700 6.5px monospace; }
  `;

  const backdrop = document.createElementNS(SVG_NS, "rect");
  backdrop.setAttribute("width", "100%");
  backdrop.setAttribute("height", "100%");
  backdrop.setAttribute("fill", paper);

  clone.prepend(backdrop);
  clone.prepend(style);
  return clone;
}
