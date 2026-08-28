// js/utils/search.js — 依關鍵字 + 類別 + 標籤過濾內容（工具與文檔共用）。
//
// 標題／描述／標籤這些 metadata 永遠會被搜到。當有帶入 data/search-index.json
// 產生的全文索引時，內文也會被搜到，而且每個命中會記住是哪一節，
// 結果就能直接連到那個標題。

import { normalizeText } from "./utils.js";

/** 一筆內容可搜尋的 metadata 欄位。 */
export function searchableFields(doc) {
  return [
    doc.title,
    doc.description,
    doc.category,
    ...(doc.tags || []),
    doc.path,
  ];
}

/** 產生摘要時，命中字詞前後各留幾個字。 */
const SNIPPET_PAD = 42;

/**
 * 在 text 中，圍繞第一個命中的詞切出一段可讀的視窗。
 * 回傳原本的大小寫，highlight 是渲染時才做。
 */
function snippetAround(text, terms) {
  const hay = text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const i = hay.indexOf(term);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  if (at === -1) return text.slice(0, SNIPPET_PAD * 2).trim();

  const start = Math.max(0, at - SNIPPET_PAD);
  const end = Math.min(text.length, at + SNIPPET_PAD * 2);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

/**
 * 一筆內容中最相關的段落。
 * @returns {{headingId:string, heading:string, snippet:string, score:number}|null}
 */
function bestBlock(blocks, terms) {
  let best = null;
  for (const block of blocks) {
    const heading = normalizeText(block.h);
    const body = normalizeText(block.t);
    let score = 0;
    for (const term of terms) {
      if (heading.includes(term)) score += 3;
      else if (body.includes(term)) score += 1;
    }
    if (score > 0 && (!best || score > best.score)) {
      best = {
        headingId: block.i || "",
        heading: block.h || "",
        snippet: snippetAround(block.t || block.h || "", terms),
        score,
      };
    }
  }
  return best;
}

/**
 * 過濾內容。
 * @param {Array}  docs
 * @param {object} opts
 * @param {string} opts.query      自由搜尋；以空白分隔的每個詞都必須命中
 * @param {string} opts.category   單一類別 id，"" 代表全部
 * @param {string[]} opts.tags     必須全部具備的標籤（AND），[] 代表全部
 * @param {Map<string, Array>} [opts.index]  以文章 id 為鍵的全文索引
 * @returns {Array} 命中的內容，可能帶有 `match` 欄位標示命中在內文的哪一節
 */
export function filterEntries(docs, { query = "", category = "", tags = [], index = null } = {}) {
  const q = normalizeText(query);
  const terms = q ? q.split(/\s+/).filter(Boolean) : [];
  const tagSet = tags.filter(Boolean);

  const out = [];
  for (const doc of docs) {
    if (category && doc.category !== category) continue;
    if (tagSet.length && !tagSet.every((t) => (doc.tags || []).includes(t))) continue;

    if (!terms.length) { out.push(doc); continue; }

    const meta = searchableFields(doc).map(normalizeText).join(" ");
    const blocks = index?.get(doc.id) || null;
    const metaOnly = terms.every((t) => meta.includes(t));

    if (!blocks) {
      if (metaOnly) out.push(doc);
      continue;
    }

    // 關鍵字可能分散在標題與內文，所以先整篇比對，再找出最適合當摘要的那一節。
    const full = `${meta} ${blocks.map((b) => `${b.h} ${b.t}`).join(" ")}`.toLowerCase();
    if (!terms.every((t) => full.includes(t))) continue;

    const hit = metaOnly ? null : bestBlock(blocks, terms);
    out.push(hit ? { ...doc, match: hit } : doc);
  }
  return out;
}
