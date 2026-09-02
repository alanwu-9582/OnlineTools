// js/tools/ig-template/import-pptx.js — 把 .pptx 轉成這裡的模板格式。

const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";

/** 1 英吋 = 914400 EMU，畫面 96 px/英吋 → 每 px 9525 EMU。 */
const EMU_PER_PX = 9525;
/** 字級是 1/100 pt，1 pt = 96/72 px。 */
const PT_TO_PX = 96 / 72;
/** 旋轉是 1/60000 度。 */
const ROT_PER_DEG = 60000;
/**
 * <a:ln> 沒寫 w 的時候用的外框粗細（pt）。
 * DrawingML 的預設是 0（髮絲線），但 PowerPoint 的文字外框實際上是這個粗細，
 * 而且真的畫成 0 的話在 1080 的畫布上等於看不見。
 */
const DEFAULT_OUTLINE_PT = 1;

/** bodyPr 沒寫時的文字內縮（OOXML 的預設值），單位 EMU。 */
const DEFAULT_INSET = { l: 91440, r: 91440, t: 45720, b: 45720 };

/** IG 的原生寬度。版面等比縮放到這個寬度，輸出解析度才夠。 */
const TARGET_WIDTH = 1080;
/** IG 貼文／限動的標準高度（寬 1080 時）。差一兩個 px 就對齊到這些值。 */
const IG_HEIGHTS = [566, 1080, 1350, 1920];

/** 圖片面積佔畫布這個比例以上的，當成「要換的照片」；以下的當成素材（logo、圖示）。 */
const PHOTO_AREA_RATIO = 0.15;

const MEDIA_MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  svg: "image/svg+xml", webp: "image/webp", bmp: "image/bmp", tiff: "image/tiff",
  emf: null, wmf: null,          // 向量中繼檔，瀏覽器畫不出來
};

import { MAX_FONT_SIZE } from "./schema.js";
import { toHex } from "./color.js";

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* ---------------- XML 小工具 ---------------- */

/** 直接子元素，依 local name 找。 */
function kids(node, ns, name) {
  const out = [];
  for (const child of node?.children || []) {
    if (child.localName === name && child.namespaceURI === ns) out.push(child);
  }
  return out;
}
const kid = (node, ns, name) => kids(node, ns, name)[0] || null;

/** 後代元素（第一個）。用在 rPr / solidFill 這種藏得比較深的東西。 */
function descend(node, ns, name) {
  return node?.getElementsByTagNameNS(ns, name)[0] || null;
}

const attr = (node, name, fallback = null) => (node?.hasAttribute(name) ? node.getAttribute(name) : fallback);

/**
 * OOXML 的布林屬性可以寫 "1"／"0"／"true"／"false" —— 而且不同產生器各寫一種。
 * Canva 用的是 "true"，只比對 "1" 的話粗體、斜體、翻轉全都會被漏掉。
 */
const flag = (node, name) => {
  const v = attr(node, name);
  return v === "1" || v === "true";
};

function parseXml(bytes, where) {
  const text = new TextDecoder("utf-8").decode(bytes);
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const err = doc.getElementsByTagName("parsererror")[0];
  if (err) throw new Error(`${where} 不是有效的 XML: ${err.textContent.slice(0, 120)}`);
  return doc;
}

/** 解 .rels: Id → 目標路徑（已經化成 zip 內的絕對路徑）。 */
function parseRels(bytes, basePath) {
  const map = new Map();
  if (!bytes) return map;
  const doc = parseXml(bytes, basePath);
  for (const rel of doc.getElementsByTagNameNS(PKG_REL_NS, "Relationship")) {
    const id = attr(rel, "Id");
    const target = attr(rel, "Target");
    if (!id || !target) continue;
    if (attr(rel, "TargetMode") === "External") { map.set(id, { external: target }); continue; }
    map.set(id, { path: resolvePath(basePath, target) });
  }
  return map;
}

