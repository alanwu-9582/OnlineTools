// js/pages/catalog.js — 工具與文檔共用的列表: 清單、即時搜尋、篩選對話框。
//
// 兩個路由（#/tools、#/docs）掛的是同一個模組，差別只在 route.kind。

import {
  $, $$, el, icon, escapeHtml, debounce, formatDate, relativeDate,
  readingLabel, compareTitle, compareDateDesc, queryTerms, highlightTerms,
} from "../utils/utils.js";
import { getEntriesByKind, getConfig, getSearchIndex } from "../services/data-service.js";
import { filterEntries } from "../utils/search.js";
import { categoryTag, tagList } from "../ui/labels.js";
import { openModal, closeModal } from "../ui/modal.js";
import { replaceParams } from "../core/router.js";

const SORTS = {
  newest: (a, b) => compareDateDesc(a.publishedDate, b.publishedDate) || compareTitle(a.title, b.title),
  updated: (a, b) => compareDateDesc(a.updatedDate || a.publishedDate, b.updatedDate || b.publishedDate)
    || compareTitle(a.title, b.title),
  title: (a, b) => compareTitle(a.title, b.title),
};

/** 兩種列表的文案；其餘行為完全一樣。 */
const COPY = {
  tool: {
    title: "工具",
    sub: "前端線上工具",
    searchLabel: "搜尋工具",
    placeholder: "搜尋工具名稱、說明、內文…",
    unit: "個",
    emptyTitle: "還沒有工具",
    emptyMsg: "把 .md 放進 content/tools/ 之後執行 node tools/build-data.mjs。",
  },
  doc: {
    title: "教學文檔",
    sub: "各種教學",
    searchLabel: "搜尋文檔",
    placeholder: "搜尋標題、內文、程式碼、標籤…",
    unit: "篇",
    emptyTitle: "還沒有文檔",
    emptyMsg: "把 .md 放進 content/docs/ 之後執行 node tools/build-data.mjs。",
  },
};

let navigate = null;
const state = {
  kind: "tool", routeName: "tools", copy: COPY.tool,
  docs: [], config: { categories: {}, tags: {} },
  query: "", category: "", tags: new Set(), sort: "newest",
  index: null, cursor: -1,
};

export async function mountPage({ params, route, routeTo }) {
  navigate = routeTo;
  state.kind = route?.kind === "doc" ? "doc" : "tool";
  state.routeName = route?.name || (state.kind === "doc" ? "docs" : "tools");
  state.copy = COPY[state.kind];
  readStateFromParams(params);
  applyCopy();

  const searchIco = $("#search-ico");
  if (searchIco) searchIco.innerHTML = icon("search", { size: "18px" });
  const filterIco = $(".filter-toggle-ico");
  if (filterIco) filterIco.innerHTML = icon("filter", { size: "17px" });

  const input = $("#catalog-search");
  if (input) input.value = state.query;
  // 邊打邊出結果。
  input?.addEventListener("input", debounce(() => {
    state.query = input.value;
    state.cursor = -1;
    ensureIndex();
    renderResults();
  }, 80));

  const sortSelect = $("#sort-select");
  if (sortSelect) {
    sortSelect.value = state.sort;
    sortSelect.addEventListener("change", () => {
      state.sort = SORTS[sortSelect.value] ? sortSelect.value : "newest";
      renderResults();
    });
  }

  $("#filter-toggle")?.addEventListener("click", openFilterModal);

  $("#clear-filters")?.addEventListener("click", () => {
    state.query = ""; state.category = ""; state.tags = new Set();
    if (input) input.value = "";
    renderResults();
    input?.focus();
  });

  document.addEventListener("keydown", onKeydown);

  const list = $("#doc-list");
  if (list) list.innerHTML = '<div class="state-block" role="status"><div class="spinner" aria-hidden="true"></div>載入中…</div>';
  setHeadVisible(false);

  try {
    const [docs, config] = await Promise.all([getEntriesByKind(state.kind), getConfig()]);
    state.docs = docs;
    state.config = config;
    if (state.query) await ensureIndex();
    renderResults();
  } catch (err) {
    console.error(err);
    if (list) list.innerHTML =
      `<div class="banner banner-danger" role="alert">資料載入失敗: ${escapeHtml(err.message)}。請確認網路連線，並以 HTTP 伺服器開啟（不要用 file://）後重新整理。</div>`;
  }

  return () => {
    document.removeEventListener("keydown", onKeydown);
    closeModal();
  };
}

