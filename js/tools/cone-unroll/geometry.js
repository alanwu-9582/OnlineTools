// js/tools/cone-unroll/geometry.js — 圓錐／圓台的展開。這一層不碰 DOM。
//
// 把圓台沿著母線剪開攤平，得到的是一段圓環扇形: 
//
//   斜邊長   s     = √((R−r)² + h²)
//   外弧半徑 L_big = s·R/(R−r)      （從虛擬頂點量到下緣）
//   內弧半徑 L_sml = L_big − s
//   扇形角度 θ     = 360°·(R−r)/s
//
// θ 的推導: 外弧長必須等於下口圓周，所以 θ·L_big = 2πR，
// 代入 L_big 之後 R 就消掉了，剩下 2π(R−r)/s。這也是最好用的驗算式。

/** 超過這個半徑就沒有圓規畫得出來了，得改用圓柱近似。 */
const MAX_RADIUS = 3000;

/**
 * @param {{topDia:number, bottomDia:number, height:number}} input
 *   topDia 填 0 就是正圓錐。上下對調也可以，會自動處理。
 * @returns {object|null}
 */
export function unroll({ topDia, bottomDia, height }) {
  if (!(bottomDia > 0) || !(height > 0) || !(topDia >= 0)) return null;

  // 大的當下口。倒過來放的圓台跟正放的是同一張展開圖。
  const R = Math.max(topDia, bottomDia) / 2;
  const r = Math.min(topDia, bottomDia) / 2;
  const h = height;
  const slant = Math.hypot(R - r, h);

  const common = {
    R, r, h, slant,
    // 圓台體積 = πh(R² + Rr + r²)/3
    volume: (Math.PI * h * (R * R + R * r + r * r)) / 3 / 1e6,
    bottomCircle: R,
    topCircle: r,
  };

  // 上下一樣大就是圓柱，沒有頂點，展開圖是長方形。
  if (Math.abs(R - r) < 1e-9) {
    return { ...common, kind: "cylinder", width: 2 * Math.PI * R, height: h };
  }

  const outer = (slant * R) / (R - r);
  const inner = outer - slant;
  const angle = (360 * (R - r)) / slant;
  const rad = (angle * Math.PI) / 180;

  return {
    ...common,
    kind: "sector",
    outer,
    inner,
    angle,
    // 弦長: 家裡沒有量角器，但用尺量外弧兩端的直線距離很容易。
    chord: 2 * outer * Math.sin(rad / 2),
    innerChord: 2 * inner * Math.sin(rad / 2),
    // 扇形太大就畫不出來；此時直接當圓柱裁，並算出這樣做的誤差。
    tooLarge: outer > MAX_RADIUS,
    cylinderFallback: {
      width: Math.PI * (R + r),      // 用上下口的平均周長
      height: slant,                  // 高度要用斜邊長，不是垂直高
      error: Math.abs(R - r),
    },
    maxRadius: MAX_RADIUS,
    ...boundingBox(outer, inner, angle),
  };
}

/**
 * 扇形實際佔掉的紙張大小。
 *
 * 不能直接用 2×外弧半徑 —— 角度小於 180° 時扇形只佔一部分，
 * 那樣會高估很多。要看外弧掃過的範圍有沒有跨過 0°／90°／180°／270°
 * 這幾個極值方向。
 */
function boundingBox(outer, inner, angleDeg) {
  const rad = (d) => (d * Math.PI) / 180;
  // 讓扇形對稱地跨在正上方，畫出來比較好看也比較省紙。
  const start = -angleDeg / 2;
  const end = angleDeg / 2;

  const xs = [];
  const ys = [];
  for (const radius of [inner, outer]) {
    for (const deg of [start, end]) {
      xs.push(radius * Math.sin(rad(deg)));
      ys.push(radius * Math.cos(rad(deg)));
    }
  }
  // 掃過的極值方向也要算進去。
  for (const deg of [-270, -180, -90, 0, 90, 180, 270]) {
    if (deg < start || deg > end) continue;
    xs.push(outer * Math.sin(rad(deg)));
    ys.push(outer * Math.cos(rad(deg)));
  }
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    paperW: maxX - minX,
    paperH: maxY - minY,
    box: { minX, maxX, minY, maxY, start, end },
  };
}