/** 把 rels 裡的相對路徑（"../media/image1.png"）解成 zip 內的路徑。 */
function resolvePath(basePath, target) {
  if (target.startsWith("/")) return target.slice(1);
  const parts = basePath.split("/").slice(0, -2);   // 去掉 _rels/xxx.rels 兩層
  for (const seg of target.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

/* ---------------- 顏色 ---------------- */



/**
 * 解一個顏色節點（srgbClr / schemeClr / prstClr）。
 * 只處理 alpha、lumMod、lumOff 這幾個實務上真的會遇到的調整。
 */
function readColor(holder, theme, warnings, where) {
  if (!holder) return null;
  const srgb = kid(holder, A_NS, "srgbClr");
  const scheme = kid(holder, A_NS, "schemeClr");
  const node = srgb || scheme;
  if (!node) return null;

  let rgb;
  if (srgb) {
    rgb = attr(srgb, "val", "000000");
  } else {
    const key = attr(scheme, "val", "");
    rgb = theme.get(key) || theme.get({ tx1: "dk1", tx2: "dk2", bg1: "lt1", bg2: "lt2" }[key]) || null;
    if (!rgb) {
      warnings.push(`${where}: 認不出佈景主題色「${key}」，改用黑色。`);
      rgb = "000000";
    }
  }

  let r = parseInt(rgb.slice(0, 2), 16);
  let g = parseInt(rgb.slice(2, 4), 16);
  let b = parseInt(rgb.slice(4, 6), 16);

  // 亮度調整。Canva 的漸層與淡色版很常帶這個。
  const lumMod = kid(node, A_NS, "lumMod");
  const lumOff = kid(node, A_NS, "lumOff");
  if (lumMod) {
    const f = num(attr(lumMod, "val", 100000)) / 100000;
    r *= f; g *= f; b *= f;
  }
  if (lumOff) {
    const f = num(attr(lumOff, "val", 0)) / 100000;
    r += 255 * f; g += 255 * f; b += 255 * f;
  }

  const alphaNode = kid(node, A_NS, "alpha");
  const alpha = alphaNode ? num(attr(alphaNode, "val", 100000)) / 100000 : 1;
  // 模板裡的顏色統一是 hex，帶透明度就是 8 位。
  return toHex({ r, g, b, a: alpha });
}

/** 佈景主題的色表: schemeClr 的名字 → 六位十六進位。 */
function readTheme(files, warnings) {
  const map = new Map();
  const entry = [...files.keys()].find((n) => /^ppt\/theme\/theme\d+\.xml$/.test(n));
  if (!entry) return map;
  try {
    const doc = parseXml(files.get(entry), entry);
    const scheme = doc.getElementsByTagNameNS(A_NS, "clrScheme")[0];
    for (const child of scheme?.children || []) {
      const srgb = kid(child, A_NS, "srgbClr");
      const sys = kid(child, A_NS, "sysClr");
      const val = srgb ? attr(srgb, "val") : attr(sys, "lastClr");
      if (val) map.set(child.localName, val);
    }
  } catch (err) {
    warnings.push(`讀不到佈景主題配色（${err.message}），schemeClr 的顏色會用黑色代替。`);
  }
  return map;
}

/* ---------------- 幾何 ---------------- */

/** 讀 a:xfrm。回傳的是「投影片座標的 EMU」，還沒套群組轉換。 */
function readXfrm(node) {
  if (!node) return null;
  const off = kid(node, A_NS, "off");
  const ext = kid(node, A_NS, "ext");
  if (!off || !ext) return null;
  return {
    x: num(attr(off, "x")), y: num(attr(off, "y")),
    cx: num(attr(ext, "cx")), cy: num(attr(ext, "cy")),
    rot: num(attr(node, "rot", 0)) / ROT_PER_DEG,
    flipH: flag(node, "flipH"),
    flipV: flag(node, "flipV"),
  };
}

/**
 * 群組的座標轉換: 子座標 → 父座標。
 *
 * 除了 chOff / chExt 的縮放，還要帶上群組自己的旋轉與旋轉中心 ——
 * Canva 很愛用「把一個橫的漸層整組轉 90 度」來做直式的壓暗，
 * 忽略旋轉的話那一層會躺著、而且位置整個跑掉。
 */
function groupTransform(xfrm, node) {
  const chOff = kid(node, A_NS, "chOff");
  const chExt = kid(node, A_NS, "chExt");
  if (!chOff || !chExt) return null;
  const cw = num(attr(chExt, "cx"), 0);
  const ch = num(attr(chExt, "cy"), 0);
  if (!cw || !ch) return null;
  return {
    ox: xfrm.x, oy: xfrm.y,
    cx: num(attr(chOff, "x")), cy: num(attr(chOff, "y")),
    sx: xfrm.cx / cw, sy: xfrm.cy / ch,
    rot: xfrm.rot,
    // 群組是繞著自己（未旋轉的）方框中心轉。
    gcx: xfrm.x + xfrm.cx / 2,
    gcy: xfrm.y + xfrm.cy / 2,
  };
}

/**
 * 把一連串群組轉換套到一個方框上。
 *
 * 群組旋轉的處理: 方框的寬高不變，只把中心點繞群組中心轉過去，再把角度
 * 累加到圖層自己的 rotate 上 —— 我們的 rotate 就是繞圖層自己的中心轉，
 * 所以這樣拆剛好等價，不需要格式支援任意變換矩陣。
 *
 * @returns {{x:number, y:number, cx:number, cy:number, rot:number}}
 */
function applyTransforms(box, stack) {
  let { x, y, cx, cy } = box;
  let rot = 0;
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const t = stack[i];
    x = t.ox + (x - t.cx) * t.sx;
    y = t.oy + (y - t.cy) * t.sy;
    cx *= t.sx;
    cy *= t.sy;
    if (t.rot) {
      const rad = (t.rot * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const px = x + cx / 2 - t.gcx;
      const py = y + cy / 2 - t.gcy;
      x = t.gcx + px * cos - py * sin - cx / 2;
      y = t.gcy + px * sin + py * cos - cy / 2;
      rot += t.rot;
    }
  }
  return { x, y, cx, cy, rot };
}

/** prstGeom → 圓角半徑（px）。認不出來的形狀當成直角矩形。 */
function readRadius(spPr, w, h, warnings, where) {
  const geom = kid(spPr, A_NS, "prstGeom");
  if (!geom) {
    // custGeom 是自訂路徑。矩形的那種（Canva 大部分的框都是）直接當矩形；
    // 有曲線的畫不出來，要講清楚而不是默默變成方框。
    const custom = kid(spPr, A_NS, "custGeom");
    if (custom && /cubicBezTo|quadBezTo|arcTo/.test(custom.innerHTML || "")) {
      warnings.push(`${where}: 原稿是自訂的曲線形狀，這裡只能畫成矩形。`);
    }
    return 0;
  }
  const prst = attr(geom, "prst", "rect");
  if (prst === "rect") return 0;
  const shortest = Math.min(w, h);
  if (prst === "ellipse" || prst === "circle") return shortest / 2;
  if (prst === "roundRect" || prst === "round1Rect" || prst === "round2SameRect") {
    const gd = descend(geom, A_NS, "gd");
    const fmla = attr(gd, "fmla", "val 16667");
    const adj = num(fmla.replace(/^val\s+/, ""), 16667) / 100000;
    return clamp(adj, 0, 0.5) * shortest;
  }
  warnings.push(`${where}: 形狀「${prst}」畫不出來，改用矩形。`);
  return 0;
}

/* ---------------- 文字 ---------------- */

/** 一段文字（a:p）→ 純文字。a:br 是段落內的手動換行。 */
function paragraphText(p) {
  let out = "";
  for (const child of p.children) {
    if (child.namespaceURI !== A_NS) continue;
    if (child.localName === "r" || child.localName === "fld") {
      out += kid(child, A_NS, "t")?.textContent ?? "";
    } else if (child.localName === "br") {
      out += "\n";
    }
  }
  return out;
}

/**
 * 讀一個文字框。
 *
 * 我們的格式是「一層一種樣式」，所以只取第一個 run 的字型設定；
 * 一層裡混了多種樣式的時候會講清楚它被統一了。
 */
function readText(txBody, theme, warnings, where) {
  const paras = kids(txBody, A_NS, "p");
  const lines = paras.map(paragraphText);
  const text = lines.join("\n");
  if (!text.trim()) return null;

  const bodyPr = kid(txBody, A_NS, "bodyPr");
  const firstRun = descend(txBody, A_NS, "rPr");
  const firstPPr = kid(paras[0], A_NS, "pPr");

  // 同一個文字框裡出現不同字級或不同顏色 → 只能取一種。
  const sizes = new Set();
  const colors = new Set();
  for (const rPr of txBody.getElementsByTagNameNS(A_NS, "rPr")) {
    if (rPr.hasAttribute("sz")) sizes.add(rPr.getAttribute("sz"));
    const fill = kid(rPr, A_NS, "solidFill");
    if (fill) colors.add(readColor(fill, theme, [], where));
  }
  if (sizes.size > 1 || colors.size > 1) {
    warnings.push(`${where}: 這一層裡有多種字級或顏色，已統一成第一段的設定。`);
  }
  const family = attr(descend(firstRun || txBody, A_NS, "latin"), "typeface", null);
  // 字型名稱本身就寫著 Italic 的時候（Canva 會內嵌「Roboto Bold Italics」
  // 這種獨立的字重檔），斜體是烤在字型檔裡的，沒有東西掉，不用報。
  if (flag(firstRun, "i") && !/italic|oblique/i.test(family || "")) {
    warnings.push(`${where}: 斜體做不出來，已改成正體。`);
  }
  const vert = attr(bodyPr, "vert");
  if (vert && vert !== "horz") {
    warnings.push(`${where}: 直排文字做不出來，已改成橫排（可以用圖層的 rotate 自己轉）。`);
  }

  // 文字外框（PowerPoint 的「文字外框」／Canva 的 text outline）。
  // 藏在 rPr 底下的 <a:ln> 裡，跟形狀的框線是同一組結構。
  let stroke = null;
  const ln = kid(firstRun, A_NS, "ln");
  if (ln && !kid(ln, A_NS, "noFill")) {
    const solid = kid(ln, A_NS, "solidFill");
    const grad = kid(ln, A_NS, "gradFill");
    let color = readColor(solid, theme, warnings, where);
    if (!color && grad) {
      color = readColor(kid(kid(grad, A_NS, "gsLst"), A_NS, "gs"), theme, warnings, where);
      warnings.push(`${where}: 文字外框是漸層的，只能取第一個顏色。`);
    }
    if (color) {
      const w = num(attr(ln, "w", 0));
      stroke = {
        color,
        widthPt: w ? w / EMU_PER_PX / PT_TO_PX : DEFAULT_OUTLINE_PT,
        // .pptx 沒寫粗細的時候記一下，最後統一告訴使用者那是估的。
        assumedWidth: !w,
      };
    }
  }

  const sz = num(attr(firstRun, "sz", 1800));
  // normAutofit 表示原稿已經把字縮小塞進框裡，照它的比例走才會一樣大。
  const autofit = kid(bodyPr, A_NS, "normAutofit");
  const fontScale = autofit ? num(attr(autofit, "fontScale", 100000)) / 100000 : 1;

  const lnSpcNode = descend(firstPPr || txBody, A_NS, "lnSpc");
  const lnPct = lnSpcNode ? kid(lnSpcNode, A_NS, "spcPct") : null;
  // spcPts 是「固定行高幾點」而不是倍數。Canva 全部用這一種，
  // 只認 spcPct 的話行距會全部變成預設值，多行的標題就對不上。
  const lnPts = lnSpcNode ? kid(lnSpcNode, A_NS, "spcPts") : null;
  const spc = num(attr(firstRun, "spc", 0));

  return {
    text,
    stroke,
    size: (sz / 100) * PT_TO_PX * fontScale,
    weight: flag(firstRun, "b") ? 700 : 400,
    family,
    // 沒有明寫填色就是繼承而來的內文色（tx1）。寫死黑色在深色佈景上會全錯。
    color: readColor(kid(firstRun, A_NS, "solidFill"), theme, warnings, where)
      || (theme.get("dk1") ? `#${theme.get("dk1").toLowerCase()}` : "#000000"),
    align: { l: "left", ctr: "center", r: "right", just: "left", dist: "left" }[attr(firstPPr, "algn", "l")] || "left",
    valign: { t: "top", ctr: "middle", b: "bottom" }[attr(bodyPr, "anchor", "t")] || "top",
    lineHeight: lnPct ? clamp(num(attr(lnPct, "val", 100000)) / 100000, 0.8, 3)
      : lnPts ? clamp(num(attr(lnPts, "val", 0)) / Math.max(1, sz), 0.8, 3)
        : 1.2,
    letterSpacing: (spc / 100) * PT_TO_PX,
    inset: {
      l: num(attr(bodyPr, "lIns", DEFAULT_INSET.l)),
      r: num(attr(bodyPr, "rIns", DEFAULT_INSET.r)),
      t: num(attr(bodyPr, "tIns", DEFAULT_INSET.t)),
      b: num(attr(bodyPr, "bIns", DEFAULT_INSET.b)),
    },
  };
}

/* ---------------- 圖片裁切 ---------------- */

/**
 * 把 OOXML 的圖片裁切／擺放換算成我們的 fit + scale + dx/dy。
 *
 * 兩種寫法都要吃，而且方向剛好相反: 
 *
 *   a:srcRect            「只顯示原圖的這一塊」。正值 = 從那一邊切掉。
 *   a:stretch/a:fillRect 「把圖畫在方框的這個範圍」。負值 = 圖溢出方框外
 *                        （＝放大裁切）。Canva 用的是這一種。
 *
 * 兩者可以同時出現，所以統一成一組公式: 先由 srcRect 決定可見的原圖比例，
 * 再由 fillRect 決定那一塊被畫到方框的哪個範圍。
 *
 * 我們的 fitPhoto 只做等比，所以寬高兩個方向推出來的縮放不一致時會回報 ——
 * 那是原稿把圖拉變形了，畫不出來。
 */
function cropToOffset({ src, fill }, rect, imgW, imgH, warnings, where) {
  const s1 = src || { l: 0, r: 0, t: 0, b: 0 };
  const f2 = fill || { l: 0, r: 0, t: 0, b: 0 };
  const identity = !s1.l && !s1.r && !s1.t && !s1.b && !f2.l && !f2.r && !f2.t && !f2.b;
  if (identity) return null;

  const fw = 1 - s1.l - s1.r;          // 可見的原圖寬度比例
  const fh = 1 - s1.t - s1.b;
  if (fw <= 0 || fh <= 0) {
    warnings.push(`${where}: 裁切把整張圖都切掉了，已忽略裁切。`);
    return null;
  }
  const gw = 1 - f2.l - f2.r;          // 那一塊在方框裡佔的寬度比例
  const gh = 1 - f2.t - f2.b;
  if (gw <= 0 || gh <= 0) {
    warnings.push(`${where}: 圖片的擺放範圍是空的，已忽略。`);
    return null;
  }

  // 整張圖顯示出來會有多大（以方框為單位再換成 px）。
  const W = (gw / fw) * rect.w;
  const H = (gh / fh) * rect.h;
  const sByW = W / imgW;
  const sByH = H / imgH;
  const mismatch = Math.abs(sByW - sByH) / Math.max(sByW, sByH);
  if (mismatch > 0.02) {
    warnings.push(`${where}: 原稿把圖片做了非等比的裁切或拉伸，這裡只能等比顯示，構圖會有一點差異。`);
  }
  const s = Math.max(sByW, sByH);      // 取大的，寧可裁掉也不要露出底色
  const shown = { w: imgW * s, h: imgH * s };

  const base = Math.max(rect.w / imgW, rect.h / imgH);   // fit: cover 的基準
  return {
    scale: clamp(s / base, 0.1, 10),
    // 整張圖的中心相對於方框中心的位移。
    dx: ((f2.l - f2.r) / 2) * rect.w - ((s1.l - s1.r) / 2) * shown.w,
    dy: ((f2.t - f2.b) / 2) * rect.h - ((s1.t - s1.b) / 2) * shown.h,
  };
}

/** 讀 a:srcRect / a:fillRect 的四邊比例。 */
function readEdges(node) {
  if (!node) return null;
  const f = (name) => num(attr(node, name, 0)) / 100000;
  const edges = { l: f("l"), r: f("r"), t: f("t"), b: f("b") };
  return (edges.l || edges.r || edges.t || edges.b) ? edges : null;
}

/**
 * 量一張圖的原始尺寸。
 *
 * 裁切換算與「方框比例跟圖片不合」的判斷都需要這個。用 blob URL 而不是
 * data URI: 同源、不用 base64、也不會讓 canvas 被 taint。
 */
function measureImage(bytes, type) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const img = new Image();
    const done = (value) => { URL.revokeObjectURL(url); resolve(value); };
    img.onload = () => done({ w: img.naturalWidth || img.width, h: img.naturalHeight || img.height });
    img.onerror = () => done(null);
    img.src = url;
  });
}

