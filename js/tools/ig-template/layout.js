// js/tools/ig-template/layout.js — 文字換行與照片裁切的計算。不碰 DOM 以外的東西
// （只用到 canvas 的 measureText 來量字寬）。

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 中日韓文字與全形標點。這些字之間可以隨意斷行。 */
const CJK = /[⺀-鿿぀-ヿ㇀-㇯＀-￯ -〿]/;

/** 不能出現在行首的字: 標點被推到下一行的開頭很難看。 */
const NO_LINE_START = "、。，．！？；: ）］｝」』〕〉》”’·ー―…‥%,.!?;:)]}»";
/** 不能出現在行尾的字: 開括號黏在行尾同樣不對。 */
const NO_LINE_END = "（［｛「『〔〈《“‘([{«";

/**
 * 把一段文字切成「可以斷行的最小單位」。
 * 中日韓一個字一個單位；拉丁字母要整個詞一起走，而且把前導空白帶上，
 * 這樣量寬度時空白才算進去。
 */
function tokenize(text) {
  const tokens = [];
  let buffer = "";
  for (const ch of text) {
    if (CJK.test(ch)) {
      if (buffer) { tokens.push(buffer); buffer = ""; }
      tokens.push(ch);
    } else if (/\s/.test(ch)) {
      if (buffer) { tokens.push(buffer); buffer = ""; }
      buffer = ch;              // 空白留給下一個詞當前綴
    } else {
      buffer += ch;
    }
  }
  if (buffer) tokens.push(buffer);
  return tokens;
}

/** 單獨一個 token 就比整行還寬（超長英文字）的時候，只能硬切。 */
function hardBreak(ctx, token, maxWidth) {
  const pieces = [];
  let piece = "";
  for (const ch of token) {
    if (piece && ctx.measureText(piece + ch).width > maxWidth) {
      pieces.push(piece);
      piece = ch;
    } else {
      piece += ch;
    }
  }
  if (piece) pieces.push(piece);
  return pieces;
}

/**
 * 折行。ctx 的字型要先設定好。
 * @returns {string[]}
 */
export function wrapText(ctx, text, maxWidth) {
  const out = [];
  const widthOf = (tokens) => ctx.measureText(tokens.join("")).width;

  for (const paragraph of String(text ?? "").split(/\r?\n/)) {
    if (!paragraph) { out.push(""); continue; }

    let line = [];
    const flush = () => { out.push(line.join("").trimEnd()); line = []; };

    for (const token of tokenize(paragraph)) {
      if (!line.length && ctx.measureText(token).width > maxWidth) {
        // 行首就塞不下這一個 token，硬切。
        const pieces = hardBreak(ctx, token, maxWidth);
        out.push(...pieces.slice(0, -1));
        line = [pieces[pieces.length - 1] || ""];
        continue;
      }
      if (line.length && widthOf([...line, token]) > maxWidth) {
        // 禁則處理必須在折行的當下做。做法是「追い出し」: 把不該落在
        // 行首的標點連同前一個字一起推到下一行 —— 而不是讓它掛在行尾。
        // 掛在行尾會讓那一行比行寬還長，文字被切掉就白做了。
        const carry = [token];

        const wantsPullDown = token.length === 1 && NO_LINE_START.includes(token);
        const endsWithOpener = () => line.length > 1
          && NO_LINE_END.includes(line[line.length - 1].slice(-1));

        // 只有在推下來之後仍然放得進一行的時候才推，不然會沒完沒了。
        if (wantsPullDown && line.length > 1 && widthOf([line[line.length - 1], ...carry]) <= maxWidth) {
          carry.unshift(line.pop());
        }
        // 開括號不能留在行尾，連它一起帶下去。
        while (endsWithOpener() && widthOf([line[line.length - 1], ...carry]) <= maxWidth) {
          carry.unshift(line.pop());
        }

        flush();
        carry[0] = carry[0].trimStart();
        // 換到新的一行之後，carry 本身可能就比一行還寬（很長的英文字），
        // 這裡要立刻再硬切一次 —— 迴圈開頭那個檢查只管得到 line 是空的時候。
        if (carry.length === 1 && ctx.measureText(carry[0]).width > maxWidth) {
          const pieces = hardBreak(ctx, carry[0], maxWidth);
          out.push(...pieces.slice(0, -1));
          line = [pieces[pieces.length - 1] || ""];
        } else {
          line = carry;
        }
      } else {
        line.push(token);
      }
    }
    flush();
  }
  return out;
}

