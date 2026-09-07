// js/tools/rail-map/geo.js — 投影與折線運算。
//
// 這裡不碰 DOM: build script（Node）與瀏覽器裡的「線上更新」共用同一份程式, 
// 兩邊算出來的路網才會一模一樣。

/** 地球半徑, 公尺。 */
const R = 6371008.8;
/** 台灣南北的中間緯度。等距圓柱投影就以這條線為準。 */
export const LAT0 = 23.7;

const rad = (deg) => (deg * Math.PI) / 180;

/**
 * 經緯度 → 平面公尺（x 東、y 北）。
 *
 * 用等距圓柱投影而不是 Web Mercator: 台灣只跨 3.5 個緯度, 這樣的長度誤差
 * 在 0.5% 以內, 而且它不會像 Mercator 那樣把北部放大 —— 路網圖要的是
 * 「哪兩站比較近」看起來合理, 不是能拿去導航。
 */
export function project(lon, lat) {
  return [rad(lon) * R * Math.cos(rad(LAT0)), rad(lat) * R];
}

export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** 折線總長。 */
export function polylineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i]);
  return total;
}

/**
 * 把一堆零碎線段接成盡量長的鏈。
 *
 * OSM 的鐵路 way 會在每個號誌、橋樑、行政區界被切開 —— 縱貫線一條就有 533 段。
 * 關聯裡的順序大致可信但方向不一定, 所以兩端都要試著往外長, 接得到就翻轉方向接上。
 *
 * @param {Array<Array<[number,number]>>} segments 已投影的線段
 * @param {number} eps 端點多近算同一點（公尺）
 * @returns {Array<Array<[number,number]>>} 由長到短
 */
export function stitch(segments, eps = 25) {
  const parts = segments.filter((s) => s.length > 1);
  const used = new Array(parts.length).fill(false);
  const chains = [];

  for (let i = 0; i < parts.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    let chain = parts[i].slice();

    // 先往一端長到底, 翻過來再長另一端。
    for (let pass = 0; pass < 2; pass++) {
      for (let grew = true; grew;) {
        grew = false;
        const tail = chain[chain.length - 1];
        for (let k = 0; k < parts.length; k++) {
          if (used[k]) continue;
          const seg = parts[k];
          if (dist(tail, seg[0]) <= eps) {
            chain = chain.concat(seg.slice(1));
          } else if (dist(tail, seg[seg.length - 1]) <= eps) {
            chain = chain.concat(seg.slice(0, -1).reverse());
          } else continue;
          used[k] = true;
          grew = true;
          break;
        }
      }
      chain.reverse();
    }
    chains.push(chain);
  }
  return chains.sort((a, b) => polylineLength(b) - polylineLength(a));
}

/**
 * Douglas–Peucker 折線簡化。
 * 原始資料一條線動輒四千個點, 畫成地圖看不出差別, 卻會讓 SVG 大到卡頓。
 */
export function simplify(points, tolerance) {
  if (points.length < 3) return points.slice();

  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];

  while (stack.length) {
    const [lo, hi] = stack.pop();
    const a = points[lo];
    const b = points[hi];
    const vx = b[0] - a[0];
    const vy = b[1] - a[1];
    const len2 = vx * vx + vy * vy;

    let worst = -1;
    let worstAt = -1;
    for (let i = lo + 1; i < hi; i++) {
      const p = points[i];
      let t = len2 ? ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
      if (d > worst) { worst = d; worstAt = i; }
    }
    if (worst > tolerance) {
      keep[worstAt] = 1;
      stack.push([lo, worstAt], [worstAt, hi]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * 點到折線的最近距離, 以及那個位置的里程。
 * 里程用來把站排序 —— 沿著線量到哪裡, 就是第幾站。
 */
export function snap(point, points) {
  let best = Infinity;
  let chainage = 0;
  let run = 0;

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const vx = b[0] - a[0];
    const vy = b[1] - a[1];
    const len2 = vx * vx + vy * vy;
    let t = len2 ? ((point[0] - a[0]) * vx + (point[1] - a[1]) * vy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = a[0] + t * vx;
    const py = a[1] + t * vy;
    const d = Math.hypot(point[0] - px, point[1] - py);
    if (d < best) { best = d; chainage = run + Math.hypot(px - a[0], py - a[1]); }
    run += Math.sqrt(len2);
  }
  return { distance: best, chainage };
}

/** 一堆點的外框 [minX, minY, maxX, maxY]。 */
export function bounds(points) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of points) {
    if (x < box[0]) box[0] = x;
    if (y < box[1]) box[1] = y;
    if (x > box[2]) box[2] = x;
    if (y > box[3]) box[3] = y;
  }
  return box;
}
