// js/tools/paper-bag/geometry.js — 尺寸怎麼來的。這一層完全不碰 DOM。
//
//   橫向  [黏合邊 G][前 W][側 D][後 W][側 D]        紙寬 = G + 2W + 2D
//   縱向  [上緣折邊 T][袋身 H][底部 B]              紙高 = T + H + B
//
// 底部高度 B = D/2 + 重疊。理由：底面是一個 W×D 的長方形，前後兩片各要
// 蓋過中線才黏得住 —— 剛好蓋到中線是 D/2，再多出來的就是重疊量。

/** 尺寸標示只留一位小數；紙張裁到 0.1 mm 已經超過手工的極限。 */
export const mm = (n) => String(Math.round(n * 10) / 10);

/** 無條件進位到 5 的倍數 —— 手裁紙照 5 mm 的刻度比較好對。 */
export const roundUp5 = (n) => Math.ceil(n / 5) * 5;


/* ================= 常見紙張尺寸 ================= */

export const PAPER_SIZES = [
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
export function suggestPaper(width, height) {
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
export function fitToPaper({ paperW, paperH, glue, hem, overlap, ratio }) {
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
export function buildGeometry({ W, D, H, glue, hem, overlap, holeSpan, holeTop }) {
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
