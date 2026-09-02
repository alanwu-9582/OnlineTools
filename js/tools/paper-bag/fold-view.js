// js/tools/paper-bag/fold-view.js — 把 fold-model 算出來的那一格畫成 SVG。

import { s } from "../svg.js";
import {
  foldState, cameraAt, buildFaces, signedArea, centroid2, holePoints,
  shadeOf, PANEL_NAME,
} from "./fold-model.js";

/**
 * 畫出 t 這一格。每一格都重新產生節點 —— 幾十個元素，比想辦法就地改屬性
 * 單純得多，也不會有前一格殘留的狀態。
 */
export function buildFoldFrame(geo, t, showHoles) {
  const st = foldState(t);
  const cam = cameraAt(t);
  const { panels, faces, creases } = buildFaces(geo, st);
  const front = panels[1];
  const back = panels[3];

  const flat = geo.paperW;
  const sw = Math.max(flat / 460, 0.55);
  const nodes = [];
  const seen = [];

  const flat2 = (pts) => pts.map((p) => cam.project(p));
  const toPoints = (pts2) => pts2.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");

  const drawn = faces.map((face) => {
    const pts2 = flat2(face.pts);
    seen.push(...pts2);
    return {
      ...face, pts2,
      depth: face.pts.reduce((sum, p) => sum + cam.depth(p), 0) / face.pts.length,
      area: signedArea(pts2),
    };
  });
  // 遠的先畫，近的蓋上去。
  drawn.sort((a, b) => b.depth - a.depth);

  // 後面那條提把繩要壓在袋身底下。
  if (showHoles && st.handle > 0) nodes.push(cordNode(geo, back, cam, st.handle, sw, 0.45));

  for (const face of drawn) {
    nodes.push(s("polygon", {
      points: toPoints(face.pts2),
      fill: face.tone,
      stroke: "var(--cffy-theme-surface-a0)",
      "stroke-width": sw,
      "stroke-linejoin": "round",
      style: `filter:brightness(${shadeOf(face.pts).toFixed(3)})`,
    }));
  }

  for (const [a, b] of creases) {
    const [x1, y1] = cam.project(a);
    const [x2, y2] = cam.project(b);
    nodes.push(s("line", {
      x1, y1, x2, y2, stroke: "var(--warning)", "stroke-width": sw * 1.2,
      "stroke-dasharray": `${sw * 7} ${sw * 4}`, opacity: 0.5,
    }));
  }

  // 面的名稱只標在正對鏡頭的那幾片上，翻過去的不標 —— 免得看到反字。
  // 字級跟著該面自己投影出來的短邊走: 黏合邊只有 20 mm 寬，用整體的字級
  // 會整個溢出去。太小就乾脆不標。
  const maxLabel = Math.max(Math.min(geo.W, geo.H) * 0.16, flat * 0.02);
  for (const face of drawn) {
    if (face.part !== "body" || face.area >= 0) continue;
    const xs = face.pts2.map((q) => q[0]);
    const ys = face.pts2.map((q) => q[1]);
    const short = Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    const size = Math.min(maxLabel, short * 0.62);
    if (size < flat * 0.014) continue;
    const [cx, cy] = centroid2(face.pts2);
    nodes.push(s("text", {
      x: cx, y: cy, fill: "var(--text)", "font-size": size,
      "font-family": "sans-serif", "font-weight": 700,
      "text-anchor": "middle", "dominant-baseline": "middle",
      opacity: 0.55,
    }, PANEL_NAME[face.kind]));
  }

  if (showHoles && st.handle > 0) {
    for (const point of holePoints(geo, front)) {
      const [cx, cy] = cam.project(point);
      nodes.push(s("circle", {
        cx, cy, r: Math.max(geo.paperW / 200, 1.5),
        fill: "var(--cffy-theme-surface-a0)", stroke: "var(--critical)",
        "stroke-width": sw * 1.4, opacity: st.handle,
      }));
    }
    nodes.push(cordNode(geo, front, cam, st.handle, sw, 1));
  }

  return { nodes, viewBox: fitViewBox(seen, flat * 0.06) };
}

function cordNode(geo, panel, cam, alpha, sw, opacity) {
  const [a, b] = holePoints(geo, panel);
  const [x1, y1] = cam.project(a);
  const [x2, y2] = cam.project(b);
  // 提把拉起來的高度跟孔距成比例，大袋子的繩子才不會看起來像條線。
  const rise = geo.holeSpan * 0.55 * alpha;
  return s("path", {
    d: `M${x1.toFixed(2)},${y1.toFixed(2)} Q${((x1 + x2) / 2).toFixed(2)},${(Math.min(y1, y2) - rise).toFixed(2)} ${x2.toFixed(2)},${y2.toFixed(2)}`,
    fill: "none", stroke: "var(--critical)", "stroke-width": sw * 2,
    "stroke-linecap": "round", opacity: alpha * opacity,
  });
}

/** 固定 3:2 的畫面，內容置中塞進去 —— 元素高度才不會每一格都在跳。 */
const VIEW_ASPECT = 3 / 2;

function fitViewBox(pts, pad) {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const [px, py] of pts) {
    minX = Math.min(minX, px); maxX = Math.max(maxX, px);
    minY = Math.min(minY, py); maxY = Math.max(maxY, py);
  }
  if (!Number.isFinite(minX)) return "0 0 100 66.7";

  minX -= pad; maxX += pad; minY -= pad; maxY += pad;
  let w = maxX - minX;
  let h = maxY - minY;
  if (w / h < VIEW_ASPECT) {
    const grow = h * VIEW_ASPECT - w;
    minX -= grow / 2; w += grow;
  } else {
    const grow = w / VIEW_ASPECT - h;
    minY -= grow / 2; h += grow;
  }
  return `${minX.toFixed(1)} ${minY.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}`;
}
