// js/tools/paper-bag/fold-model.js — 組裝動畫的幾何：時間軸、鏡頭、
// 每一格每一個面在 3D 的位置。這一層也完全不碰 DOM，純算座標。

import { mm } from "./geometry.js";

/* ================= 組裝動畫 ================= */
//
// 為什麼不是 GIF：這張圖是照使用者輸入的尺寸算出來的，預錄好的 GIF 沒辦法
// 反映他自己那個袋子。要在瀏覽器裡即時產生 GIF，又得自己寫調色盤量化與 LZW
// 編碼，換來的還是一張解析度固定、不跟著主題換色、也不能拖著看的圖。
// 所以改成把「折到幾分」當成一個參數，每一格重新投影一次。

export const clamp01 = (v) => Math.min(1, Math.max(0, v));
const spanAt = (t, a, b) => clamp01((t - a) / (b - a));
export const easeInOut = (p) => (p < 0.5 ? 2 * p * p : 1 - ((-2 * p + 2) ** 2) / 2);
export const lerp = (a, b, k) => a + (b - a) * k;

/** 每一章的起點與說明。desc 拿得到 geo，數字才跟著使用者的袋子走。 */
export const STAGES = [
  {
    at: 0,
    title: "裁下紙張、壓出折線",
    desc: (g) => `${mm(g.paperW)} × ${mm(g.paperH)} 毫米。只有最外框要剪，裡面的線全部只壓不剪。`,
  },
  {
    at: 0.14,
    title: "折上緣",
    desc: (g) => `袋口 ${mm(g.hem)} 毫米往袋子內側折一圈壓平，提把受力的地方就變成兩層。`,
  },
  {
    at: 0.32,
    title: "捲成筒、黏合",
    desc: (g) => `沿四條直折線捲起來，${mm(g.glue)} 毫米的黏合邊塗膠貼進另一端的內側。`,
  },
  {
    at: 0.64,
    title: "收底部",
    desc: (g) => `先折兩側 —— 它們會自己收成 45° 的三角形；再折前後兩片，各伸進 ${mm(g.bottom)} 毫米，中間 ${mm(g.overlap * 2)} 毫米的重疊處上膠。`,
  },
  {
    at: 0.88,
    title: "打洞、穿提把",
    desc: (g) => `袋口折好之後兩層一起打洞，孔距 ${mm(g.holeSpan)}、離上緣 ${mm(g.holeTop)} 毫米。繩子從外面穿進去，內側打結。`,
  },
];

/** 目前這一格各個動作折到哪裡。後面三個刻意錯開，看起來才有先後順序。 */
export function foldState(t) {
  return {
    fold: easeInOut(spanAt(t, 0.32, 0.64)),
    hem: easeInOut(spanAt(t, 0.14, 0.32)),
    side: easeInOut(spanAt(t, 0.64, 0.76)),
    front: easeInOut(spanAt(t, 0.71, 0.83)),
    back: easeInOut(spanAt(t, 0.76, 0.88)),
    handle: easeInOut(spanAt(t, 0.88, 1)),
  };
}

/* ---------- 3D 小工具 ---------- */

const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul3 = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit3 = (a) => {
  const len = Math.hypot(a[0], a[1], a[2]);
  return len > 1e-9 ? mul3(a, 1 / len) : [0, 0, 0];
};

/** 繞著通過 origin、方向為 axis（單位向量）的直線，把 p 轉 angle 弧度。 */
function rotateAbout(p, origin, axis, angle) {
  const r = sub3(p, origin);
  const par = mul3(axis, dot3(r, axis));
  const perp = sub3(r, par);
  const bi = cross3(axis, perp);
  return add3(origin, add3(par, add3(mul3(perp, Math.cos(angle)), mul3(bi, Math.sin(angle)))));
}

/* ---------- 鏡頭 ---------- */

/**
 * 轉盤式鏡頭：先繞 z 軸轉 yaw，再仰俯 pitch，最後正投影。
 *
 * pitch 為正是從上往下看，為負就是繞到底下往上看 —— 收底部那一段全靠它，
 * 不然折進去的那幾片會整個被袋身擋住，只看得到袋子在抖。
 */