/** 把圖層的字型設定套到 ctx 上。 */
export function applyFont(ctx, font, size = font.size) {
  ctx.font = `${font.weight} ${size}px ${font.family}`;
  // letterSpacing 是比較新的 API，沒有就當成 0，只影響字距不影響能不能用。
  if ("letterSpacing" in ctx) ctx.letterSpacing = `${font.letterSpacing || 0}px`;
}

/**
 * 算出一個文字圖層要用多大的字、折成哪幾行。
 *
 * autoShrink 開著的話會從設定的字級往下找，直到高度塞得進框裡 ——
 * IG 標題最常出事就是字打太多，與其溢出去不如自動縮。
 *
 * @returns {{lines:string[], size:number, total:number, shrunk:boolean, overflow:boolean}}
 */
export function layoutText(ctx, layer) {
  const { rect, font } = layer;
  // 下限不能大於基準字級，不然迴圈一次都不會跑，等於 autoShrink 沒作用。
  const floor = Math.min(font.size, Math.max(8, Math.round(font.size * 0.45)));

  const measure = (size) => {
    applyFont(ctx, font, size);
    const lines = wrapText(ctx, layer.text, rect.w);
    return { lines, size, total: lines.length * size * font.lineHeight };
  };

  let result = measure(font.size);
  if (!layer.autoShrink || result.total <= rect.h) {
    return { ...result, shrunk: false, overflow: result.total > rect.h };
  }
  for (let size = font.size - 1; size >= floor; size -= 1) {
    result = measure(size);
    if (result.total <= rect.h) return { ...result, shrunk: true, overflow: false };
  }
  return { ...result, shrunk: true, overflow: true };
}

/**
 * 照片在框裡的位置與大小。
 *
 * @param {{imgW:number, imgH:number, box:object, fit:string,
 *          scale?:number, dx?:number, dy?:number}} input
 * @returns {{x:number, y:number, w:number, h:number, base:number}}
 */
export function fitPhoto({ imgW, imgH, box, fit, scale = 1, dx = 0, dy = 0 }) {
  const base = fit === "contain"
    ? Math.min(box.w / imgW, box.h / imgH)
    : Math.max(box.w / imgW, box.h / imgH);
  const s = base * scale;
  const w = imgW * s;
  const h = imgH * s;

  let x = box.x + (box.w - w) / 2 + dx;
  let y = box.y + (box.h - h) / 2 + dy;

  // cover 的時候不讓框邊露出底色 —— 拖過頭會看到白邊，那絕對不是使用者要的。
  if (fit === "cover") {
    x = w >= box.w ? clamp(x, box.x + box.w - w, box.x) : box.x + (box.w - w) / 2;
    y = h >= box.h ? clamp(y, box.y + box.h - h, box.y) : box.y + (box.h - h) / 2;
  }
  return { x, y, w, h, base };
}

/**
 * 反推: 拖曳之後的位移要夾在什麼範圍內。
 * 給 UI 用，讓拖曳到底的時候滑桿也停在對應的位置。
 */
export function clampOffset({ imgW, imgH, box, fit, scale, dx, dy }) {
  if (fit !== "cover") return { dx, dy };
  const placed = fitPhoto({ imgW, imgH, box, fit, scale, dx, dy });
  return {
    dx: placed.x - (box.x + (box.w - placed.w) / 2),
    dy: placed.y - (box.y + (box.h - placed.h) / 2),
  };
}
