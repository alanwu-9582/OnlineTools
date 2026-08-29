// js/tools/cone-unroll/pattern.js — 扇形裁切圖。

import { s, SVG_NS } from "../svg.js";

const mm = (n) => String(Math.round(n * 10) / 10);
const rad = (deg) => (deg * Math.PI) / 180;

const SCREEN = {
  bg: "transparent",
  fill: "rgba(255, 255, 255, 0.05)",
  tab: "color-mix(in srgb, var(--success) 22%, transparent)",
  cut: "var(--text)",
  fold: "var(--info)",
  guide: "var(--text-dim)",
  text: "var(--text)",
  dim: "var(--text-muted)",
  accent: "var(--interactive)",
};

const PRINT = {
  bg: "#ffffff",
  fill: "#fafafa",
  tab: "#eeeeee",
  cut: "#000000",
  fold: "#666666",
  guide: "#999999",
  text: "#000000",
  dim: "#444444",
  accent: "#000000",
};

/** 螢幕的 y 軸向下，幾何算的是向上，畫的時候統一在這裡翻。 */
const pt = (radius, deg) => [radius * Math.sin(rad(deg)), -radius * Math.cos(rad(deg))];

/**
 * @param {object} geo   geometry.js 的 unroll() 結果（kind: "sector"）
 * @param {{print?:boolean, glue?:number, lids?:boolean}} opts
 */
export function buildPattern(geo, { print = false, glue = 0, lids = false } = {}) {
  const c = print ? PRINT : SCREEN;
  const { outer, inner, angle, box } = geo;
  const start = box.start;
  const end = box.end;

  // 黏合邊貼在其中一條直邊外側，往外長 glue。
  const tabDir = start - 90;                       // 直邊往外的法線方向
  const [tx, ty] = [Math.sin(rad(tabDir)), -Math.cos(rad(tabDir))];
  const tabX = glue * tx;
  const tabY = glue * ty;

  const xs = [box.minX, box.maxX];
  const ys = [-box.maxY, -box.minY];
  if (glue > 0) {
    for (const r of [inner, outer]) {
      const [px, py] = pt(r, start);
      xs.push(px + tabX, px);
      ys.push(py + tabY, py);
    }
  }
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const span = Math.max(maxX - minX, maxY - minY);
  const fs = Math.max(span / 26, 3);
  const sw = Math.max(span / 500, 0.2);
  const pad = fs * 2.6;
  const vbW = maxX - minX + pad * 2;
  const vbH = maxY - minY + pad * 2;

  const svg = s("svg", {
    xmlns: SVG_NS,
    viewBox: `${minX - pad} ${minY - pad} ${vbW} ${vbH}`,
    ...(print ? { width: `${mm(vbW)}mm`, height: `${mm(vbH)}mm` } : {}),
    class: "cone-pattern",
    role: "img",
    "aria-label": `圓錐展開圖，扇形角度 ${mm(angle)} 度`,
  });

  if (print) {
    svg.appendChild(s("rect", {
      x: minX - pad, y: minY - pad, width: vbW, height: vbH, fill: c.bg,
    }));
  }

  const label = (x, y, text, opts = {}) => s("text", {
    x, y, fill: opts.fill || c.text,
    "font-size": opts.size || fs * 0.8,
    "font-family": "sans-serif", "font-weight": opts.weight || 400,
    "text-anchor": opts.anchor || "middle", "dominant-baseline": "middle",
  }, text);

  const [oStartX, oStartY] = pt(outer, start);
  const [oEndX, oEndY] = pt(outer, end);
  const [iStartX, iStartY] = pt(inner, start);
  const [iEndX, iEndY] = pt(inner, end);
  const large = angle > 180 ? 1 : 0;

  /* ---- 黏合邊：先畫，才會被扇形壓在下面 ---- */
  if (glue > 0) {
    svg.appendChild(s("polygon", {
      points: [
        [iStartX, iStartY], [oStartX, oStartY],
        [oStartX + tabX, oStartY + tabY], [iStartX + tabX, iStartY + tabY],
      ].map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" "),
      fill: c.tab, stroke: c.cut, "stroke-width": sw * 1.6,
    }));
    // 貼合的那條線是折線不是裁切線。
    svg.appendChild(s("line", {
      x1: iStartX, y1: iStartY, x2: oStartX, y2: oStartY,
      stroke: c.fold, "stroke-width": sw * 1.4,
      "stroke-dasharray": `${sw * 6} ${sw * 4}`,
    }));
  }

  /* ---- 扇形本體 ---- */
  const path = inner > 1e-9
    ? `M${oStartX},${oStartY} A${outer},${outer} 0 ${large} 1 ${oEndX},${oEndY}`
      + ` L${iEndX},${iEndY} A${inner},${inner} 0 ${large} 0 ${iStartX},${iStartY} Z`
    : `M${oStartX},${oStartY} A${outer},${outer} 0 ${large} 1 ${oEndX},${oEndY} L0,0 Z`;
  svg.appendChild(s("path", {
    d: path, fill: c.fill, stroke: c.cut,
    "stroke-width": sw * 2, "stroke-linejoin": "round",
  }));

  /* ---- 圓心：畫弧的時候圓規要頂在這裡 ---- */
  const cross = fs * 0.5;
  for (const [x1, y1, x2, y2] of [[-cross, 0, cross, 0], [0, -cross, 0, cross]]) {
    svg.appendChild(s("line", { x1, y1, x2, y2, stroke: c.guide, "stroke-width": sw * 1.2 }));
  }
  svg.appendChild(label(0, cross + fs * 0.7, "圓心", { size: fs * 0.62, fill: c.dim }));

  /* ---- 半徑標示 ---- */
  const midDeg = (start + end) / 2;
  const [rx, ry] = pt(outer, midDeg);
  svg.appendChild(s("line", {
    x1: 0, y1: 0, x2: rx, y2: ry,
    stroke: c.guide, "stroke-width": sw, "stroke-dasharray": `${sw * 4} ${sw * 3}`,
  }));
  svg.appendChild(label(rx * 0.62, ry * 0.62 - fs * 0.5, `外 ${mm(outer)}`, { size: fs * 0.72, fill: c.dim }));
  if (inner > 1e-9) {
    const [ix, iy] = pt(inner, midDeg);
    svg.appendChild(label(ix * 0.5, iy * 0.5 + fs * 0.7, `內 ${mm(inner)}`, { size: fs * 0.72, fill: c.dim }));
  }

  /* ---- 弦長：沒有量角器時就靠這條 ---- */
  svg.appendChild(s("line", {
    x1: oStartX, y1: oStartY, x2: oEndX, y2: oEndY,
    stroke: c.accent, "stroke-width": sw * 1.6,
    "stroke-dasharray": `${sw * 7} ${sw * 4}`,
  }));
  svg.appendChild(label(
    (oStartX + oEndX) / 2,
    (oStartY + oEndY) / 2 - fs * 0.75,
    `弦 ${mm(geo.chord)}`,
    { size: fs * 0.78, weight: 700, fill: c.accent },
  ));

  /* ---- 角度 ---- */
  svg.appendChild(label(0, -fs * 1.4, `${mm(angle)}°`, { size: fs * 0.9, weight: 700 }));

  /* ---- 上下底的圓片 ---- */
  if (lids) {
    const gap = fs * 1.2;
    let cx = maxX + pad * 0.4 + geo.bottomCircle;
    const cy = minY + geo.bottomCircle;
    svg.appendChild(s("circle", {
      cx, cy, r: geo.bottomCircle,
      fill: c.fill, stroke: c.cut, "stroke-width": sw * 2,
    }));
    svg.appendChild(label(cx, cy, `底 ⌀${mm(geo.bottomCircle * 2)}`, { size: fs * 0.7, fill: c.dim }));
    if (geo.topCircle > 1e-9) {
      const ty2 = cy + geo.bottomCircle + gap + geo.topCircle;
      svg.appendChild(s("circle", {
        cx, cy: ty2, r: geo.topCircle,
        fill: c.fill, stroke: c.cut, "stroke-width": sw * 2,
      }));
      svg.appendChild(label(cx, ty2, `頂 ⌀${mm(geo.topCircle * 2)}`, { size: fs * 0.7, fill: c.dim }));
    }
    // 圓片畫在右邊，viewBox 要跟著加寬。
    const extra = geo.bottomCircle * 2 + pad * 0.4;
    svg.setAttribute("viewBox", `${minX - pad} ${minY - pad} ${vbW + extra} ${Math.max(vbH, geo.bottomCircle * 2 + geo.topCircle * 2 + gap + pad * 2)}`);
    if (print) {
      svg.setAttribute("width", `${mm(vbW + extra)}mm`);
      svg.setAttribute("height", `${mm(Math.max(vbH, geo.bottomCircle * 2 + geo.topCircle * 2 + gap + pad * 2))}mm`);
    }
  }

  return svg;
}

