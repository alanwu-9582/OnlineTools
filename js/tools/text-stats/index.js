// js/tools/text-stats/index.js — 字數統計。
//
// 中英文混排的字數不能只算一種: 中文論「字」，英文論「詞」。
// 這裡把兩種分開數，再給一個常見的「總字數」（中文字 + 英文詞）。

import {
  panel, textArea, outputRow, note, el,
} from "../kit.js";

export const meta = { title: "字數統計" };

/** 中日韓統一表意文字（含擴充 A 與相容區）。 */
const CJK = /[㐀-䶿一-鿿豈-﫿]/g;
/** 全形與半形的標點。 */
const PUNCT = /[ -〿＀-￯!-/:-@[-`{-~]/g;

/** 以中文 350 字／分、英文 200 詞／分估閱讀時間。 */
function readingMinutes(cjk, words) {
  return Math.max(1, Math.round(cjk / 350 + words / 200));
}

export function mount(host, { options = {} } = {}) {
  const source = textArea({
    value: String(options.value ?? ""),
    placeholder: "貼上要統計的文字",
    rows: 8,
    mono: false,
    onInput: update,
  });

  const outs = {
    total: outputRow("總字數"),
    cjk: outputRow("中文字"),
    words: outputRow("英文詞"),
    chars: outputRow("字元（含空白）"),
    charsNoSpace: outputRow("字元（不含空白）"),
    lines: outputRow("行數"),
    paragraphs: outputRow("段落"),
    bytes: outputRow("UTF-8 位元組"),
    reading: outputRow("估計閱讀時間"),
  };

  function update() {
    const text = source.value;
    if (!text) {
      for (const outRow of Object.values(outs)) outRow.set("");
      return;
    }

    const cjk = (text.match(CJK) || []).length;
    // 先把中文字與標點抽掉，剩下的才用空白切成英文詞。
    const latin = text.replace(CJK, " ").replace(PUNCT, " ");
    const words = (latin.match(/[A-Za-z0-9_'-]+/g) || []).length;
    const lines = text.split(/\r?\n/).length;
    const paragraphs = text.split(/\r?\n\s*\r?\n/).filter((part) => part.trim()).length;

    outs.total.set(cjk + words);
    outs.cjk.set(cjk);
    outs.words.set(words);
    outs.chars.set(Array.from(text).length);
    outs.charsNoSpace.set(Array.from(text.replace(/\s/g, "")).length);
    outs.lines.set(lines);
    outs.paragraphs.set(paragraphs);
    outs.bytes.set(new TextEncoder().encode(text).length);
    outs.reading.set(`約 ${readingMinutes(cjk, words)} 分鐘`);
  }

  host.appendChild(panel(
    source,
    el("div", { class: "tool-convert-list" }, ...Object.values(outs)),
    note("字元數是用 Array.from 數的，所以 emoji 與罕用字這種佔兩個 UTF-16 單位的字元只算一個。"),
  ));

  update();
  return null;
}
