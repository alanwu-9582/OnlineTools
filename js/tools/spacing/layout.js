// js/tools/spacing/layout.js — 等分的算法。這一層完全不碰 DOM。
//
// 「平均放 N 個」其實有三種不同的意思，算出來的位置差很多：
//
//   兩端留邊    ┌ ▓ ┬ ▓ ┬ ▓ ┐    間距 = (L − Nw)/(N+1)
//   兩端不留邊  ▓ ┬─┬ ▓ ┬─┬ ▓    間距 = (L − Nw)/(N−1)
//   平均分格    │▓ │ ▓ │ ▓ │     格寬 = L/N，物件在格子裡置中
//
// 大部分計算機只做其中一種，但使用者要的常常是另一種。

export const MODES = {
  around: {
    label: "兩端留邊",
    hint: "頭尾也留一樣的空隙。牆上掛畫、櫃子裡排東西。",
    gapCount: (n) => n + 1,
  },
  between: {
    label: "兩端不留邊",
    hint: "頭尾各一個貼齊邊緣。柵欄柱、書架立板。",
    gapCount: (n) => n - 1,
  },
  cells: {
    label: "平均分格",
    hint: "切成 N 等格，每個在自己格子裡置中。分區、等寬欄位。",
    gapCount: (n) => n,
  },
};

/**
 * 直線等分。
 *
 * @param {{length:number, count:number, width:number, mode:string, step:number}} input
 *   width 填 0 就是純粹標點，不佔寬度。step 是進位單位，0 代表保留小數。
 * @returns {{positions:number[], gap:number, cell:number, spans:number[],
 *            leftover:number, exact:boolean}|null}
 *   positions 是每個物件「左緣」離起點的距離（width=0 時就是點的位置）。
 */
export function linearLayout({ length, count, width = 0, mode = "around", step = 0 }) {
  const spec = MODES[mode];
  if (!spec) return null;
  if (!(length > 0) || !Number.isInteger(count) || count < 1) return null;
  if (width < 0 || width * count > length) return null;
  // 「兩端不留邊」至少要有兩個東西才擺得出來，一個的話沒有「兩端」可言。
  if (mode === "between" && count < 2) return null;

  const cell = length / count;
  const gaps = spec.gapCount(count);
  const gap = gaps > 0 ? (length - width * count) / gaps : 0;

  let positions;
  if (mode === "cells") {
    positions = Array.from({ length: count }, (_, i) => cell * i + (cell - width) / 2);
  } else {
    const first = mode === "around" ? gap : 0;
    positions = Array.from({ length: count }, (_, i) => first + i * (width + gap));
  }

  if (!step) {
    return { positions, gap, cell, spans: gapSpans(positions, width, length), leftover: 0, exact: true };
  }
  return snap({ positions, width, length, step, gap, cell });
}

/** 相鄰兩個物件之間實際空出來的距離，用來驗算。 */
function gapSpans(positions, width, length) {
  const spans = [];
  let prev = 0;
  for (const p of positions) {
    spans.push(p - prev);
    prev = p + width;
  }
  spans.push(length - prev);
  return spans;
}

/**
 * 取整到 step 的倍數。
 *
 * 直接把每個位置各自四捨五入會讓間距忽大忽小（誤差散在中間），
 * 所以改成先把「每一段間距」取整、餘數平均分給前面幾段，再累加回位置 ——
 * 這樣間距最多只差一個 step，而且總長仍然精確等於 L。
 */
function snap({ positions, width, length, step, gap, cell }) {
  const raw = gapSpans(positions, width, length);
  const units = raw.map((v) => v / step);
  const floors = units.map((v) => Math.floor(v));
  const totalUnits = Math.round((length - width * positions.length) / step);
  let remainder = totalUnits - floors.reduce((a, b) => a + b, 0);

  // 餘數優先給小數部分最大的那幾段，取整後最接近原本的比例。
  const order = units
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  const spans = floors.slice();
  for (const { i } of order) {
    if (remainder <= 0) break;
    spans[i] += 1;
    remainder -= 1;
  }

  const snapped = [];
  let cursor = 0;
  for (let i = 0; i < positions.length; i += 1) {
    cursor += spans[i] * step;
    snapped.push(cursor);
    cursor += width;
  }
  // 自由空間不是 step 的整數倍時，會有一小段怎麼分都分不掉的餘料。
  const free = length - width * positions.length;
  return {
    positions: snapped,
    gap,
    cell,
    spans: spans.map((v) => v * step),
    leftover: free - totalUnits * step,
    exact: raw.every((v) => Math.abs(v / step - Math.round(v / step)) < 1e-9),
  };
}

/**
 * 圓周等分。
 *
 * 弦長是重點：家裡通常沒有量角器，但用尺量「相鄰兩點的直線距離」很容易。
 *
 * @returns {{angle:number, chord:number, arc:number,
 *            points:Array<{x:number, y:number, deg:number}>}}
 */
export function circleLayout({ diameter, count, startAngle = 0 }) {
  if (!(diameter > 0) || !Number.isInteger(count) || count < 2) return null;
  const r = diameter / 2;
  const angle = 360 / count;
  const points = Array.from({ length: count }, (_, i) => {
    const deg = startAngle + angle * i;
    const rad = (deg * Math.PI) / 180;
    return { deg, x: r * Math.sin(rad), y: r * Math.cos(rad) };
  });
  return {
    angle,
    // 弦長 = 2R·sin(θ/2)
    chord: 2 * r * Math.sin(Math.PI / count),
    arc: (Math.PI * diameter) / count,
    points,
  };
}