/** 把這一種列表的文案填進共用的 HTML 片段。 */
function applyCopy() {
  const copy = state.copy;
  const set = (sel, text) => { const node = $(sel); if (node) node.textContent = text; };
  set("#catalog-title", copy.title);
  set("#catalog-sub", copy.sub);
  set("#catalog-search-label", copy.searchLabel);
  set("#result-unit", copy.unit);
  const input = $("#catalog-search");
  if (input) {
    input.placeholder = copy.placeholder;
    input.setAttribute("aria-label", copy.searchLabel);
  }
}

/* ---------------- URL <-> state ---------------- */

function readStateFromParams(params) {
  state.query = params?.get("q") || "";
  state.category = params?.get("cat") || "";
  state.tags = new Set((params?.get("tags") || "").split(",").filter(Boolean));
  const sort = params?.get("sort") || "newest";
  state.sort = SORTS[sort] ? sort : "newest";
  state.index = null;
  state.cursor = -1;
}

/** 把目前的檢視寫回網址，篩選過的清單就能直接分享。 */
function writeStateToParams() {
  replaceParams(state.routeName, {
    q: state.query,
    cat: state.category,
    tags: Array.from(state.tags).join(","),
    sort: state.sort === "newest" ? "" : state.sort,
  });
}

/* ---------------- 全文索引 ---------------- */

/** 第一次用到才抓內文索引；抓不到還是能用標題與標籤搜。 */
function ensureIndex() {
  if (state.index) return Promise.resolve(state.index);
  return getSearchIndex()
    .then((index) => {
      state.index = index;
      if (state.query) renderResults();
      return index;
    })
    .catch((err) => {
      console.warn("全文索引載入失敗，改用標題與標籤搜尋: ", err);
      return null;
    });
}

/* ---------------- 鍵盤 ---------------- */

function onKeydown(e) {
  const input = $("#catalog-search");
  // 篩選對話框開著時，鍵盤歸它管。
  if (!input || document.querySelector(".modal-overlay")) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "")
    || document.activeElement?.isContentEditable;

  if ((e.key === "/" && !typing) || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k")) {
    e.preventDefault();
    input.focus();
    input.select();
    return;
  }
  if (e.key === "Escape" && document.activeElement === input) {
    if (!input.value) return;
    input.value = "";
    state.query = "";
    renderResults();
    return;
  }

  if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Enter") return;
  // 方向鍵只有在搜尋框或某一列有焦點時才控制清單。
  const inList = document.activeElement === input || document.activeElement?.classList.contains("doc-row");
  if (!inList) return;

  const rows = $$(".doc-row");
  if (!rows.length) return;

  if (e.key === "Enter") {
    if (state.cursor >= 0 && rows[state.cursor]) {
      e.preventDefault();
      rows[state.cursor].click();
    }
    return;
  }
  e.preventDefault();
  const step = e.key === "ArrowDown" ? 1 : -1;
  state.cursor = Math.max(0, Math.min(rows.length - 1, state.cursor + step));
  applyCursor(rows);
}

function applyCursor(rows = $$(".doc-row")) {
  rows.forEach((row, i) => row.classList.toggle("is-cursor", i === state.cursor));
  const active = rows[state.cursor];
  if (active) active.scrollIntoView({ block: "nearest" });
}

/* ---------------- 篩選對話框 ---------------- */

