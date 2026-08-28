// js/tools/paper-bag.js — 手工紙袋計算機。
//
// 算的是最常見的那種「方底提袋」（SOS bag）：一張長方形紙，捲成筒、
// 折出兩側的內凹側面，底部收成平的長方形。照片上那種牛皮紙袋就是這個結構。
//
// 展開圖的幾何：
//
//   橫向  [黏合邊 G][前 W][側 D][後 W][側 D]        紙寬 = G + 2W + 2D
//   縱向  [上緣折邊 T][袋身 H][底部 B]              紙高 = T + H + B
//
// 底部高度 B = D/2 + 重疊。理由：底面是一個 W×D 的長方形，前後兩片各要
// 蓋過中線才黏得住 —— 剛好蓋到中線是 D/2，再多出來的就是重疊量。
// 側面在底部收成兩個 45° 的三角形，頂點落在離底線 D/2 的地方，
// 所以斜折線一定是 45°，這不是估的。
//
// 提把只標打洞位置：真正的紙繩提把要另外穿，怎麼穿跟紙張怎麼裁無關。

import {
  panel, row, field, numberInput, select, segmented, button, actions, outputRow,
  status, note, subhead, el,
} from "./kit.js";
import { notify } from "../ui/notifications.js";

export const meta = { title: "手工紙袋計算機" };

const SVG_NS = "http://www.w3.org/2000/svg";