/** 圓柱的展開就是一個長方形，不用扇形那一套。 */
export function buildCylinderPattern(geo, { print = false, glue = 0 } = {}) {
  const c = print ? PRINT : SCREEN;
  const w = geo.width;
  const h = geo.height;
  const fs = Math.max(Math.max(w, h) / 26, 3);
  const sw = Math.max(Math.max(w, h) / 500, 0.2);
  const pad = fs * 2.4;
  const vbW = w + glue + pad * 2;
  const vbH = h + pad * 2;

  const svg = s("svg", {
    xmlns: SVG_NS,
    viewBox: `${-pad - glue} ${-pad} ${vbW} ${vbH}`,
    ...(print ? { width: `${mm(vbW)}mm`, height: `${mm(vbH)}mm` } : {}),
    class: "cone-pattern",
    role: "img",
    "aria-label": `圓柱展開圖 ${mm(w)} × ${mm(h)} 公釐`,
  });
  if (print) {
    svg.appendChild(s("rect", { x: -pad - glue, y: -pad, width: vbW, height: vbH, fill: c.bg }));
  }
  if (glue > 0) {
    svg.appendChild(s("rect", {
      x: -glue, y: 0, width: glue, height: h,
      fill: c.tab, stroke: c.cut, "stroke-width": sw * 1.6,
    }));
    svg.appendChild(s("line", {
      x1: 0, y1: 0, x2: 0, y2: h,
      stroke: c.fold, "stroke-width": sw * 1.4, "stroke-dasharray": `${sw * 6} ${sw * 4}`,
    }));
  }
  svg.appendChild(s("rect", {
    x: 0, y: 0, width: w, height: h,
    fill: c.fill, stroke: c.cut, "stroke-width": sw * 2,
  }));
  const label = (x, y, text, size, fill) => s("text", {
    x, y, fill: fill || c.dim, "font-size": size, "font-family": "sans-serif",
    "text-anchor": "middle", "dominant-baseline": "middle",
  }, text);
  svg.appendChild(label(w / 2, h / 2, `${mm(w)} × ${mm(h)}`, fs * 0.9, c.text));
  svg.appendChild(label(w / 2, -fs * 1.1, `周長 ${mm(w)}`, fs * 0.75));
  return svg;
}