function makeCamera(yaw, pitch) {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  return {
    project: ([x, y, z]) => [x * cy - y * sy, -((x * sy + y * cy) * sp + z * cp)],
    depth: ([x, y, z]) => (x * sy + y * cy) * cp - z * sp,
  };
}

/**
 * 鏡頭的走位。整段都保持同一種投影 —— 之前攤平時全部落在同一個平面上，
 * 看起來像張沒有厚度的平面圖，折起來才突然有立體感，很容易誤會成換了畫法。
 * 現在從頭到尾都是斜著看的。
 */
const CAMERA_KEYS = [
  { t: 0, yaw: -9, pitch: 10 },
  { t: 0.14, yaw: -13, pitch: 12 },
  { t: 0.32, yaw: -13, pitch: 12 },
  { t: 0.64, yaw: -36, pitch: 18 },
  { t: 0.7, yaw: -44, pitch: -38 },   // 轉到袋子底下
  { t: 0.86, yaw: -44, pitch: -33 },
  { t: 0.93, yaw: -33, pitch: 15 },   // 轉回來看成品
  { t: 1, yaw: -28, pitch: 17 },
];

export function cameraAt(t) {
  let a = CAMERA_KEYS[0];
  let b = CAMERA_KEYS[CAMERA_KEYS.length - 1];
  for (let i = 0; i < CAMERA_KEYS.length - 1; i += 1) {
    if (t >= CAMERA_KEYS[i].t && t <= CAMERA_KEYS[i + 1].t) {
      a = CAMERA_KEYS[i];
      b = CAMERA_KEYS[i + 1];
      break;
    }
  }
  const k = b.t > a.t ? easeInOut(clamp01((t - a.t) / (b.t - a.t))) : 0;
  const rad = Math.PI / 180;
  return makeCamera(lerp(a.yaw, b.yaw, k) * rad, lerp(a.pitch, b.pitch, k) * rad);
}

/* ---------- 面 ---------- */

// 顏色跟著「這是哪一面」走，不跟著角度走。純用受光程度上色的話，同一面
// 在鏡頭轉動時會忽明忽暗，反而分不出哪片是哪片。明暗另外用 brightness 疊。
const PANEL_TONE = {
  front: "var(--cffy-theme-surface-a40)",
  back: "var(--cffy-theme-surface-a20)",
  side: "var(--cffy-theme-surface-a30)",
  glue: "color-mix(in srgb, var(--success) 30%, var(--cffy-theme-surface-a30))",
};

export const PANEL_NAME = { front: "前", back: "後", side: "側", glue: "黏" };

const LIGHT = unit3([-0.35, -0.8, 0.55]);

/** 取絕對值：看到內側時也要有亮度，不然翻過去就是一片全黑。 */
export function shadeOf(pts) {
  const n = unit3(cross3(sub3(pts[1], pts[0]), sub3(pts[2], pts[0])));
  return 0.6 + 0.4 * Math.abs(dot3(n, LIGHT));
}

/**
 * 五個面在俯視平面上的走向。
 *
 * 第 i 段的方向刻意取 (i − 1) × 轉角，而不是 i × 轉角：這樣「前」那一面
 * 永遠朝著鏡頭（方向恆為 0），攤平時的左右排列也跟展開圖一模一樣
 * —— 黏合邊、前、側、後、側。
 */
function walkPanels(geo, fold) {
  const turn = (Math.PI / 2) * fold;
  const parts = [
    { kind: "glue", len: geo.glue },
    { kind: "front", len: geo.W },
    { kind: "side", len: geo.D },
    { kind: "back", len: geo.W },
    { kind: "side", len: geo.D },
  ];
  let px = 0;
  let py = 0;
  return parts.map((part, i) => {
    const dir = (i - 1) * turn;
    const ax = px;
    const ay = py;
    px += Math.cos(dir) * part.len;
    py += Math.sin(dir) * part.len;
    return {
      ...part, dir, ax, ay, bx: px, by: py,
      // 往袋子內側的法向量。走的方向是逆時針，內側就在左手邊。
      nx: Math.cos(dir + Math.PI / 2),
      ny: Math.sin(dir + Math.PI / 2),
    };
  });
}