function openFilterModal() {
  // 先改在草稿上，取消或 Esc 就不會動到已套用的條件。
  const draft = { category: state.category, tags: new Set(state.tags) };

  const body = el("div", { class: "filter-modal" });
  const catSection = el("div", { class: "filter-section" },
    el("div", { class: "filter-section-title" }, "類別", el("span", { class: "filter-hint" }, "單選")),
  );
  const catRow = el("div", { class: "filter-row" });
  catSection.appendChild(catRow);

  const tagSection = el("div", { class: "filter-section" },
    el("div", { class: "filter-section-title" }, "標籤", el("span", { class: "filter-hint" }, "可多選")),
  );
  const tagRow = el("div", { class: "filter-row" });
  tagSection.appendChild(tagRow);

  // 只列這一種列表真的用得到的類別與標籤，免得篩到 0 筆。
  const usedCategories = new Set(state.docs.map((doc) => doc.category).filter(Boolean));
  const usedTags = new Set(state.docs.flatMap((doc) => doc.tags || []));

  const paint = () => {
    catRow.replaceChildren();
    catRow.appendChild(chipButton("全部", draft.category === "", null, () => {
      draft.category = ""; paint();
    }));
    for (const [id, meta] of Object.entries(state.config.categories)) {
      if (!usedCategories.has(id)) continue;
      catRow.appendChild(chipButton(meta.label || id, draft.category === id, meta.color, () => {
        draft.category = draft.category === id ? "" : id; paint();
      }));
    }
    tagRow.replaceChildren();
    for (const [id, meta] of Object.entries(state.config.tags)) {
      if (!usedTags.has(id)) continue;
      tagRow.appendChild(chipButton(meta.label || id, draft.tags.has(id), meta.color, () => {
        if (draft.tags.has(id)) draft.tags.delete(id); else draft.tags.add(id);
        paint();
      }));
    }
  };
  paint();
  body.append(catSection, tagSection);

  const reset = el("button", { type: "button", class: "btn btn-ghost" }, "清除");
  const apply = el("button", { type: "button", class: "btn btn-primary" }, "套用");
  const footer = el("div", { class: "filter-modal-foot" }, reset, apply);

  reset.addEventListener("click", () => { draft.category = ""; draft.tags.clear(); paint(); });
  apply.addEventListener("click", () => {
    state.category = draft.category;
    state.tags = new Set(draft.tags);
    closeModal();
    renderResults();
  });

  openModal({ title: `篩選${state.copy.title}`, body, footer, maxWidth: "440px", className: "filter-dialog" });
}

function chipButton(label, active, color, onClick) {
  const btn = el("button", {
    type: "button",
    class: "filter-chip" + (color ? " filter-chip-color" : "") + (active ? " is-active" : ""),
    "aria-pressed": active ? "true" : "false",
    onclick: onClick,
  }, label);
  if (color) btn.style.setProperty("--chip-color", color);
  return btn;
}

/* ---------------- 結果 ---------------- */

function activeFilterCount() {
  return (state.category ? 1 : 0) + state.tags.size;
}

function syncToolbar() {
  const count = activeFilterCount();
  const badge = $("#filter-count");
  if (badge) {
    badge.hidden = count === 0;
    badge.textContent = String(count);
  }
  $("#filter-toggle")?.classList.toggle("has-filters", count > 0);

  const clear = $("#clear-filters");
  if (clear) clear.hidden = !(state.query || count);

  const kbd = $("#search-kbd");
  if (kbd) kbd.hidden = Boolean(state.query);

  // 已套用條件的摘要，可以一鍵移除。
  const host = $("#active-filters");
  if (!host) return;
  host.replaceChildren();
  if (state.category) {
    const meta = state.config.categories[state.category] || {};
    host.appendChild(removableChip(meta.label || state.category, meta.color, () => {
      state.category = ""; renderResults();
    }));
  }
  for (const id of state.tags) {
    const meta = state.config.tags[id] || {};
    host.appendChild(removableChip(meta.label || id, meta.color, () => {
      state.tags.delete(id); renderResults();
    }));
  }
}