/* ---------------- 內嵌字型 ---------------- */

/** EOT 標頭裡 MagicNumber 的位置與值。 */
const EOT_MAGIC_OFFSET = 34;
const EOT_MAGIC = 0x504c;
const EOT_COMPRESSED = 0x00000004;
const EOT_XOR = 0x10000000;

/**
 * 從 .fntdata 取出真正的字型檔。
 *
 * .fntdata 是 EOT（Embedded OpenType）容器: 前面是一段標頭，字型本體就是
 * 最後 FontDataSize 個位元組。旗標沒有設壓縮／混淆的話，那一段直接就是
 * 可以餵給 FontFace 的 TTF 或 OTF。
 */
function unwrapFntdata(bytes, where, warnings) {
  if (bytes.length < 84) { warnings.push(`${where}: 字型檔太小，已略過。`); return null; }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eotSize = view.getUint32(0, true);
  const dataSize = view.getUint32(4, true);
  const flags = view.getUint32(12, true);
  if (view.getUint16(EOT_MAGIC_OFFSET, true) !== EOT_MAGIC) {
    // 不是 EOT。有些工具會直接放原始的 TTF，那就照原樣用。
    return sniffFont(bytes) ? bytes : null;
  }
  if (flags & EOT_COMPRESSED) {
    warnings.push(`${where}: 字型是壓縮過的（MicroType Express），這個工具解不開。`
      + "這種壓縮是 PowerPoint 重新存檔時加上的 —— 直接用 Canva 匯出的原始 .pptx 就不會有這個問題，"
      + "或是把字型檔自己放進標準模板的 fonts/ 裡。");
    return null;
  }
  const start = Math.max(0, Math.min(eotSize, bytes.length) - dataSize);
  let data = bytes.subarray(start, start + dataSize);
  if (flags & EOT_XOR) {
    // 混淆只是整段 XOR 0x50。
    const copy = new Uint8Array(data);
    for (let i = 0; i < copy.length; i += 1) copy[i] ^= 0x50;
    data = copy;
  }
  return sniffFont(data) ? data : null;
}

