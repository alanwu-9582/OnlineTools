// js/tools/spacing/diagram.js — 照比例的示意圖。

import { s, SVG_NS } from "../svg.js";

const round = (n, d = 1) => String(Math.round(n * 10 ** d) / 10 ** d);

/** 中日韓字元約一個字寬，數字英文約六成 —— 用來判斷標籤擠不擠得下。 */
function textWidth(text, size) {
  let units = 0;
  for (const ch of String(text)) units += /[⺀-鿿＀-￯ -〿]/.test(ch) ? 1 : 0.6;
  return units * size;
}

/**
 * 直線等分的尺規圖。
 * 位置標在下面、間距標在上面，兩排數字擠在一起時自動錯開。
 */
export function linearDiagram({ length, width, positions, spans }) {
  // 字級相對總長不能太大: 1830 放 5 個的間距只有 55，也就是全寬的 3%，
  // 字太大就永遠塞不下，那排間距數字會整個消失。
  const fs = length / 44;
  const pad = { l: fs * 2.4, r: fs * 2.4, t: fs * 4.4, b: fs * 5.2 };
  const barTop = 0;
  const barH = fs * 2.6;

  const svg = s("svg", {
    xmlns: SVG_NS,
    viewBox: `${-pad.l} ${-pad.t} ${length + pad.l + pad.r} ${barH + pad.t + pad.b}`,
    class: "spacing-diagram",
    role: "img",
    "aria-label": `等分示意圖，總長 ${round(length)}`,
  });

  const line = (x1, y1, x2, y2, stroke, opts = {}) => s("line", {
    x1, y1, x2, y2, stroke,
    "stroke-width": opts.w || fs * 0.07,
    "stroke-dasharray": opts.dash || null,
    "stroke-linecap": "round",
  });
  const label = (x, y, text, opts = {}) => s("text", {
    x, y, fill: opts.fill || "var(--text-muted)",
    "font-size": opts.size || fs * 0.82,
    "font-family": "sans-serif",
    "font-weight": opts.weight || 400,
    "text-anchor": opts.anchor || "middle",
    "dominant-baseline": "middle",
  }, text);

  // 底料: 整段長度
  svg.appendChild(s("rect", {
    x: 0, y: barTop, width: length, height: barH,
    fill: "var(--cffy-theme-surface-a10)",
    stroke: "var(--border)", "stroke-width": fs * 0.07,
  }));

  // 物件本體。寬度是 0 的時候改畫一條線，不然看不見。
  for (const p of positions) {
    if (width > 0) {
      svg.appendChild(s("rect", {
        x: p, y: barTop, width, height: barH,
        fill: "var(--surface-selected)",
        stroke: "var(--interactive)", "stroke-width": fs * 0.09,
      }));
    } else {
      svg.appendChild(line(p, barTop - fs * 0.4, p, barTop + barH + fs * 0.4,
        "var(--interactive)", { w: fs * 0.12 }));
    }
  }

  // 上方: 每一段間距
  let cursor = 0;
  const gapY = -fs * 1.5;
  spans.forEach((span, i) => {
    const a = cursor;
    const b = cursor + span;
    cursor = b + (i < positions.length ? width : 0);
    if (span <= 0) return;
    svg.appendChild(line(a, gapY, b, gapY, "var(--text-dim)"));
    for (const x of [a, b]) {
      svg.appendChild(line(x, gapY - fs * 0.28, x, gapY + fs * 0.28, "var(--text-dim)"));
    }
    const text = round(span);
    if (span >= textWidth(text, fs * 0.82)) {
      svg.appendChild(label((a + b) / 2, gapY - fs * 0.75, text, { fill: "var(--text-dim)" }));
    }
  });

  // 總長
  svg.appendChild(label(length / 2, -fs * 3.5, `總長 ${round(length)}`,
    { size: fs * 0.95, weight: 700, fill: "var(--text)" }));

  // 下方: 累計刻度。實際劃線是拿尺壓著同一個邊量到底，這排才是真正會用到的數字。
  const scaleY = barH + fs * 1.5;
  svg.appendChild(line(0, scaleY, length, scaleY, "var(--text-muted)"));
  const ends = [-Infinity, -Infinity];
  for (const p of positions) {
    const text = round(p);
    const half = textWidth(text, fs * 0.82) / 2;
    const tier = p - half < ends[0] + fs * 0.35 ? 1 : 0;
    ends[tier] = p + half;
    svg.appendChild(line(p, scaleY - fs * 0.32, p, scaleY + fs * 0.32,
      "var(--text-muted)", { w: fs * 0.1 }));
    const y = scaleY + fs * (1.0 + tier * 1.15);
    if (tier) {
      svg.appendChild(line(p, scaleY + fs * 0.4, p, y - fs * 0.45,
        "var(--text-dim)", { w: fs * 0.05, dash: `${fs * 0.14} ${fs * 0.14}` }));
    }
    svg.appendChild(label(p, y, text));
  }
  svg.appendChild(label(-fs * 0.6, scaleY, "自左邊量",
    { size: fs * 0.7, anchor: "end", fill: "var(--text-dim)" }));

  return svg;
}