/** 這一格所有的面（3D，還沒投影）。 */
export function buildFaces(geo, st) {
  const panels = walkPanels(geo, st.fold);
  const faces = [];
  const creases = [];
  const zTop = geo.H;
  const hemAngle = Math.PI * st.hem;
  const half = geo.D / 2;

  for (const p of panels) {
    const A = [p.ax, p.ay, 0];
    const B = [p.bx, p.by, 0];
    const n = [p.nx, p.ny, 0];
    const tone = PANEL_TONE[p.kind];
    const eA = unit3(sub3(B, A));

    // 袋身
    faces.push({ tone, kind: p.kind, part: "body", pts: [
      A, B, [p.bx, p.by, zTop], [p.ax, p.ay, zTop],
    ] });

    // 側面正中間那條谷折線是真的折痕，畫出來才看得出這是紙袋不是紙盒。
    if (p.kind === "side") {
      const mid = add3(A, mul3(eA, half));
      creases.push([mid, [mid[0], mid[1], zTop]]);
    }

    // 上緣折邊：繞著 z = 袋高 那條線轉。0 是直直往上、180° 是貼回袋身內側。
    const hz = zTop + geo.hem * Math.cos(hemAngle);
    const ho = geo.hem * Math.sin(hemAngle);
    faces.push({ tone, kind: p.kind, part: "hem", pts: [
      [p.ax, p.ay, zTop], [p.bx, p.by, zTop],
      [p.bx + p.nx * ho, p.by + p.ny * ho, hz], [p.ax + p.nx * ho, p.ay + p.ny * ho, hz],
    ] });

    // 底部：繞著 z = 0 那條線往內轉 90°。
    const prog = p.kind === "front" ? st.front : p.kind === "back" ? st.back : st.side;
    const alpha = (Math.PI / 2) * prog;
    const eV = add3(mul3(n, Math.sin(alpha)), [0, 0, -Math.cos(alpha)]);
    const local = (a, v) => add3(A, add3(mul3(eA, a), mul3(eV, v)));

    if (p.kind !== "side") {
      faces.push({ tone, kind: p.kind, part: "flap", pts: [
        local(0, 0), local(p.len, 0), local(p.len, geo.bottom), local(0, geo.bottom),
      ] });
      continue;
    }

    // 側面的底部不是一整片折進去 —— 它沿著那兩條 45° 斜線裂成三塊：
    // 中間的三角形轉進底面，兩邊的角再沿著斜線往回折 180°，疊到三角形上。
    // 紙是連續的，只是折起來，所以三塊在攤平時剛好拼回原本的長方形。
    const apex = local(half, half);
    faces.push({ tone, kind: p.kind, part: "gusset", pts: [local(0, 0), local(geo.D, 0), apex] });

    const beta = Math.PI * prog;
    for (const [corner, sign] of [[0, 1], [geo.D, -1]]) {
      const c0 = local(corner, 0);
      const axis = unit3(sub3(apex, c0));
      const quad = [c0, apex, local(half, geo.bottom), local(corner, geo.bottom)];
      faces.push({
        tone, kind: p.kind, part: "ear",
        pts: quad.map((pt) => rotateAbout(pt, c0, axis, beta * sign)),
      });
    }
  }

  return { panels, faces, creases };
}

/** 投影後的有向面積。負的代表這一面正對鏡頭（面的頂點是逆時針繞的）。 */
export function signedArea(pts) {
  let sum = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

export const centroid2 = (pts) => [
  pts.reduce((s, p) => s + p[0], 0) / pts.length,
  pts.reduce((s, p) => s + p[1], 0) / pts.length,
];

/** 某一面上的兩個提把孔在 3D 的位置。 */
export function holePoints(geo, panel) {
  const along = [0.5 - geo.holeSpan / (2 * geo.W), 0.5 + geo.holeSpan / (2 * geo.W)];
  return along.map((k) => [
    lerp(panel.ax, panel.bx, k),
    lerp(panel.ay, panel.by, k),
    geo.H - geo.holeTop,
  ]);
}