/** 認一下這段位元組是不是字型，順便回報副檔名。 */
function sniffFont(bytes) {
  if (bytes.length < 4) return null;
  const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (tag === "OTTO") return "otf";
  if (tag === "wOFF") return "woff";
  if (tag === "wOF2") return "woff2";
  if (tag === "true" || tag === "ttcf") return "ttf";
  if (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0) return "ttf";
  return null;
}

/** 檔名安全的字型名稱。 */
const fontFileName = (family) => String(family).replace(/[\/:*?"<>|]+/g, "-").trim();

/**
 * 讀 p:embeddedFontLst，把用得到的字型抓出來。
 *
 * Canva 匯出的 .pptx **會**內嵌字型（saveSubsetFonts="1"），所以排版可以
 * 跟原稿一模一樣。不過它是「子集化」的 —— 只帶了原稿真的用到的字，
 * 之後打新的字可能會掉回備援字型。
 *
 * @param {Set<string>} used  版面上真的用到的字型名稱
 * @returns {Map<string, {bytes:Uint8Array, type:string}>} fonts/xxx.ttf → 內容
 */
function readEmbeddedFonts(files, used, warnings) {
  const out = new Map();
  const presPath = "ppt/presentation.xml";
  if (!files.has(presPath)) return out;

  let doc;
  try {
    doc = parseXml(files.get(presPath), presPath);
  } catch {
    return out;
  }
  const list = doc.getElementsByTagNameNS(P_NS, "embeddedFont");
  if (!list.length) return out;

  const rels = parseRels(files.get("ppt/_rels/presentation.xml.rels"), "ppt/_rels/presentation.xml.rels");
  const subset = flag(doc.getElementsByTagNameNS(P_NS, "presentation")[0], "saveSubsetFonts");
  let subsetted = false;

  for (const entry of list) {
    const family = attr(kid(entry, P_NS, "font"), "typeface", "");
    if (!family) continue;
    // 只帶版面上用得到的，不然三套字型就多幾百 KB。
    if (used.size && !used.has(family)) continue;

    // 一個字型可能有 regular / bold / italic / boldItalic 幾個檔，
    // 我們的格式一層只有一個 family，所以取 regular（沒有就取第一個）。
    const pick = kid(entry, P_NS, "regular")
      || kid(entry, P_NS, "bold") || kid(entry, P_NS, "italic") || kid(entry, P_NS, "boldItalic");
    const relId = pick?.getAttributeNS(R_NS, "id");
    const target = relId ? rels.get(relId)?.path : null;
    if (!target || !files.has(target)) {
      warnings.push(`字型「${family}」在 .pptx 裡標了內嵌，但找不到檔案，會用備援字型。`);
      continue;
    }
    const data = unwrapFntdata(files.get(target), `字型「${family}」`, warnings);
    if (!data) continue;
    const ext = sniffFont(data) || "ttf";
    out.set(`fonts/${fontFileName(family)}.${ext}`, { bytes: data, type: "font/ttf" });
    subsetted = subsetted || subset;
  }

  if (out.size && subsetted) {
    warnings.push(`已從 .pptx 取出 ${out.size} 套內嵌字型（${[...out.keys()].map((k) => k.slice(6)).join("、")}），`
      + "排版會跟原稿一致。要注意這些是子集化的字型，只含原稿用到的字 ——"
      + "打進沒用過的字（例如把年份改成別的數字）可能會掉回系統字型。");
  }
  return out;
}

/* ---------------- 主流程 ---------------- */

/** 這個 zip 是不是 pptx？ */
export function looksLikePptx(files) {
  return files.has("ppt/presentation.xml");
}

/** 依投影片順序列出 slide 的 zip 路徑。 */
function slidePaths(files, warnings) {
  const doc = parseXml(files.get("ppt/presentation.xml"), "ppt/presentation.xml");
  const rels = parseRels(files.get("ppt/_rels/presentation.xml.rels"), "ppt/_rels/presentation.xml.rels");
  const out = [];
  for (const sldId of doc.getElementsByTagNameNS(P_NS, "sldId")) {
    const id = sldId.getAttributeNS(R_NS, "id") || attr(sldId, "r:id");
    const target = rels.get(id)?.path;
    if (target && files.has(target)) out.push(target);
  }
  if (!out.length) {
    // 沒有 rels 或對不上的時候，退回檔名排序。
    const fallback = [...files.keys()]
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => num(a.match(/(\d+)/)[1]) - num(b.match(/(\d+)/)[1]));
    if (fallback.length) warnings.push("讀不到投影片順序，改用檔名排序。");
    return { paths: fallback, doc };
  }
  return { paths: out, doc };
}

/**
 * 把一份 .pptx 轉成模板。
 *
 * @param {Map<string, Uint8Array>} files  readZip 的結果
 * @param {{slide?:number}} opts  要匯入第幾頁（0 起算）
 * @returns {Promise<{raw:object, assets:Map<string,{bytes:Uint8Array,type:string}>,
 *            warnings:string[], slideCount:number, slide:number, fonts:string[]}}>
 */
export async function importPptx(files, { slide = 0 } = {}) {
  const warnings = [];
  const theme = readTheme(files, warnings);
  const { paths, doc: presentation } = slidePaths(files, warnings);
  if (!paths.length) throw new Error("這份 .pptx 裡找不到任何投影片。");

  const index = clamp(Math.round(slide), 0, paths.length - 1);
  const slidePath = paths[index];

  // 投影片尺寸 → 畫布。等比縮放到 IG 的原生寬度，輸出解析度才夠用。
  const sldSz = presentation.getElementsByTagNameNS(P_NS, "sldSz")[0];
  const slideWpx = num(attr(sldSz, "cx"), TARGET_WIDTH * EMU_PER_PX) / EMU_PER_PX;
  const slideHpx = num(attr(sldSz, "cy"), TARGET_WIDTH * EMU_PER_PX) / EMU_PER_PX;
  let k = TARGET_WIDTH / slideWpx;
  // 高度也不能爆掉格式的上限。
  if (slideHpx * k > 4096) k = 4096 / slideHpx;
  const canvasW = Math.round(slideWpx * k);
  let canvasH = Math.round(slideHpx * k);
  // Canva 的投影片高度常常差 IG 標準尺寸一兩個 px（例如 1349 而不是 1350），
  // 那是它自己的 EMU 進位。差不到 1% 就對齊過去，上傳才不會被再壓一次。
  const snapped = IG_HEIGHTS.find((h) => Math.abs(h - canvasH) / h <= 0.01);
  if (snapped && snapped !== canvasH) canvasH = snapped;
  if (Math.abs(k - 1) > 0.001) {
    warnings.push(`原稿是 ${Math.round(slideWpx)} × ${Math.round(slideHpx)}，已等比放大／縮小到 ${canvasW} × ${canvasH}（IG 的原生寬度是 1080）。`);
  }

  /** EMU → 我們的畫布 px。 */
  const toPx = (emu) => (emu / EMU_PER_PX) * k;

  const slideDoc = parseXml(files.get(slidePath), slidePath);
  const relsPath = slidePath.replace(/slides\/([^/]+)$/, "slides/_rels/$1.rels");
  const rels = parseRels(files.get(relsPath), relsPath);

  const layers = [];
  /** 有文字外框、但 .pptx 沒寫粗細的圖層。 */
  const assumedStrokes = [];
  const assets = new Map();
  const fonts = new Set();
  const usedIds = new Set();
  /** 走完 spTree 之後要量尺寸的圖片。 */
  const pictures = [];

  const makeId = (name, fallback) => {
    const base = String(name || fallback).trim().toLowerCase()
      .replace(/[^a-z0-9一-鿿]+/g, "-").replace(/^-+|-+$/g, "") || fallback;
    let id = base;
    let n = 2;
    while (usedIds.has(id)) { id = `${base}-${n}`; n += 1; }
    usedIds.add(id);
    return id;
  };

  /** 元素的顯示名稱，圖層面板會用到。 */
  const nameOf = (node) => attr(descend(node, P_NS, "cNvPr"), "name", "") || "";

  function pushRect(id, label, rect, spPr, radius) {
    const solid = kid(spPr, A_NS, "solidFill");
    const grad = kid(spPr, A_NS, "gradFill");
    if (!solid && !grad) return false;

    const layer = {
      id, type: "rect", label,
      rect,
      radius: Math.round(radius * 10) / 10,
      // 匯入的色塊都是裝飾。鎖起來，它們才不會擋住上面真正要編輯的文字。
      locked: true,
      color: "#000000",
    };

    if (grad) {
      const stops = kids(kid(grad, A_NS, "gsLst"), A_NS, "gs")
        .map((gs) => ({ pos: num(attr(gs, "pos", 0)), color: readColor(gs, theme, warnings, label) }))
        .filter((s) => s.color)
        .sort((a, b) => a.pos - b.pos);
      if (stops.length >= 2) {
        // OOXML 的 ang 是漸層流向、順時針、0 朝右；我們的 angle 是 0 朝上。
        const lin = kid(grad, A_NS, "lin");
        const ooxml = lin ? num(attr(lin, "ang", 0)) / ROT_PER_DEG : 0;
        layer.gradient = {
          from: stops[0].color,
          to: stops[stops.length - 1].color,
          angle: ((ooxml + 90) % 360 + 360) % 360,
        };
        layer.color = stops[0].color;
        if (stops.length > 2) {
          warnings.push(`${label}: 漸層有 ${stops.length} 個色停點，只保留頭尾兩個。`);
        }
      } else {
        return false;
      }
    } else {
      layer.color = readColor(solid, theme, warnings, label) || "#000000";
    }
    layers.push(layer);
    return true;
  }

  function walk(node, stack, depth) {
    for (const child of node.children) {
      if (child.namespaceURI !== P_NS) continue;
      const kind = child.localName;

      if (kind === "grpSp") {
        const grpPr = kid(child, P_NS, "grpSpPr");
        const xfrm = readXfrm(kid(grpPr, A_NS, "xfrm"));
        if (!xfrm) { walk(kid(child, P_NS, "spTree") || child, stack, depth + 1); continue; }
        const t = groupTransform(xfrm, kid(grpPr, A_NS, "xfrm"));
        walk(child, t ? [...stack, t] : stack, depth + 1);
        continue;
      }

      if (kind === "graphicFrame") {
        const uri = attr(descend(child, A_NS, "graphicData"), "uri", "");
        const what = uri.includes("/table") ? "表格" : uri.includes("/chart") ? "圖表" : "內嵌物件";
        warnings.push(`「${nameOf(child) || what}」是${what}，讀不進來，已略過。在 Canva 裡把它當成圖片匯出就可以了。`);
        continue;
      }

      if (kind === "cxnSp") {
        warnings.push(`「${nameOf(child) || "連接線"}」是線條，讀不進來，已略過。畫成細長的矩形就可以。`);
        continue;
      }

      if (kind !== "sp" && kind !== "pic") continue;

      const spPr = kid(child, P_NS, "spPr");
      const raw = readXfrm(kid(spPr, A_NS, "xfrm"));
      const label = nameOf(child) || (kind === "pic" ? "圖片" : "元素");
      if (!raw) {
        warnings.push(`「${label}」沒有自己的位置資訊（是版面配置的佔位框），讀不進來，已略過。`);
        continue;
      }
      if (raw.flipH || raw.flipV) {
        warnings.push(`「${label}」在原稿裡被翻轉過，這個做不出來，已用未翻轉的樣子。`);
      }

      const box = applyTransforms(raw, stack);
      // 圖層自己的旋轉，加上外層群組轉過來的角度。
      const totalRot = raw.rot + box.rot;
      const rect = {
        x: Math.round(toPx(box.x) * 10) / 10,
        y: Math.round(toPx(box.y) * 10) / 10,
        w: Math.max(1, Math.round(toPx(box.cx) * 10) / 10),
        h: Math.max(1, Math.round(toPx(box.cy) * 10) / 10),
      };
      const rotate = Math.round(((totalRot % 360) + 360) % 360 * 100) / 100;
      const radius = readRadius(spPr, rect.w, rect.h, warnings, label);

      // 圖片有兩種寫法: <p:pic>，或是一個 <p:sp> 用 <a:blipFill> 填圖。
      // Canva 的照片框、logo 全部是後者 —— 只認 p:pic 的話整張照片會消失。
      const blipFill = kid(spPr, A_NS, "blipFill") || kid(child, P_NS, "blipFill");
      if (blipFill) {
        const blip = descend(blipFill, A_NS, "blip");
        const relId = blip?.getAttributeNS(R_NS, "embed");
        const target = relId ? rels.get(relId) : null;
        if (!target?.path || !files.has(target.path)) {
          warnings.push(`「${label}」的圖片檔在 .pptx 裡找不到，已略過。`);
          continue;
        }
        const ext = target.path.split(".").pop().toLowerCase();
        const type = MEDIA_MIME[ext];
        if (!type) {
          warnings.push(`「${label}」是 .${ext} 格式的圖，瀏覽器畫不出來，已略過。請在原稿裡改成 PNG 或 JPG。`);
          continue;
        }

        const id = makeId(label, `pic${layers.length + 1}`);
        const assetPath = `assets/${id}.${ext}`;
        assets.set(assetPath, { bytes: files.get(target.path), type });

        // 面積夠大的當「要換的照片」，小的當素材（logo、圖示）。
        // 這只是預設值 —— 兩種都點得到、都換得掉，差別只在匯出時
        // 「不含我放的照片」會不會把它拿掉。
        const areaRatio = (rect.w * rect.h) / (canvasW * canvasH);
        const layer = {
          id, type: areaRatio >= PHOTO_AREA_RATIO ? "photo" : "image",
          label, rect, radius: Math.round(radius * 10) / 10,
          fit: "cover", src: assetPath,
          placeholder: `換掉「${label}」`,
        };
        if (rotate) layer.rotate = rotate;

        const crop = {
          src: readEdges(descend(blipFill, A_NS, "srcRect")),
          fill: readEdges(descend(kid(blipFill, A_NS, "stretch"), A_NS, "fillRect")),
        };
        // 裁切要換算成 scale / dx / dy，那得知道圖片的原始尺寸 ——
        // 等 spTree 走完再一次量完，不要在遞迴裡穿插 await。
        pictures.push({ layer, assetPath, crop, label });
        layers.push(layer);
        continue;
      }

      // p:sp —— 可能同時有填色與文字。我們一層只能有一種，所以拆成兩層: 
      // 底下一個 rect，上面一個 text。這樣外觀才留得住。
      const txBody = kid(child, P_NS, "txBody");
      const style = txBody ? readText(txBody, theme, warnings, label) : null;

      const filled = pushRect(makeId(style ? `${label}-底` : label, `shape${layers.length + 1}`),
        style ? `${label}（底色）` : label, rect, spPr, radius);
      if (filled && rotate) layers[layers.length - 1].rotate = rotate;

      if (style) {
        const id = makeId(label, `text${layers.length + 1}`);
        if (style.family) fonts.add(style.family);
        const inset = style.inset;
        const layer = {
          id, type: "text", label,
          // bodyPr 的內縮要吃掉，不然文字會比原稿往左上偏。
          rect: {
            x: Math.round((rect.x + toPx(inset.l)) * 10) / 10,
            y: Math.round((rect.y + toPx(inset.t)) * 10) / 10,
            w: Math.max(1, Math.round((rect.w - toPx(inset.l + inset.r)) * 10) / 10),
            h: Math.max(1, Math.round((rect.h - toPx(inset.t + inset.b)) * 10) / 10),
          },
          text: style.text,
          font: {
            family: style.family ? `"${style.family}", sans-serif` : '"IBM Plex Sans JP", sans-serif',
            size: clamp(Math.round(style.size * k * 10) / 10, 6, MAX_FONT_SIZE),
            weight: style.weight,
            lineHeight: style.lineHeight,
            letterSpacing: Math.round(style.letterSpacing * k * 10) / 10,
          },
          color: style.color,
          align: style.align,
          valign: style.valign,
        };
        if (style.stroke) {
          layer.stroke = {
            color: style.stroke.color,
            // pt → px，再乘上版面正規化的比例。
            width: Math.round(style.stroke.widthPt * PT_TO_PX * k * 100) / 100,
          };
          if (style.stroke.assumedWidth) assumedStrokes.push(label);
        }
        if (rotate) layer.rotate = rotate;
        layers.push(layer);
      }
    }
  }

  const spTree = slideDoc.getElementsByTagNameNS(P_NS, "spTree")[0];
  if (!spTree) throw new Error(`第 ${index + 1} 頁讀不到內容（沒有 spTree）。`);
  walk(spTree, [], 0);

  if (!layers.length) {
    throw new Error(`第 ${index + 1} 頁沒有任何讀得進來的元素。`);
  }

  // 圖片的原始尺寸: 換算裁切，順便檢查方框比例對不對得上。
  await Promise.all(pictures.map(async ({ layer, assetPath, crop, label }) => {
    const asset = assets.get(assetPath);
    const size = await measureImage(asset.bytes, asset.type);
    if (!size || !size.w || !size.h) {
      warnings.push(`「${label}」的圖片量不到尺寸，裁切與縮放會用預設值。`);
      return;
    }
    const fixed = cropToOffset(crop, layer.rect, size.w, size.h, warnings, label);
    if (fixed) { Object.assign(layer, fixed); return; }
    // 沒有裁切、但方框跟圖片的長寬比不一樣: 原稿是把圖拉變形塞進框裡，
    // 我們只做等比，所以會變成裁切。差得多的時候要講。
    const boxRatio = layer.rect.w / layer.rect.h;
    const imgRatio = size.w / size.h;
    const off = Math.abs(boxRatio - imgRatio) / Math.max(boxRatio, imgRatio);
    if (off > 0.08) {
      warnings.push(`「${label}」的框是 ${boxRatio.toFixed(2)}:1、圖片是 ${imgRatio.toFixed(2)}:1，`
        + "原稿把它拉變形了。這裡改成等比填滿（會裁到邊），拖曳可以調整要露出哪一塊。");
    }
  }));

  if (assumedStrokes.length) {
    warnings.push(`${assumedStrokes.join("、")} 有文字外框，但 .pptx 裡沒有記錄外框的粗細 ——`
      + `原稿的設計工具沒有把它寫進檔案。這裡先用最細的 ${DEFAULT_OUTLINE_PT} pt，`
      + "看起來太細的話點那一層，用工具列的「外框」把粗細調上去。");
  }

  // 內嵌字型。Canva 會把用到的字型一起塞進 .pptx，抓出來排版才會跟原稿一樣。
  const embedded = readEmbeddedFonts(files, fonts, warnings);
  for (const [path, asset] of embedded) assets.set(path, asset);

  const missingFonts = [...fonts].filter((f) => !embedded.has(`fonts/${fontFileName(f)}.ttf`)
    && !embedded.has(`fonts/${fontFileName(f)}.otf`)
    && !embedded.has(`fonts/${fontFileName(f)}.woff`)
    && !embedded.has(`fonts/${fontFileName(f)}.woff2`));
  if (missingFonts.length) {
    warnings.push(`這些字型沒有內嵌在 .pptx 裡: ${missingFonts.join("、")}。`
      + "現在是用系統上找得到的替代字型排版。要一模一樣的話，把字型檔（.woff2 / .ttf）"
      + "放進標準模板的 fonts/ 裡，檔名就是字型名稱。");
  }
  if (paths.length > 1) {
    warnings.push(`這份檔案有 ${paths.length} 頁，目前顯示第 ${index + 1} 頁。上面的「頁面」可以換。`);
  }

  return {
    raw: {
      format: "ig-template",
      version: 2,
      name: `匯入的版面${paths.length > 1 ? `（第 ${index + 1} 頁）` : ""}`,
      note: "從 .pptx 匯入。點畫布上的文字或圖片就能改；改完按「下載標準模板」存成 .zip 以後就能重複使用。",
      canvas: canvasW === canvasH
        ? { size: canvasW, background: "#ffffff" }
        : { width: canvasW, height: canvasH, background: "#ffffff" },
      layers,
    },
    assets,
    warnings,
    slideCount: paths.length,
    slide: index,
    fonts: [...fonts],
  };
}