/** 圓周等分: 畫圓、標點、把一段弦畫出來。 */
export function circleDiagram({ diameter, points, chord }) {
  const r = diameter / 2;
  const fs = diameter / 16;
  const pad = fs * 3.2;
  const box = diameter + pad * 2;

  const svg = s("svg", {
    xmlns: SVG_NS,
    viewBox: `${-r - pad} ${-r - pad} ${box} ${box}`,
    class: "spacing-diagram is-circle",
    role: "img",
    "aria-label": `圓周等分示意圖，直徑 ${round(diameter)} 分 ${points.length} 等分`,
  });

  svg.appendChild(s("circle", {
    cx: 0, cy: 0, r,
    fill: "none", stroke: "var(--border)", "stroke-width": fs * 0.12,
  }));
  // 圓心的十字，實際劃線要先定出圓心。
  for (const [x1, y1, x2, y2] of [[-fs * 0.5, 0, fs * 0.5, 0], [0, -fs * 0.5, 0, fs * 0.5]]) {
    svg.appendChild(s("line", {
      x1, y1, x2, y2, stroke: "var(--text-dim)", "stroke-width": fs * 0.08,
    }));
  }

  // SVG 的 y 軸向下，圓周座標的 y 是向上，畫的時候要翻過來。
  const at = (p) => [p.x, -p.y];

  points.forEach((p, i) => {
    const [x, y] = at(p);
    svg.appendChild(s("line", {
      x1: 0, y1: 0, x2: x, y2: y,
      stroke: "var(--border-soft)", "stroke-width": fs * 0.06,
      "stroke-dasharray": `${fs * 0.2} ${fs * 0.2}`,
    }));
    svg.appendChild(s("circle", {
      cx: x, cy: y, r: fs * 0.3,
      fill: "var(--cffy-theme-surface-a0)",
      stroke: "var(--critical)", "stroke-width": fs * 0.12,
    }));
    svg.appendChild(s("text", {
      x: x * 1.24, y: y * 1.24,
      fill: "var(--text-muted)", "font-size": fs * 0.75,
      "font-family": "sans-serif", "text-anchor": "middle", "dominant-baseline": "middle",
    }, String(i + 1)));
  });

  // 第一段弦: 用尺量這個距離就能定位，不必量角器。
  if (points.length >= 2) {
    const [x1, y1] = at(points[0]);
    const [x2, y2] = at(points[1]);
    svg.appendChild(s("line", {
      x1, y1, x2, y2,
      stroke: "var(--interactive)", "stroke-width": fs * 0.14, "stroke-linecap": "round",
    }));
    svg.appendChild(s("text", {
      x: (x1 + x2) / 2, y: (y1 + y2) / 2 - fs * 0.7,
      fill: "var(--interactive)", "font-size": fs * 0.8, "font-weight": 700,
      "font-family": "sans-serif", "text-anchor": "middle", "dominant-baseline": "middle",
    }, `弦 ${round(chord)}`));
  }

  return svg;
}