/** 建 SVG 節點。utils 的 el() 走 createElement，對 SVG 不管用。 */
function s(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** 尺寸標示只留一位小數；紙張裁到 0.1 mm 已經超過手工的極限。 */
const mm = (n) => String(Math.round(n * 10) / 10);

/** 無條件進位到 5 的倍數 —— 手裁紙照 5 mm 的刻度比較好對。 */
const roundUp5 = (n) => Math.ceil(n / 5) * 5;

/* ================= 常見紙張尺寸 ================= */

const PAPER_SIZES = [
  { label: "A5", w: 148, h: 210 },
  { label: "B5", w: 176, h: 250 },
  { label: "A4", w: 210, h: 297 },
  { label: "B4", w: 257, h: 364 },
  { label: "A3", w: 297, h: 420 },
  { label: "B3", w: 364, h: 515 },
  { label: "A2", w: 420, h: 594 },
  { label: "四開", w: 392, h: 543 },
  { label: "A1", w: 594, h: 841 },
  { label: "對開", w: 543, h: 788 },
  { label: "A0", w: 841, h: 1189 },
  { label: "全開", w: 788, h: 1091 },
];

/** 放得下這張展開圖的最小標準紙，兩個方向都試。 */
function suggestPaper(width, height) {
  const fits = PAPER_SIZES
    .map((size) => {
      const upright = size.w >= width && size.h >= height;
      const landscape = size.h >= width && size.w >= height;
      if (!upright && !landscape) return null;
      return { ...size, area: size.w * size.h, orientation: upright ? "直放" : "橫放" };
    })
    .filter(Boolean)
    .sort((a, b) => a.area - b.area);
  return fits[0] || null;
}

/* ================= 反推：一張紙最大能做多大的袋子 ================= */

/**
 * 橫向被綁死：2(W + D) = 紙寬 − 黏合邊，所以 W + D 是一個常數 S。
 * 縱向也被綁死：H = 紙高 − 上緣 − 重疊 − D/2。
 * 也就是說整個袋子只剩一個自由度 —— 挑了 D，W 跟 H 就跟著決定了。
 *
 * ratio 是側面厚度相對正面寬度的比例（D/W）；傳 "max" 就改成解容量的極值。
 *
 * @returns {{W:number, D:number, H:number, leftoverW:number, leftoverH:number}|null}
 */
function fitToPaper({ paperW, paperH, glue, hem, overlap, ratio }) {
  const S = (paperW - glue) / 2;      // = W + D
  const K = paperH - hem - overlap;   // = H + D/2
  if (!(S > 0) || !(K > 0)) return null;

  let D;
  if (ratio === "max") {
    // V(D) = (S − D)·D·(K − D/2)。微分整理後是 3D² − 2(S + 2K)D + 2SK = 0。
    // 判別式 (S + 2K)² − 6SK = (S − K)² + 3K² 恆正，而較小的那個根才是極大值
    // （三次項係數為正，所以小根是局部極大、大根是局部極小）。
    const b = S + 2 * K;
    D = (b - Math.sqrt(b * b - 6 * S * K)) / 3;
  } else {
    // D/W = r  →  W = S/(1+r)，D = S − W。
    const r = Number(ratio);
    if (!Number.isFinite(r) || r <= 0) return null;
    D = (S * r) / (1 + r);
  }

  // 無條件捨去到 1 mm。往下取一定不會超出紙張，剩下的當餘料回報，
  // 不要為了用滿而給出 60.4917 mm 這種手裁不出來的數字。
  const Dr = Math.floor(Math.min(D, S - 1, 2 * (K - 1)));
  const W = Math.floor(S - Dr);
  const H = Math.floor(K - Dr / 2);
  if (W < 1 || Dr < 1 || H < 1) return null;

  return {
    W, D: Dr, H,
    leftoverW: paperW - (glue + 2 * W + 2 * Dr),
    leftoverH: paperH - (hem + H + Dr / 2 + overlap),
  };
}

/* ================= 幾何 ================= */

/**
 * 從紙袋尺寸算出展開圖。
 * @param {{W:number, D:number, H:number, glue:number, hem:number, overlap:number}} input
 */
function buildGeometry({ W, D, H, glue, hem, overlap, holeSpan, holeTop }) {
  const bottom = D / 2 + overlap;
  const paperW = glue + 2 * W + 2 * D;
  const paperH = hem + H + bottom;

  // 直向的分隔線，由左到右。
  const x = {
    left: 0,
    glue: glue,
    front: glue + W,
    side1: glue + W + D,
    back: glue + W + D + W,
    right: paperW,
  };
  // 橫向的分隔線，由上到下。
  const y = {
    top: 0,
    hem: hem,
    bottomFold: hem + H,
    base: hem + H + D / 2,   // 側面三角形的頂點落在這條線上
    end: paperH,
  };

  return {
    W, D, H, glue, hem, overlap, bottom, paperW, paperH, x, y,
    holeSpan, holeTop,
    gusset1: x.front + D / 2,
    gusset2: x.back + D / 2,
    frontCenter: x.glue + W / 2,
    backCenter: x.side1 + W / 2,
    volume: (W * D * H) / 1e6,   // 公升
  };
}

/* ================= 展開圖 ================= */

const SCREEN = {
  bg: "transparent",
  panelA: "rgba(255, 255, 255, 0.03)",
  panelB: "rgba(255, 255, 255, 0.07)",
  cut: "var(--text)",
  mountain: "var(--info)",
  valley: "var(--warning)",
  diagonal: "var(--success)",
  hole: "var(--critical)",
  text: "var(--text)",
  dim: "var(--text-muted)",
};

const PRINT = {
  bg: "#ffffff",
  panelA: "#ffffff",
  panelB: "#f4f4f4",
  cut: "#000000",
  mountain: "#555555",
  valley: "#999999",
  diagonal: "#555555",
  hole: "#000000",
  text: "#000000",
  dim: "#444444",
};

/**
 * 展開圖。單位就是公釐 —— 下載下來的 SVG 標了 mm，列印時是 1:1。
 * @param {object} geo
 * @param {{print?:boolean, showHoles?:boolean}} opts
 */
function buildNetSvg(geo, { print = false, showHoles = true } = {}) {
  const c = print ? PRINT : SCREEN;
  const { x, y, paperW, paperH } = geo;

  // 線寬與字級跟著紙張大小走，不然大袋子的標示會小到看不見。
  const sw = Math.max(0.25, paperW / 900);
  const fs = Math.max(4, paperW / 58);
  const pad = { l: fs * 5.2, t: fs * 5.4, r: fs * 1.6, b: fs * 4.6 };

  const svg = s("svg", {
    xmlns: SVG_NS,
    viewBox: `${-pad.l} ${-pad.t} ${paperW + pad.l + pad.r} ${paperH + pad.t + pad.b}`,
    ...(print
      ? { width: `${mm(paperW + pad.l + pad.r)}mm`, height: `${mm(paperH + pad.t + pad.b)}mm` }
      : {}),
    class: "bag-net",
    role: "img",
    "aria-label": `紙袋展開圖，紙張 ${mm(paperW)} × ${mm(paperH)} 公釐`,
  });

  if (print) {
    svg.appendChild(s("rect", {
      x: -pad.l, y: -pad.t, width: paperW + pad.l + pad.r, height: paperH + pad.t + pad.b,
      fill: c.bg,
    }));
  }

  const line = (x1, y1, x2, y2, stroke, dash) => s("line", {
    x1, y1, x2, y2, stroke, "stroke-width": sw * (dash ? 1 : 1.6),
    "stroke-dasharray": dash || null, "stroke-linecap": "round",
  });
  const label = (tx, ty, text, opts = {}) => s("text", {
    x: tx, y: ty, fill: opts.fill || c.text, "font-size": opts.size || fs,
    "font-family": "sans-serif", "font-weight": opts.weight || 400,
    "text-anchor": opts.anchor || "middle", "dominant-baseline": "middle",
    transform: opts.rotate ? `rotate(${opts.rotate} ${tx} ${ty})` : null,
  }, text);

  /* ---- 面的底色：相鄰的面深淺交錯，一眼看得出邊界在哪 ---- */
  const panels = [
    [x.left, x.glue, c.panelB],
    [x.glue, x.front, c.panelA],
    [x.front, x.side1, c.panelB],
    [x.side1, x.back, c.panelA],
    [x.back, x.right, c.panelB],
  ];
  for (const [x1, x2, fill] of panels) {
    svg.appendChild(s("rect", { x: x1, y: 0, width: x2 - x1, height: paperH, fill }));
  }

  /* ---- 裁切線 ---- */
  svg.appendChild(s("rect", {
    x: 0, y: 0, width: paperW, height: paperH,
    fill: "none", stroke: c.cut, "stroke-width": sw * 2,
  }));

  /* ---- 山折：四條直的分隔線 + 上緣 + 底部 ---- */
  const mountainDash = `${sw * 6} ${sw * 4}`;
  for (const px of [x.glue, x.front, x.side1, x.back]) {
    svg.appendChild(line(px, 0, px, paperH, c.mountain, mountainDash));
  }
  svg.appendChild(line(0, y.hem, paperW, y.hem, c.mountain, mountainDash));
  svg.appendChild(line(0, y.bottomFold, paperW, y.bottomFold, c.mountain, mountainDash));

  /* ---- 谷折：兩片側面的中線。只有這兩條要往反方向折。 ---- */
  const valleyDash = `${sw * 8} ${sw * 3} ${sw * 1.5} ${sw * 3}`;
  for (const px of [geo.gusset1, geo.gusset2]) {
    svg.appendChild(line(px, 0, px, paperH, c.valley, valleyDash));
  }

  /* ---- 底部：45° 斜折線 + 底面中線 ---- */
  // 每一個「袋角」的兩側各一條 45° 斜線。紙的右邊緣捲起來之後會貼到黏合線上，
  // 所以它跟 x.glue 是同一個角，兩邊都要有斜線，只是各自被紙邊切掉一半。
  const half = geo.D / 2;
  const diagDash = `${sw * 4} ${sw * 3}`;
  for (const px of [x.glue, x.front, x.side1, x.back, x.right]) {
    const left = Math.min(half, px);
    const right = Math.min(half, paperW - px);
    if (left > 0) svg.appendChild(line(px, y.bottomFold, px - left, y.bottomFold + left, c.diagonal, diagDash));
    if (right > 0) svg.appendChild(line(px, y.bottomFold, px + right, y.bottomFold + right, c.diagonal, diagDash));
  }
  // 底面中線：三角形的頂點都落在這裡。是對位用的參考線，不是折線。
  svg.appendChild(line(0, y.base, paperW, y.base, c.dim, `${sw * 1.5} ${sw * 3}`));

  /* ---- 提把孔 ---- */
  if (showHoles) {
    const holeR = Math.max(1.6, fs * 0.34);
    for (const center of [geo.frontCenter, geo.backCenter]) {
      for (const dx of [-geo.holeSpan / 2, geo.holeSpan / 2]) {
        // 袋身那一層是實線；上緣折邊上的是對稱位置，折起來會疊在一起。
        svg.appendChild(s("circle", {
          cx: center + dx, cy: y.hem + geo.holeTop, r: holeR,
          fill: "none", stroke: c.hole, "stroke-width": sw * 1.6,
        }));
        svg.appendChild(s("circle", {
          cx: center + dx, cy: y.hem - geo.holeTop, r: holeR,
          fill: "none", stroke: c.hole, "stroke-width": sw * 1.2,
          "stroke-dasharray": `${sw * 2} ${sw * 2}`,
        }));
      }
    }
  }

  /* ---- 面的名稱 ---- */
  const bodyMid = y.hem + geo.H / 2;
  const names = [
    [geo.frontCenter, "前", geo.W],
    [x.front + half, "側", geo.D],
    [geo.backCenter, "後", geo.W],
    [x.back + half, "側", geo.D],
  ];
  for (const [px, text, width] of names) {
    if (width < fs * 1.4) continue;
    svg.appendChild(label(px, bodyMid, text, { size: fs * 1.5, weight: 700, fill: c.dim }));
  }
  if (geo.glue >= fs * 0.9) {
    svg.appendChild(label(geo.glue / 2, bodyMid, "黏合邊", { size: fs * 0.9, fill: c.dim, rotate: -90 }));
  }

  /* ---- 尺寸標示 ---- */
  const arrow = (x1, y1, x2, y2) => {
    const g = s("g", { stroke: c.dim, "stroke-width": sw * 1.2, fill: "none" });
    g.appendChild(s("line", { x1, y1, x2, y2 }));
    const tick = fs * 0.32;
    const vertical = x1 === x2;
    for (const [px, py] of [[x1, y1], [x2, y2]]) {
      g.appendChild(vertical
        ? s("line", { x1: px - tick, y1: py, x2: px + tick, y2: py })
        : s("line", { x1: px, y1: py - tick, x2: px, y2: py + tick }));
    }
    return g;
  };

  // 窄的區段（黏合邊、上緣折邊）擠不下標示，就把數字挪高一階再拉一條引線回去。
  // 直接省略不畫是不行的 —— 那兩段的長度正是最容易忘記留的。
  const fits = (span, text) => span >= String(text).length * fs * 0.62;
  const leader = (x1, y1, x2, y2) => s("line", {
    x1, y1, x2, y2, stroke: c.dim, "stroke-width": sw, "stroke-dasharray": `${sw * 2} ${sw * 2}`,
  });

  // 上方：整張紙的寬，以及每一段的寬。
  const topOuter = -fs * 4.1;
  const topInner = -fs * 1.1;
  svg.appendChild(arrow(0, topOuter, paperW, topOuter));
  svg.appendChild(label(paperW / 2, topOuter - fs * 0.8, `紙寬 ${mm(paperW)}`, { size: fs * 0.95, weight: 700 }));
  const segments = [
    [x.left, x.glue, mm(geo.glue)],
    [x.glue, x.front, mm(geo.W)],
    [x.front, x.side1, mm(geo.D)],
    [x.side1, x.back, mm(geo.W)],
    [x.back, x.right, mm(geo.D)],
  ];
  for (const [x1, x2, text] of segments) {
    svg.appendChild(arrow(x1, topInner, x2, topInner));
    const mid = (x1 + x2) / 2;
    if (fits(x2 - x1, text)) {
      svg.appendChild(label(mid, topInner - fs * 0.8, text, { size: fs * 0.85, fill: c.dim }));
    } else {
      svg.appendChild(leader(mid, topInner - fs * 0.3, mid, topInner - fs * 2.4));
      svg.appendChild(label(mid, topInner - fs * 2.9, text, { size: fs * 0.85, fill: c.dim }));
    }
  }

  // 左方：整張紙的高，以及每一段的高。
  const leftOuter = -fs * 3.9;
  const leftInner = -fs * 1.1;
  svg.appendChild(arrow(leftOuter, 0, leftOuter, paperH));
  svg.appendChild(label(leftOuter - fs * 0.8, paperH / 2, `紙長 ${mm(paperH)}`, { size: fs * 0.95, weight: 700, rotate: -90 }));
  const rows = [
    [y.top, y.hem, `上緣 ${mm(geo.hem)}`],
    [y.hem, y.bottomFold, `袋高 ${mm(geo.H)}`],
    [y.bottomFold, y.end, `底部 ${mm(geo.bottom)}`],
  ];
  for (const [y1, y2, text] of rows) {
    svg.appendChild(arrow(leftInner, y1, leftInner, y2));
    const mid = (y1 + y2) / 2;
    if (fits(y2 - y1, text)) {
      svg.appendChild(label(leftInner - fs * 0.8, mid, text, { size: fs * 0.85, fill: c.dim, rotate: -90 }));
    } else {
      svg.appendChild(leader(leftInner - fs * 0.3, mid, leftInner - fs * 2.4, mid));
      svg.appendChild(label(leftInner - fs * 2.9, mid, text, { size: fs * 0.85, fill: c.dim, rotate: -90 }));
    }
  }

  // 下方：提把孔的間距。
  if (showHoles && geo.holeSpan >= fs * 2) {
    const hy = paperH + fs * 1.4;
    svg.appendChild(arrow(geo.frontCenter - geo.holeSpan / 2, hy, geo.frontCenter + geo.holeSpan / 2, hy));
    svg.appendChild(label(geo.frontCenter, hy + fs * 0.9,
      `孔距 ${mm(geo.holeSpan)}　離上緣 ${mm(geo.holeTop)}`, { size: fs * 0.85, fill: c.dim }));
  }

  return svg;
}

/** 圖例。用 DOM 而不是畫進 SVG，才能跟著版面換行。 */
function buildLegend() {
  const items = [
    ["cut", "裁切線"],
    ["mountain", "山折（往後折）"],
    ["valley", "谷折（往前折）"],
    ["diagonal", "底部斜折線（45°）"],
    ["guide", "底面中線（參考）"],
    ["hole", "提把打洞"],
  ];
  return el("div", { class: "bag-legend" },
    items.map(([kind, text]) => el("span", { class: `bag-legend-item is-${kind}` },
      el("span", { class: "bag-legend-mark", "aria-hidden": "true" }),
      text,
    )));
}

/* ================= 分解圖 ================= */
//
// 選分解圖而不是動畫：折紙的人手上拿著紙，需要六張一起看得到、
// 而且印得出來的圖，不是一個要一直按重播的動畫。

const STEP_VIEW = "0 0 120 96";

function stepFrame(children) {
  return s("svg", { xmlns: SVG_NS, viewBox: STEP_VIEW, class: "bag-step-svg", "aria-hidden": "true" }, children);
}

const ST = {
  paper: "var(--cffy-theme-surface-a20)",
  edge: "var(--text-muted)",
  fold: "var(--info)",
  valley: "var(--warning)",
  accent: "var(--success)",
  hole: "var(--critical)",
  text: "var(--text-muted)",
};

const stroke = (attrs) => ({ fill: "none", "stroke-width": 1.2, "stroke-linecap": "round", ...attrs });
const tinyText = (x, y, text, anchor = "middle") => s("text", {
  x, y, fill: ST.text, "font-size": 7, "font-family": "sans-serif", "text-anchor": anchor,
}, text);

/** 折疊方向的小箭頭。 */
function curveArrow(x1, y1, x2, y2, bend = 12) {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2 - bend;
  return s("g", {},
    s("path", stroke({ d: `M${x1},${y1} Q${mx},${my} ${x2},${y2}`, stroke: ST.accent, "stroke-dasharray": "3 2" })),
    s("path", { d: `M${x2},${y2} l-3.4,-1.2 l1,3.4 z`, fill: ST.accent }),
  );
}

function buildSteps(geo, showHoles) {
  const { x, paperW } = geo;
  // 把展開圖的比例壓進 100×56 的框裡，步驟圖的分段才跟上面那張對得起來。
  const scale = 100 / paperW;
  const px = (v) => 10 + v * scale;

  const steps = [
    {
      title: "裁一張長方形",
      desc: `${mm(geo.paperW)} × ${mm(geo.paperH)} 公釐。只有外框是要剪掉的線，其他都是折線。`,
      svg: stepFrame([
        s("rect", { x: 10, y: 16, width: 100, height: 56, fill: ST.paper, stroke: ST.edge, "stroke-width": 1.6 }),
        s("path", stroke({ d: "M10,10 L110,10", stroke: ST.edge, "stroke-dasharray": "2 2" })),
        tinyText(60, 8, "紙寬"),
        tinyText(60, 47, "整張都用得到，不用留白"),
      ]),
    },
    {
      title: "折出五個面",
      desc: "四條山折線把紙分成「黏合邊、前、側、後、側」，兩條谷折線在側面正中間。",
      svg: stepFrame([
        s("rect", { x: 10, y: 16, width: 100, height: 56, fill: ST.paper, stroke: ST.edge, "stroke-width": 1.6 }),
        [x.glue, x.front, x.side1, x.back].map((v) =>
          s("line", stroke({ x1: px(v), y1: 16, x2: px(v), y2: 72, stroke: ST.fold, "stroke-dasharray": "4 3" }))),
        [geo.gusset1, geo.gusset2].map((v) =>
          s("line", stroke({ x1: px(v), y1: 16, x2: px(v), y2: 72, stroke: ST.valley, "stroke-dasharray": "6 2 1 2" }))),
        tinyText(px(geo.gusset1), 82, "側面中線往內折"),
      ]),
    },
    {
      title: "捲成筒、黏起來",
      desc: "把黏合邊塗膠，繞一圈貼到另一端的內側，接縫盡量壓在袋子的角上。",
      svg: stepFrame([
        s("rect", { x: 22, y: 20, width: 76, height: 40, fill: ST.paper, stroke: ST.edge, "stroke-width": 1.6 }),
        s("rect", { x: 22, y: 20, width: 10, height: 40, fill: "var(--surface-selected)", stroke: ST.accent, "stroke-width": 1.2 }),
        curveArrow(27, 18, 95, 18, 14),
        // 底下附一張俯視圖：側面往內凹進去的樣子。
        s("path", stroke({
          d: "M30,74 L52,74 L56,80 L52,86 L30,86 L26,80 Z",
          stroke: ST.edge, fill: ST.paper, "stroke-width": 1.4,
        })),
        s("path", stroke({ d: "M52,74 L52,86 M30,74 L30,86", stroke: ST.fold, "stroke-dasharray": "3 2" })),
        tinyText(78, 78, "俯視：側面往內凹", "start"),
        tinyText(78, 87, "成為一個扁筒", "start"),
      ]),
    },
    {
      title: "折上緣",
      desc: `頂端 ${mm(geo.hem)} 公釐往內折一圈壓平。這一折讓袋口變兩層，提把才拉得住。`,
      svg: stepFrame([
        s("rect", { x: 26, y: 22, width: 68, height: 52, fill: ST.paper, stroke: ST.edge, "stroke-width": 1.6 }),
        s("rect", { x: 26, y: 22, width: 68, height: 12, fill: "var(--surface-selected)", stroke: "none" }),
        s("line", stroke({ x1: 26, y1: 34, x2: 94, y2: 34, stroke: ST.fold, "stroke-dasharray": "4 3" })),
        curveArrow(60, 20, 60, 32, 10),
        tinyText(60, 88, "往袋子內側折，不是外側"),
      ]),
    },
    {
      title: "收底部",
      desc: "把筒底撐開壓成長方形，兩側自然出現 45° 的三角形，再把前後兩片依序折下來黏住。",
      svg: stepFrame([
        // 底面攤平的俯視圖：中間是 W×D 的底，四邊是折下來的片。
        s("rect", { x: 38, y: 34, width: 44, height: 26, fill: ST.paper, stroke: ST.edge, "stroke-width": 1.4 }),
        s("path", stroke({ d: "M38,34 L25,21 L95,21 L82,34 Z", fill: ST.paper, stroke: ST.edge })),
        s("path", stroke({ d: "M38,60 L25,73 L95,73 L82,60 Z", fill: ST.paper, stroke: ST.edge })),
        s("path", stroke({ d: "M38,34 L25,21 M82,34 L95,21 M38,60 L25,73 M82,60 L95,73", stroke: ST.accent, "stroke-dasharray": "3 2" })),
        s("line", stroke({ x1: 38, y1: 47, x2: 82, y2: 47, stroke: ST.valley, "stroke-dasharray": "5 2 1 2" })),
        tinyText(60, 16, "①先折兩側三角"),
        tinyText(60, 82, "②③再折前後兩片，中間重疊處上膠"),
      ]),
    },
    {
      title: showHoles ? "打洞、穿提把" : "完成",
      desc: showHoles
        ? `袋口折好之後兩層一起打洞，孔距 ${mm(geo.holeSpan)}、離上緣 ${mm(geo.holeTop)} 公釐。紙繩從外面穿進去，內側打結或貼一小片紙壓住。`
        : "袋身完成。",
      svg: stepFrame([
        s("path", stroke({ d: "M30,30 L30,80 L82,80 L82,30 Z", fill: ST.paper, stroke: ST.edge, "stroke-width": 1.6 })),
        s("path", stroke({ d: "M82,30 L94,22 L94,72 L82,80", fill: "var(--cffy-theme-surface-a10)", stroke: ST.edge, "stroke-width": 1.4 })),
        s("path", stroke({ d: "M30,30 L42,22 L94,22", stroke: ST.edge, "stroke-width": 1.4 })),
        s("line", stroke({ x1: 30, y1: 36, x2: 82, y2: 36, stroke: ST.fold, "stroke-dasharray": "4 3" })),
        showHoles ? s("g", {},
          [44, 68].map((cx) => s("circle", { cx, cy: 34, r: 2, fill: "none", stroke: ST.hole, "stroke-width": 1.2 })),
          s("path", stroke({ d: "M44,34 Q56,16 68,34", stroke: ST.hole, "stroke-width": 1.6 })),
        ) : null,
        tinyText(60, 92, showHoles ? "提把裝在雙層的袋口上" : "袋身完成"),
      ]),
    },
  ];

  return el("ol", { class: "bag-steps" }, steps.map((step, i) => el("li", { class: "bag-step" },
    el("div", { class: "bag-step-figure" }, step.svg),
    el("div", { class: "bag-step-body" },
      el("div", { class: "bag-step-title" }, `${i + 1}. ${step.title}`),
      el("p", { class: "bag-step-desc" }, step.desc),
    ),
  )));
}

/* ================= 掛載 ================= */

const MODES = ["bag", "item", "paper"];

export function mount(host, { options = {} } = {}) {
  let mode = MODES.includes(options.mode) ? options.mode : "bag";
  let ratio = "0.4";
  let geo = null;

  /* ---- 輸入 ---- */
  const bagW = numberInput({ value: "240", min: "10", step: "1", onInput: update });
  const bagD = numberInput({ value: "100", min: "10", step: "1", onInput: update });
  const bagH = numberInput({ value: "300", min: "10", step: "1", onInput: update });

  const itemL = numberInput({ value: "200", min: "1", step: "1", onInput: update });
  const itemW = numberInput({ value: "80", min: "1", step: "1", onInput: update });
  const itemH = numberInput({ value: "250", min: "1", step: "1", onInput: update });
  const ease = numberInput({ value: "20", min: "0", step: "1", onInput: update });
  const headroom = numberInput({ value: "40", min: "0", step: "1", onInput: update });

  // 手動改了長寬就不再是某個標準尺寸，把下拉選單退回「自訂」。
  const onPaperInput = () => { presetSelect.value = ""; update(); };
  const paperWInput = numberInput({ value: "297", min: "20", step: "1", onInput: onPaperInput });
  const paperHInput = numberInput({ value: "210", min: "20", step: "1", onInput: onPaperInput });
  const presetSelect = select({
    options: [
      { value: "", label: "自訂尺寸" },
      ...PAPER_SIZES.map((size) => ({ value: size.label, label: `${size.label}　${size.w} × ${size.h}` })),
    ],
    value: "A4",
    onChange: () => {
      const size = PAPER_SIZES.find((item) => item.label === presetSelect.value);
      if (!size) return;
      // 帶入橫放。橫向要塞下整個袋子的一圈，幾乎都是那個方向先不夠用。
      paperWInput.value = String(size.h);
      paperHInput.value = String(size.w);
      update();
    },
  });
  const swapButton = button("轉 90°", {
    onClick: () => {
      const w = paperWInput.value;
      paperWInput.value = paperHInput.value;
      paperHInput.value = w;
      update();
    },
  });
  const ratioTabs = segmented(
    [
      { value: "0.25", label: "扁" },
      { value: "0.4", label: "標準" },
      { value: "0.6", label: "厚" },
      { value: "max", label: "最大容量" },
    ],
    { value: ratio, onChange: (value) => { ratio = value; update(); } },
  );

  const glue = numberInput({ value: "20", min: "5", step: "1", onInput: update });
  const hem = numberInput({ value: "30", min: "10", step: "1", onInput: update });
  const overlap = numberInput({ value: "15", min: "5", step: "1", onInput: update });
  const holeSpanInput = numberInput({ value: "", min: "10", step: "1", placeholder: "自動", onInput: update });
  const holeTop = numberInput({ value: "15", min: "3", step: "1", onInput: update });
  const holeToggle = el("input", { type: "checkbox", class: "tool-check", checked: "checked", oninput: update });

  const bagFields = row(
    field("袋寬 W（mm）", bagW, "正面的寬度"),
    field("袋深 D（mm）", bagD, "側面的厚度"),
    field("袋高 H（mm）", bagH, "完成後的高度"),
  );
  const itemFields = el("div", {},
    row(
      field("物品長（mm）", itemL),
      field("物品寬（mm）", itemW),
      field("物品高（mm）", itemH),
    ),
    row(
      field("寬鬆量（mm）", ease, "長寬各留這麼多空間"),
      field("袋口留高（mm）", headroom, "物品上方的空間"),
    ),
  );

  const paperFields = el("div", {},
    row(
      field("常見尺寸", presetSelect, "選了會帶入橫放的長短邊"),
      field("紙張寬（mm）", paperWInput, "繞著袋子一圈的方向"),
      field("紙張高（mm）", paperHInput),
      field("方向", swapButton),
    ),
    row(field("袋身比例", ratioTabs, "側面厚度相對於正面寬度。整張紙都會用掉，所以袋高不用選")),
  );

  const modeTabs = segmented(
    [
      { value: "bag", label: "我知道袋子尺寸" },
      { value: "item", label: "我知道物品尺寸" },
      { value: "paper", label: "我知道紙張尺寸" },
    ],
    {
      value: mode,
      onChange: (value) => {
        mode = value;
        applyMode();
        update();
      },
    },
  );

  function applyMode() {
    bagFields.hidden = mode !== "bag";
    itemFields.hidden = mode !== "item";
    paperFields.hidden = mode !== "paper";
    outLeftover.hidden = mode !== "paper";
  }

  /* ---- 輸出 ---- */
  const outPaper = outputRow("需要的紙張");
  const outStock = outputRow("可用的標準紙");
  const outBag = outputRow("成品尺寸");
  const outVolume = outputRow("容量");
  const outBottom = outputRow("底部折高");
  const outLeftover = outputRow("紙張餘料");
  const info = status();

  const netHost = el("div", { class: "bag-net-host" });
  const stepHost = el("div", {});

  const download = button("下載展開圖 SVG（1:1）", {
    iconName: "arrowRight",
    onClick: () => {
      if (!geo) return;
      const svg = buildNetSvg(geo, { print: true, showHoles: holeToggle.checked });
      const blob = new Blob([svg.outerHTML], { type: "image/svg+xml;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = el("a", {
        href: url,
        download: `紙袋展開圖-${mm(geo.W)}x${mm(geo.D)}x${mm(geo.H)}.svg`,
      });
      document.body.appendChild(a);
      a.click();
      a.remove();
      // 立刻釋放會讓部分瀏覽器來不及讀，等一拍再收。
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify.success("已下載，用瀏覽器或 Illustrator 開就是實際大小");
    },
  });

  /* ---- 計算 ---- */

  /**
   * 依目前的輸入方式算出袋子的三個尺寸。
   * @returns {{W:number, D:number, H:number, note?:string, fit?:object}}
   */
  function readBagSize(g, t, o) {
    if (mode === "bag") {
      return { W: Number(bagW.value), D: Number(bagD.value), H: Number(bagH.value) };
    }

    if (mode === "paper") {
      const pw = Number(paperWInput.value);
      const ph = Number(paperHInput.value);
      if (!Number.isFinite(pw) || !Number.isFinite(ph)) return { W: NaN, D: NaN, H: NaN };
      const fit = fitToPaper({ paperW: pw, paperH: ph, glue: g, hem: t, overlap: o, ratio });
      if (!fit) return { W: NaN, D: NaN, H: NaN, note: "這張紙太小，扣掉黏合邊與上下折邊之後不夠做成袋子。" };

      // 同一張紙轉 90° 常常差很多，算給使用者看，要不要轉他自己決定。
      const turned = fitToPaper({ paperW: ph, paperH: pw, glue: g, hem: t, overlap: o, ratio });
      const here = fit.W * fit.D * fit.H;
      const there = turned ? turned.W * turned.D * turned.H : 0;
      const note = there > here * 1.05
        ? `轉 90° 可以做到 ${(there / 1e6).toFixed(2)} 公升（多 ${Math.round((there / here - 1) * 100)}%）`
        : "";
      return { ...fit, fit, note };
    }

    const L = Number(itemL.value);
    const Wd = Number(itemW.value);
    const Ht = Number(itemH.value);
    const gap = Number(ease.value);
    const head = Number(headroom.value);
    if (![L, Wd, Ht, gap, head].every(Number.isFinite)) return { W: NaN, D: NaN, H: NaN };
    // 紙袋一律是「寬的那一面朝前」，所以長寬先分出大小再放進去。
    return {
      W: roundUp5(Math.max(L, Wd) + gap),
      D: roundUp5(Math.min(L, Wd) + gap),
      H: roundUp5(Ht + head),
      note: "",
      derived: true,
    };
  }

  function update() {
    const g = Number(glue.value);
    const t = Number(hem.value);
    const o = Number(overlap.value);
    const ht = Number(holeTop.value);
    const { W, D, H, derived, note, fit } = readBagSize(g, t, o);

    const numbers = [W, D, H, g, t, o, ht];
    if (!numbers.every((n) => Number.isFinite(n) && n > 0)) {
      geo = null;
      info.set(note || "每一欄都要填正數。", "error");
      for (const outRow of [outPaper, outStock, outBag, outVolume, outBottom, outLeftover]) outRow.set("");
      netHost.replaceChildren();
      stepHost.replaceChildren();
      download.disabled = true;
      return;
    }

    const spanRaw = Number(holeSpanInput.value);
    const holeSpan = Number.isFinite(spanRaw) && spanRaw > 0
      ? spanRaw
      : Math.min(Math.max(W / 2, 40), W - 30 > 0 ? W - 30 : W / 2);

    geo = buildGeometry({ W, D, H, glue: g, hem: t, overlap: o, holeSpan, holeTop: ht });
    download.disabled = false;

    outPaper.set(`${mm(geo.paperW)} × ${mm(geo.paperH)} mm`);
    outBag.set(`${mm(W)} × ${mm(D)} × ${mm(H)} mm（寬 × 深 × 高）`);
    outVolume.set(`${(geo.volume).toFixed(2)} 公升`);
    outBottom.set(`${mm(geo.bottom)} mm　＝ 袋深一半 ${mm(D / 2)} ＋ 重疊 ${mm(o)}`);

    const stock = suggestPaper(geo.paperW, geo.paperH);
    outStock.set(stock
      ? `${stock.label}（${stock.w} × ${stock.h}）${stock.orientation}`
      : "比全開紙還大，得自己拼接");

    outLeftover.set(fit
      ? (fit.leftoverW < 0.5 && fit.leftoverH < 0.5
        ? "剛好用完"
        : `寬剩 ${mm(fit.leftoverW)}、高剩 ${mm(fit.leftoverH)} mm`)
      : "");

    const warnings = [];
    if (D > W) warnings.push("袋深比袋寬大，折起來會像個方盒子而不是提袋");
    if (ht + 8 > t) warnings.push(`上緣折邊只有 ${mm(t)}，打洞位置離邊太近容易撕破`);
    if (holeSpan > W - 20) warnings.push("提把孔太靠近側邊");
    if (geo.paperW > 1091 || geo.paperH > 1091) warnings.push("超過一般全開紙的尺寸");
    if (mode === "paper" && H > W * 3) warnings.push("這張紙又窄又長，做出來會是細細高高的袋子");

    if (warnings.length || note) info.set([note, ...warnings].filter(Boolean).join("；"), "warn");
    else if (mode === "paper") info.set(`這張紙最大能做 ${mm(W)} × ${mm(D)} × ${mm(H)} mm，${geo.volume.toFixed(2)} 公升`, "ok");
    else if (derived) info.set(`已從物品尺寸推算出袋子：${mm(W)} × ${mm(D)} × ${mm(H)} mm`, "ok");
    else info.set(`共 ${mm(geo.paperW * geo.paperH / 100)} 平方公分的紙`, "ok");

    netHost.replaceChildren(buildNetSvg(geo, { showHoles: holeToggle.checked }));
    stepHost.replaceChildren(buildSteps(geo, holeToggle.checked));
  }

  /* ---- 版面 ---- */
  host.appendChild(panel(
    field("輸入方式", modeTabs),
    bagFields,
    itemFields,
    paperFields,

    subhead("紙張與折邊"),
    row(
      field("黏合邊（mm）", glue, "捲成筒之後要黏的那一片"),
      field("上緣折邊（mm）", hem, "袋口往內折的寬度"),
      field("底部重疊（mm）", overlap, "底部兩片互相蓋住的量"),
    ),
    row(
      field("提把孔距（mm）", holeSpanInput, "留空 = 自動取袋寬的一半"),
      field("孔離上緣（mm）", holeTop),
      field("提把孔", el("label", { class: "tool-flag" }, holeToggle, el("span", {}, "標出打洞位置"))),
    ),

    subhead("結果"),
    el("div", { class: "tool-outs" }, outPaper, outStock, outBag, outVolume, outBottom, outLeftover),
    info,

    subhead("展開圖"),
    netHost,
    buildLegend(),
    actions(download),
    note("圖面朝上時看到的是紙袋的外側。除了兩條側面中線是谷折，其餘折線都往後折。下載的 SVG 標了公釐單位，列印時選「實際大小／100%」就是 1:1。"),

    subhead("組裝步驟"),
    stepHost,
  ));

  applyMode();
  update();
  return null;
}
