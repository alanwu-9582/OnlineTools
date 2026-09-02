// js/tools/paper-bag/net.js — 展開圖: 裁切線、折線、尺寸標示、提把孔位。

import { s, SVG_NS } from "../svg.js";
import { mm } from "./geometry.js";
import { el } from "../kit.js";

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
 * 展開圖。單位就是毫米 —— 下載下來的 SVG 標了 mm，列印時是 1:1。
 * @param {object} geo
 * @param {{print?:boolean, showHoles?:boolean}} opts
 */
export function buildNetSvg(geo, { print = false, showHoles = true } = {}) {
  const c = print ? PRINT : SCREEN;
  const { x, y, paperW, paperH } = geo;

  // 線寬與字級跟著紙張大小走，不然大袋子的標示會小到看不見。
  const sw = Math.max(0.25, paperW / 900);
  const fs = Math.max(4, paperW / 58);
  // 上／左各有三層標示（分段、累計刻度、總長），右／下放提把孔的座標。
  const pad = { l: fs * 11.2, t: fs * 11.2, r: showHoles ? fs * 5.2 : fs * 1.6, b: fs * 6.6 };

  const svg = s("svg", {
    xmlns: SVG_NS,
    viewBox: `${-pad.l} ${-pad.t} ${paperW + pad.l + pad.r} ${paperH + pad.t + pad.b}`,
    ...(print
      ? { width: `${mm(paperW + pad.l + pad.r)}mm`, height: `${mm(paperH + pad.t + pad.b)}mm` }
      : {}),
    class: "bag-net",
    role: "img",
    "aria-label": `紙袋展開圖，紙張 ${mm(paperW)} × ${mm(paperH)} 毫米`,
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

  /* ---- 面的底色: 相鄰的面深淺交錯，一眼看得出邊界在哪 ---- */
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

  /* ---- 山折: 四條直的分隔線 + 上緣 + 底部 ---- */
  const mountainDash = `${sw * 6} ${sw * 4}`;
  for (const px of [x.glue, x.front, x.side1, x.back]) {
    svg.appendChild(line(px, 0, px, paperH, c.mountain, mountainDash));
  }
  svg.appendChild(line(0, y.hem, paperW, y.hem, c.mountain, mountainDash));
  svg.appendChild(line(0, y.bottomFold, paperW, y.bottomFold, c.mountain, mountainDash));

  /* ---- 谷折: 兩片側面的中線。只有這兩條要往反方向折。 ---- */
  const valleyDash = `${sw * 8} ${sw * 3} ${sw * 1.5} ${sw * 3}`;
  for (const px of [geo.gusset1, geo.gusset2]) {
    svg.appendChild(line(px, 0, px, paperH, c.valley, valleyDash));
  }

  /* ---- 底部: 45° 斜折線 + 底面中線 ---- */
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
  // 底面中線: 三角形的頂點都落在這裡。是對位用的參考線，不是折線。
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
    svg.appendChild(label(px, bodyMid - fs * 0.75, text, { size: fs * 1.5, weight: 700, fill: c.dim }));
    // 每個面自己的長寬。折起來之後這一面就是這麼大，比只寫「前」有用。
    const size = `${mm(width)} × ${mm(geo.H)}`;
    if (width >= size.length * fs * 0.55) {
      svg.appendChild(label(px, bodyMid + fs * 1.05, size, { size: fs * 0.78, fill: c.dim }));
    }
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
  /**
   * 粗估一段文字有多寬。中日韓字元大約佔一個字身，數字與英文只有六成左右 ——
   * 一律用字數乘同一個係數會把「上緣 30」這種中英混排低估掉，標示就會疊在一起。
   */
  const textWidth = (text, size) => {
    let units = 0;
    for (const ch of String(text)) units += /[⺀-鿿＀-￯ -〿]/.test(ch) ? 1 : 0.6;
    return units * size;
  };
  const fits = (span, text) => span >= textWidth(text, fs * 0.85);
  const leader = (x1, y1, x2, y2) => s("line", {
    x1, y1, x2, y2, stroke: c.dim, "stroke-width": sw, "stroke-dasharray": `${sw * 2} ${sw * 2}`,
  });

  /**
   * 一條「從邊緣量起」的累計刻度。
   * 真的在紙上畫線時，是拿尺壓著同一個邊一路量到底，不是一段一段接力量 ——
   * 接力量每一段都會累積誤差。所以這排數字才是照著做的人真正會用到的。
   *
   * @param {number[]} positions  沿著軸的位置（毫米）
   * @param {{axis:"x"|"y", offset:number, side:1|-1, caption?:string}} cfg
   */
  const tickScale = (positions, { axis, offset, side = -1, caption }) => {
    const g = s("g", {});
    const horizontal = axis === "x";
    const span = horizontal ? paperW : paperH;
    const tick = fs * 0.4;

    g.appendChild(horizontal
      ? s("line", { x1: 0, y1: offset, x2: span, y2: offset, stroke: c.dim, "stroke-width": sw })
      : s("line", { x1: offset, y1: 0, x2: offset, y2: span, stroke: c.dim, "stroke-width": sw }));

    // 數字擠在一起時錯開到第二排，再拉一條引線指回自己的刻度。
    const ends = [-Infinity, -Infinity];
    for (const pos of positions) {
      const text = mm(pos);
      const halfWidth = textWidth(text, fs * 0.8) / 2;
      const tier = pos - halfWidth < ends[0] + fs * 0.4 ? 1 : 0;
      ends[tier] = pos + halfWidth;
      const away = fs * (0.9 + tier * 1.15) * side;

      if (horizontal) {
        g.appendChild(s("line", {
          x1: pos, y1: offset - tick, x2: pos, y2: offset + tick,
          stroke: c.dim, "stroke-width": sw * 1.5,
        }));
        if (tier) g.appendChild(leader(pos, offset + tick * side, pos, offset + away - fs * 0.45 * side));
        g.appendChild(label(pos, offset + away, text, { size: fs * 0.8, fill: c.dim }));
      } else {
        g.appendChild(s("line", {
          x1: offset - tick, y1: pos, x2: offset + tick, y2: pos,
          stroke: c.dim, "stroke-width": sw * 1.5,
        }));
        if (tier) g.appendChild(leader(offset + tick * side, pos, offset + away - fs * 0.45 * side, pos));
        g.appendChild(label(offset + away, pos, text, { size: fs * 0.8, fill: c.dim, rotate: -90 }));
      }
    }

    if (caption) {
      // 直向刻度的說明也轉成直排。橫排的話它會往左伸進分段標示那一欄，
      // 大尺寸時就會跟「上緣 30」之類的標籤疊在一起。
      g.appendChild(horizontal
        ? label(-fs * 0.8, offset, caption, { size: fs * 0.72, fill: c.dim, anchor: "end" })
        : label(offset, -fs * 2.0, caption, { size: fs * 0.72, fill: c.dim, rotate: -90 }));
    }
    return g;
  };

  /** 一整排「起點 → 終點」的分段標示，太窄就把數字挪開再拉引線。 */
  const segmentBand = (parts, { axis, offset }) => {
    const horizontal = axis === "x";
    for (const [a, b, text] of parts) {
      svg.appendChild(horizontal ? arrow(a, offset, b, offset) : arrow(offset, a, offset, b));
      const mid = (a + b) / 2;
      const roomy = fits(b - a, text);
      const away = fs * (roomy ? 0.8 : 2.9);
      if (!roomy) {
        svg.appendChild(horizontal
          ? leader(mid, offset - fs * 0.3, mid, offset - fs * 2.4)
          : leader(offset - fs * 0.3, mid, offset - fs * 2.4, mid));
      }
      svg.appendChild(horizontal
        ? label(mid, offset - away, text, { size: fs * 0.85, fill: c.dim })
        : label(offset - away, mid, text, { size: fs * 0.85, fill: c.dim, rotate: -90 }));
    }
  };

  /* 上方三層（由內而外）: 各段寬度 → 自左邊量的累計刻度 → 整張紙的寬。 */
  segmentBand([
    [x.left, x.glue, mm(geo.glue)],
    [x.glue, x.front, mm(geo.W)],
    [x.front, x.side1, mm(geo.D)],
    [x.side1, x.back, mm(geo.W)],
    [x.back, x.right, mm(geo.D)],
  ], { axis: "x", offset: -fs * 1.1 });

  // 每一條直向折線的位置，側面中線也算 —— 不然使用者得自己去算 D/2 落在哪。
  svg.appendChild(tickScale(
    [x.glue, x.front, geo.gusset1, x.side1, x.back, geo.gusset2, x.right],
    { axis: "x", offset: -fs * 6.2, caption: "自左邊量" },
  ));

  svg.appendChild(arrow(0, -fs * 9.5, paperW, -fs * 9.5));
  svg.appendChild(label(paperW / 2, -fs * 10.3, `紙寬 ${mm(paperW)}`, { size: fs * 0.95, weight: 700 }));

  /* 左方三層: 各段高度 → 自上緣量的累計刻度 → 整張紙的長。 */
  segmentBand([
    [y.top, y.hem, `上緣 ${mm(geo.hem)}`],
    [y.hem, y.bottomFold, `袋高 ${mm(geo.H)}`],
    // 底部拆成兩段: 斜折線到得了的深度，跟前後兩片互相蓋住的量。
    [y.bottomFold, y.base, `斜折 ${mm(geo.D / 2)}`],
    [y.base, y.end, `重疊 ${mm(geo.overlap)}`],
  ], { axis: "y", offset: -fs * 1.1 });

  svg.appendChild(tickScale(
    [y.hem, y.bottomFold, y.base, y.end],
    { axis: "y", offset: -fs * 6.2, caption: "自上緣量" },
  ));

  svg.appendChild(arrow(-fs * 9.5, 0, -fs * 9.5, paperH));
  svg.appendChild(label(-fs * 10.3, paperH / 2, `紙長 ${mm(paperH)}`, { size: fs * 0.95, weight: 700, rotate: -90 }));

  /* 提把孔: 橫向位置放下面，縱向位置放右邊，兩個一起就能定出八個孔。 */
  if (showHoles) {
    const holeXs = [geo.frontCenter, geo.backCenter]
      .flatMap((center) => [center - geo.holeSpan / 2, center + geo.holeSpan / 2])
      .sort((a, b) => a - b);
    svg.appendChild(tickScale(holeXs, {
      axis: "x", offset: paperH + fs * 1.7, side: 1, caption: "提把孔",
    }));

    if (geo.holeSpan >= fs * 2) {
      const spanY = paperH + fs * 5.0;
      svg.appendChild(arrow(geo.frontCenter - geo.holeSpan / 2, spanY, geo.frontCenter + geo.holeSpan / 2, spanY));
      svg.appendChild(label(geo.frontCenter, spanY + fs * 0.85, `孔距 ${mm(geo.holeSpan)}`, { size: fs * 0.85, fill: c.dim }));
    }

    // 兩排孔對稱地落在上緣折線的兩側，折起來剛好疊在一起。
    svg.appendChild(tickScale([y.hem - geo.holeTop, y.hem + geo.holeTop], {
      axis: "y", offset: paperW + fs * 1.7, side: 1, caption: "提把孔",
    }));
  }

  return svg;
}

/** 圖例。用 DOM 而不是畫進 SVG，才能跟著版面換行。 */
export function buildLegend() {
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