function removableChip(label, color, onRemove) {
  const chip = el("span", { class: "active-chip" }, label);
  if (color) chip.style.setProperty("--chip-color", color);
  const x = el("button", {
    type: "button", class: "active-chip-x", "aria-label": `移除篩選: ${label}`, onclick: onRemove,
  }, "×");
  chip.appendChild(x);
  return chip;
}

function renderResults() {
  const host = $("#doc-list");
  const countEl = $("#result-count");
  if (!host) return;
  syncToolbar();
  writeStateToParams();

  const results = filterEntries(state.docs, {
    query: state.query,
    category: state.category,
    tags: Array.from(state.tags),
    index: state.index,
  }).sort(SORTS[state.sort] || SORTS.newest);

  if (countEl) countEl.textContent = String(results.length);

  host.replaceChildren();
  if (!state.docs.length) {
    setHeadVisible(false);
    host.appendChild(stateBlock("book", state.copy.emptyTitle, state.copy.emptyMsg));
    return;
  }
  if (!results.length) {
    setHeadVisible(false);
    host.appendChild(stateBlock("search", "沒有符合的結果", "換個關鍵字，或把篩選清掉。"));
    return;
  }

  setHeadVisible(true);
  const terms = queryTerms(state.query);
  for (const doc of results) host.appendChild(entryRow(doc, terms));
  state.cursor = Math.min(state.cursor, results.length - 1);
  if (state.cursor >= 0) applyCursor();
}

function setHeadVisible(visible) {
  const head = $("#doc-list-head");
  if (head) head.hidden = !visible;
}

function entryRow(doc, terms) {
  const params = { id: doc.id, from: state.kind };
  // 命中內文時，直接連到那一節。
  if (doc.match?.headingId) params.h = doc.match.headingId;
  const query = new URLSearchParams(params).toString();

  const row = el("a", {
    class: "doc-row",
    href: `#/entry?${query}`,
    "aria-label": doc.title,
    onclick: (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      navigate("entry", params);
    },
  });

  const time = readingLabel(doc.readingMinutes);
  const main = el("div", { class: "row-main" },
    el("div", { class: "row-title-line" },
      el("h2", { class: "row-title", html: highlightTerms(doc.title || "未命名", terms) }),
      time ? el("span", { class: "row-time" }, time) : null,
    ),
    doc.description
      ? el("p", { class: "row-desc", html: highlightTerms(doc.description, terms) })
      : null,
    doc.match
      ? el("p", { class: "row-hit" },
        el("span", { class: "row-hit-sec" }, doc.match.heading || "內文"),
        el("span", { class: "row-hit-txt", html: highlightTerms(doc.match.snippet, terms) }),
      )
      : null,
  );

  // 寬螢幕下 .row-meta 是 display: contents，子元素會直接對齊共用格線；
  // 窄螢幕時它變成會換行的 flex 列。
  const meta = el("div", { class: "row-meta" },
    el("div", { class: "row-cat" }, categoryTag(doc.category, state.config)),
    el("div", { class: "row-tags" }, tagList(doc.tags || [], state.config)),
    el("time", {
      class: "row-date",
      datetime: doc.publishedDate,
      title: `發佈於 ${formatDate(doc.publishedDate)}`
        + (doc.updatedDate && doc.updatedDate !== doc.publishedDate ? `，更新於 ${formatDate(doc.updatedDate)}` : ""),
    }, relativeDate(doc.publishedDate) || formatDate(doc.publishedDate)),
  );

  row.append(main, meta);
  return row;
}

function stateBlock(iconName, title, msg) {
  return el("div", { class: "state-block" },
    el("span", { class: "ico", html: icon(iconName, { size: "34px" }) }),
    el("div", { class: "st-title" }, title),
    el("div", { class: "st-msg" }, msg),
  );
}
