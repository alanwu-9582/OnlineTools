// js/pages/links.js — 其他工具: 外部工具網站的清單，可搜尋、可依分類篩選。
//
// 資料來自 data/links.json，全部手動維護 —— 這頁不是自動爬來的，
// 每一個都是真的用過才放上來。

import { $, el, icon, escapeHtml, debounce, normalizeText, compareTitle } from "../utils/utils.js";
import { getLinks } from "../services/data-service.js";
import { replaceParams } from "../core/router.js";

const state = {
  groups: {},
  sites: [],
  query: "",
  group: "",
};

export async function mountPage({ params }) {
  state.query = params?.get("q") || "";
  state.group = params?.get("group") || "";

  const searchIco = $("#links-search-ico");
  if (searchIco) searchIco.innerHTML = icon("search", { size: "18px" });

  const input = $("#links-search");
  if (input) {
    input.value = state.query;
    input.addEventListener("input", debounce(() => {
      state.query = input.value;
      render();
    }, 80));
  }

  try {
    const data = await getLinks();
    state.groups = data.groups;
    state.sites = data.sites;
    render();
  } catch (err) {
    console.error(err);
    const body = $("#links-body");
    if (body) body.innerHTML =
      `<div class="banner banner-danger" role="alert">連結載入失敗: ${escapeHtml(err.message)}。請確認網路連線後重新整理。</div>`;
  }
  return null;
}

function matches(site, terms) {
  if (state.group && site.group !== state.group) return false;
  if (!terms.length) return true;
  const groupLabel = state.groups[site.group]?.label || site.group || "";
  const hay = normalizeText([
    site.name, site.desc, site.url, groupLabel, ...(site.tags || []),
  ].join(" "));
  return terms.every((term) => hay.includes(term));
}

function render() {
  const body = $("#links-body");
  if (!body) return;

  replaceParams("links", { q: state.query, group: state.group });
  renderFilters();

  const terms = normalizeText(state.query).split(/\s+/).filter(Boolean);
  const hits = state.sites.filter((site) => matches(site, terms));

  const count = $("#links-count");
  if (count) count.textContent = String(hits.length);

  body.replaceChildren();
  if (!state.sites.length) {
    body.appendChild(stateBlock("external", "還沒有連結", "在 data/links.json 的 sites 加幾筆就會出現在這裡。"));
    return;
  }
  if (!hits.length) {
    body.appendChild(stateBlock("search", "沒有符合的結果", "換個關鍵字，或把分類篩選清掉。"));
    return;
  }

  // 依分類分段；分類的順序照 data/links.json 的 groups 排。
  const order = Object.keys(state.groups);
  const byGroup = new Map();
  for (const site of hits) {
    const key = site.group || "";
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(site);
  }
  const keys = Array.from(byGroup.keys()).sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia === -1 ? Infinity : ia) - (ib === -1 ? Infinity : ib);
  });

  for (const key of keys) {
    const meta = state.groups[key] || {};
    body.appendChild(el("div", { class: "section-head" },
      el("div", {},
        el("h2", { class: "section-title" }, meta.label || key || "其他"),
        meta.desc ? el("p", { class: "section-desc" }, meta.desc) : null,
      ),
      el("span", { class: "section-more" }, `${byGroup.get(key).length} 個`),
    ));
    const sites = byGroup.get(key).slice().sort((a, b) => compareTitle(a.name, b.name));
    body.appendChild(el("div", { class: "link-grid" }, sites.map((site) => linkCard(site, meta))));
  }
}

function renderFilters() {
  const host = $("#links-filters");
  if (!host) return;
  const used = new Set(state.sites.map((site) => site.group));
  host.replaceChildren();
  host.appendChild(chip("全部", state.group === "", null, () => { state.group = ""; render(); }));
  for (const [id, meta] of Object.entries(state.groups)) {
    if (!used.has(id)) continue;
    host.appendChild(chip(meta.label || id, state.group === id, meta.color, () => {
      state.group = state.group === id ? "" : id;
      render();
    }));
  }
}

function chip(label, active, color, onClick) {
  const btn = el("button", {
    type: "button",
    class: "filter-chip" + (color ? " filter-chip-color" : "") + (active ? " is-active" : ""),
    "aria-pressed": active ? "true" : "false",
    onclick: onClick,
  }, label);
  if (color) btn.style.setProperty("--chip-color", color);
  return btn;
}

/** 只顯示網域，卡片上才看得出要去哪裡。 */
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function linkCard(site, groupMeta) {
  const card = el("a", {
    class: "link-card",
    href: site.url,
    target: "_blank",
    rel: "noopener noreferrer",
    title: site.url,
  },
    el("div", { class: "link-card-top" },
      el("h3", { class: "link-name" }, site.name),
      el("span", { class: "link-open" }, "開啟 ↗"),
    ),
    site.desc ? el("p", { class: "link-desc" }, site.desc) : null,
    el("div", { class: "link-foot" },
      (site.tags || []).map((tag) => el("span", { class: "badge" }, tag)),
      el("span", { class: "link-host" }, hostOf(site.url)),
    ),
  );
  if (groupMeta?.color) card.style.setProperty("--chip-color", groupMeta.color);
  return card;
}

function stateBlock(iconName, title, msg) {
  return el("div", { class: "state-block" },
    el("span", { class: "ico", html: icon(iconName, { size: "34px" }) }),
    el("div", { class: "st-title" }, title),
    el("div", { class: "st-msg" }, msg),
  );
}
