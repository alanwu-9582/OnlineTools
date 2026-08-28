// js/pages/home.js — 首頁：站台簡介、最新工具、最新文檔、其他工具預覽。

import { $, el, icon, escapeHtml, formatDate, readingLabel } from "../utils/utils.js";
import { getSite, getEntries, getLinks, getConfig } from "../services/data-service.js";
import { categoryTag } from "../ui/labels.js";

const TOOL_COUNT = 6;
const DOC_COUNT = 3;
const LINK_COUNT = 8;

export async function mountPage({ routeTo }) {
  const host = $("#home");
  if (!host) return null;

  try {
    const [site, entries, links, config] = await Promise.all([
      getSite(),
      getEntries(),
      getLinks().catch(() => ({ sites: [], groups: {} })),
      getConfig(),
    ]);

    const tools = entries.filter((doc) => doc.type === "tool");
    const docs = entries.filter((doc) => doc.type === "doc");

    host.replaceChildren(
      heroCard(site),
      statsRow(entries, tools, docs, links),
      ...listSection({
        title: "工具",
        desc: "點進去就能用，資料不會離開你的瀏覽器。",
        moreHref: "#/tools",
        moreLabel: "全部工具 →",
        items: tools.slice(0, TOOL_COUNT),
        emptyTitle: "還沒有工具",
        emptyMsg: "把 .md 放進 content/tools/ 之後執行 node tools/build-data.mjs。",
        iconName: "tool",
        config,
        routeTo,
      }),
      ...listSection({
        title: "教學文檔",
        desc: "工具背後的原理與用法。",
        moreHref: "#/docs",
        moreLabel: "全部文檔 →",
        items: docs.slice(0, DOC_COUNT),
        emptyTitle: "還沒有文檔",
        emptyMsg: "把 .md 放進 content/docs/ 之後執行 node tools/build-data.mjs。",
        iconName: "book",
        config,
        routeTo,
      }),
      ...linksSection(links),
    );
  } catch (err) {
    console.error(err);
    host.innerHTML =
      `<div class="banner banner-danger" role="alert">首頁資料載入失敗：${escapeHtml(err.message)}。請確認網路連線，並以 HTTP 伺服器開啟（不要用 file://）後重新整理。</div>`;
  }
  return null;
}

/* ---------------- 招牌 ---------------- */

function heroCard(site) {
  return el("section", { class: "card hero-card" },
    site.logo ? el("img", { class: "hero-logo", src: site.logo, alt: "" }) : null,
    el("div", { class: "hero-body" },
      el("p", { class: "hero-eyebrow" }, site.tagline || "Online tools"),
      el("h1", { class: "hero-title" }, site.title || "OnlineTools"),
      site.description ? el("p", { class: "hero-intro" }, site.description) : null,
      el("div", { class: "hero-actions" },
        el("a", { class: "btn btn-primary", href: "#/tools" },
          el("span", { class: "btn-ico", html: icon("tool", { size: "15px" }) }), "工具"),
        el("a", { class: "btn btn-ghost", href: "#/docs" },
          el("span", { class: "btn-ico", html: icon("book", { size: "15px" }) }), "文檔"),
        el("a", { class: "btn btn-ghost", href: "#/links" },
          el("span", { class: "btn-ico", html: icon("external", { size: "15px" }) }), "其他工具"),
      ),
    ),
  );
}

function statsRow(entries, tools, docs, links) {
  const latest = entries[0]?.updatedDate || entries[0]?.publishedDate;
  const stats = [
    { value: String(tools.length), label: "個工具" },
    { value: String(docs.length), label: "篇文檔" },
    { value: String((links.sites || []).length), label: "個外部連結" },
    { value: latest ? formatDate(latest) : "—", label: "最後更新" },
  ];
  return el("div", { class: "home-stats" },
    stats.map((s) => el("div", { class: "stat-card" },
      el("div", { class: "stat-value" }, s.value),
      el("div", { class: "stat-label" }, s.label),
    )));
}

/* ---------------- 內容區塊 ---------------- */

function listSection(cfg) {
  const head = el("div", { class: "section-head" },
    el("div", {},
      el("h2", { class: "section-title" }, cfg.title),
      el("p", { class: "section-desc" }, cfg.desc),
    ),
    el("a", { class: "section-more", href: cfg.moreHref }, cfg.moreLabel),
  );

  if (!cfg.items.length) {
    return [head, el("div", { class: "state-block" },
      el("span", { class: "ico", html: icon(cfg.iconName, { size: "34px" }) }),
      el("div", { class: "st-title" }, cfg.emptyTitle),
      el("div", { class: "st-msg" }, cfg.emptyMsg),
    )];
  }

  const grid = el("div", { class: "entry-grid" },
    cfg.items.map((doc) => entryCard(doc, cfg.config, cfg.iconName, cfg.routeTo)));
  return [head, grid];
}

function entryCard(doc, config, iconName, routeTo) {
  const params = { id: doc.id, from: doc.type };
  return el("a", {
    class: "entry-card",
    href: `#/entry?${new URLSearchParams(params)}`,
    onclick: (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      routeTo("entry", params);
    },
  },
    el("div", { class: "entry-card-top" },
      categoryTag(doc.category, config),
      el("time", { class: "entry-card-date", datetime: doc.publishedDate }, formatDate(doc.publishedDate)),
    ),
    el("h3", { class: "entry-card-title" },
      el("span", { class: "entry-card-ico", html: icon(iconName, { size: "16px" }) }),
      doc.title,
    ),
    doc.description ? el("p", { class: "entry-card-desc" }, doc.description) : null,
    el("div", { class: "entry-card-foot" },
      el("span", { class: "entry-card-time" }, readingLabel(doc.readingMinutes)),
    ),
  );
}

/* ---------------- 其他工具 ---------------- */

function linksSection(links) {
  const sites = links.sites || [];
  if (!sites.length) return [];
  const head = el("div", { class: "section-head" },
    el("div", {},
      el("h2", { class: "section-title" }, "其他工具"),
      el("p", { class: "section-desc" }, "還有一些他好用工具"),
    ),
    el("a", { class: "section-more", href: "#/links" }, "全部連結 →"),
  );
  const row = el("div", { class: "link-row" }, sites.slice(0, LINK_COUNT).map((site) => {
    const pill = el("a", {
      class: "link-pill",
      href: site.url,
      target: "_blank",
      rel: "noopener noreferrer",
    }, site.name);
    const color = links.groups?.[site.group]?.color;
    if (color) pill.style.setProperty("--chip-color", color);
    return pill;
  }));
  return [head, row];
}
