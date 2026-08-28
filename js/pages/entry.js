// js/pages/entry.js — 渲染單筆內容（工具或教學文檔），附大綱與捲動定位。
//
// 工具與文檔走的是同一條路：都是 Markdown。差別只在工具的 .md 內文裡
// 放了 <div data-tool="…"></div>，渲染完之後由 tool-host 換成真的工具。

import {
  $, el, icon, escapeHtml, formatDate, relativeDate, readingLabel, loadText,
} from "../utils/utils.js";
import { getEntryById, getConfig, getNeighbours, getSite } from "../services/data-service.js";
import { categoryTag, tagList } from "../ui/labels.js";
import {
  loadMarkdownLibs, renderMarkdown, enhanceMarkdown, extractOutline, stripFrontmatterComments,
} from "../utils/markdown.js";
import { mountTools } from "../ui/tool-host.js";
import { addCopyButtons } from "../ui/code-copy.js";
import { enableLightbox } from "../ui/lightbox.js";
import { notify } from "../ui/notifications.js";
import { buildHash, replaceParams } from "../core/router.js";

/** 回列表的目的地，跟著內容的種類走。 */
const BACK = {
  tool: { hash: "#/tools", label: "返回工具列表" },
  doc: { hash: "#/docs", label: "返回文檔列表" },
};

/** 某一節的可分享網址。 */
function sectionUrl(docId, headingId, kind) {
  const hash = buildHash("entry", { id: docId, from: kind, h: headingId });
  return `${location.origin}${location.pathname}${location.search}${hash}`;
}

export async function mountPage({ params }) {
  const id = params.get("id");
  const wanted = params.get("h");
  const header = $("#doc-header");
  const content = $("#doc-content");
  const outlineHost = $("#outline-nav");
  const outlineAside = $("#doc-outline");
  const foot = $("#doc-foot");

  const teardown = [];

  try {
    const [doc, config, site] = await Promise.all([getEntryById(id), getConfig(), getSite()]);
    if (!doc) {
      header.replaceChildren();
      content.innerHTML =
        `<div class="banner banner-danger" role="alert">找不到這筆內容（id：${escapeHtml(id || "")}）。它可能已經移除，請<a href="#/tools">回到工具列表</a>看看其他的。</div>`;
      if (outlineAside) outlineAside.hidden = true;
      return null;
    }

    setBackLink(doc.type);
    document.title = `${doc.title} · ${site.title || "OnlineTools"}`;
    renderHeader(header, doc, config);

    // 函式庫與 Markdown 原始檔同時抓。CDN 被擋或離線時，內容還是得送到讀者眼前，
    // 所以退而顯示未排版的原始文字，而不是整片空白。
    const [libs, md] = await Promise.all([
      loadMarkdownLibs().then(() => true, (err) => { console.warn(err); return false; }),
      loadText(doc.path),
    ]);
    const source = stripFrontmatterComments(md);

    if (!libs) {
      content.innerHTML =
        '<div class="banner banner-warning" role="alert">排版元件載入失敗（可能是離線或網路被擋），以下顯示未排版的原始內容。</div>'
        + `<pre class="code-block"><code>${escapeHtml(source)}</code></pre>`;
      if (outlineAside) outlineAside.hidden = true;
    } else {
      content.innerHTML = renderMarkdown(source);
      // 內文的加工要在掛工具之前跑完。KaTeX 會把整個容器裡的 $…$ 當成數學式，
      // 掛好的工具如果剛好輸出了金錢符號，就會被吃掉。這時候佔位還是空的，很安全。
      await enhanceMarkdown(content);
      addCopyButtons(content);
      teardown.push(enableLightbox(content));
      teardown.push(await mountTools(content));
      addHeadingAnchors(content, doc);

      const headings = extractOutline(content);
      teardown.push(renderOutline(outlineHost, outlineAside, headings, content, doc));
    }

    teardown.push(await renderFoot(foot, doc, site));
    teardown.push(trackReadingProgress(content));

    if (wanted) teardown.push(scrollToHeading(wanted, content));
  } catch (err) {
    console.error(err);
    header?.replaceChildren();
    if (content) content.innerHTML =
      `<div class="banner banner-danger" role="alert">內容載入失敗：${escapeHtml(err.message)}。請確認網路連線後重新整理頁面。</div>`;
    if (outlineAside) outlineAside.hidden = true;
  }

  return () => { for (const fn of teardown) fn?.(); };
}

function setBackLink(kind) {
  const back = BACK[kind] || BACK.tool;
  const link = $("#back-link");
  const label = $("#back-label");
  if (link) link.href = back.hash;
  if (label) label.textContent = back.label;
}

function renderHeader(host, doc, config) {
  host.replaceChildren();

  if (doc.cover) {
    host.appendChild(el("img", {
      class: "doc-cover",
      src: doc.cover,
      alt: "",
      loading: "lazy",
    }));
  }

  const meta = el("div", { class: "doc-meta" },
    categoryTag(doc.category, config),
    el("time", {
      class: "doc-date",
      datetime: doc.publishedDate,
      title: `發佈於 ${formatDate(doc.publishedDate)}`
        + (doc.updatedDate && doc.updatedDate !== doc.publishedDate ? `，更新於 ${formatDate(doc.updatedDate)}` : ""),
    }, `${formatDate(doc.publishedDate)}　·　${relativeDate(doc.updatedDate || doc.publishedDate)}更新`),
    readingLabel(doc.readingMinutes)
      ? el("span", { class: "doc-readtime" }, readingLabel(doc.readingMinutes))
      : null,
  );
  const title = el("h1", { class: "doc-title" }, doc.title || "未命名");
  const desc = doc.description ? el("p", { class: "doc-desc" }, doc.description) : null;
  const tags = tagList(doc.tags || [], config);
  host.append(meta, title, desc, tags);
}

/* ---------------- 章節錨點 ---------------- */

/**
 * 每個標題加一顆「複製連結」的按鈕。這裡不能用單純的 `#id` 錨點 ——
 * 整個網站都活在 hash 裡 —— 所以按鈕複製的是完整的 `#/entry?id=…&h=…` 網址。
 */
function addHeadingAnchors(content, doc) {
  for (const node of content.querySelectorAll(".doc-heading")) {
    if (!node.id) continue;
    const button = el("button", {
      type: "button",
      class: "heading-anchor",
      title: "複製這個章節的連結",
      "aria-label": `複製「${node.textContent.trim()}」的連結`,
      html: icon("link", { size: "14px" }),
      onclick: async () => {
        const url = sectionUrl(doc.id, node.id, doc.type);
        try {
          await navigator.clipboard.writeText(url);
          notify.success("已複製章節連結");
        } catch {
          notify.warning("無法複製，請手動從網址列取得連結");
        }
        replaceParams("entry", { id: doc.id, from: doc.type, h: node.id });
      },
    });
    node.appendChild(button);
  }
}

/**
 * 進站時直接跳到某一節（分享連結或搜尋命中）。
 * 這時圖片還在載，第一次跳會落在偏上的位置，等下方圖片都有高度後要再校正一次。
 */
function scrollToHeading(headingId, content) {
  const node = document.getElementById(headingId);
  if (!node) return null;

  let cancelled = false;
  const align = () => { if (!cancelled) node.scrollIntoView({ behavior: "auto", block: "start" }); };
  // 瀏覽器自己也會在 load 後還原捲動位置，所以每個可能移動目標的時機都重新對齊：
  // 下一個影格、window load、以及每張圖片載完。
  const stop = () => { cancelled = true; };
  for (const evt of ["wheel", "touchstart", "keydown"]) {
    window.addEventListener(evt, stop, { once: true, passive: true });
  }

  align();
  requestAnimationFrame(align);
  if (document.readyState !== "complete") window.addEventListener("load", align, { once: true });

  const pending = Array.from(content?.querySelectorAll("img") || []).filter((img) => !img.complete);
  Promise.all(pending.map((img) => new Promise((resolve) => {
    img.addEventListener("load", resolve, { once: true });
    img.addEventListener("error", resolve, { once: true });
  }))).then(align);

  node.classList.add("is-targeted");
  const flashTimer = setTimeout(() => node.classList.remove("is-targeted"), 2000);

  return () => {
    cancelled = true;
    clearTimeout(flashTimer);
    window.removeEventListener("load", align);
    for (const evt of ["wheel", "touchstart", "keydown"]) window.removeEventListener(evt, stop);
  };
}

/* ---------------- 頁尾：上／下一篇 + 原始檔 ---------------- */

async function renderFoot(host, doc, site) {
  if (!host) return null;
  const { prev, next } = await getNeighbours(doc.id);
  host.replaceChildren();
  host.hidden = false;

  const nav = el("div", { class: "doc-nav" });
  nav.appendChild(neighbourLink(prev, "prev"));
  nav.appendChild(neighbourLink(next, "next"));
  host.appendChild(nav);

  if (site.repo) {
    host.appendChild(el("div", { class: "doc-source" },
      el("span", {}, "這頁有錯或看不懂？"),
      el("a", {
        href: `${site.repo}/blob/main/${doc.path}`,
        target: "_blank",
        rel: "noopener noreferrer",
      }, "看原始檔"),
      el("span", {}, "／"),
      el("a", {
        href: `${site.repo}/issues/new?title=${encodeURIComponent(`[${doc.type === "tool" ? "工具" : "文檔"}] ${doc.title}`)}`
          + `&body=${encodeURIComponent(`標題：${doc.title}\n路徑：${doc.path}\n\n問題描述：\n`)}`,
        target: "_blank",
        rel: "noopener noreferrer",
      }, "回報問題"),
    ));
  }
  return null;
}

function neighbourLink(doc, dir) {
  const label = dir === "prev" ? "上一篇" : "下一篇";
  if (!doc) return el("span", { class: `doc-nav-link is-${dir} is-empty` }, "");
  return el("a", {
    class: `doc-nav-link is-${dir}`,
    href: buildHash("entry", { id: doc.id, from: doc.type }),
  },
    el("span", { class: "doc-nav-dir" }, dir === "prev" ? `← ${label}` : `${label} →`),
    el("span", { class: "doc-nav-title" }, doc.title),
  );
}

/* ---------------- 閱讀進度 ---------------- */

/** 視窗頂端的細條，顯示目前讀到內文的哪裡。 */
function trackReadingProgress(content) {
  const bar = $("#read-progress");
  if (!bar || !content) return null;
  const fill = bar.firstElementChild;

  const update = () => {
    const rect = content.getBoundingClientRect();
    const total = rect.height - window.innerHeight;
    const done = total > 0 ? (-rect.top) / total : 1;
    fill.style.transform = `scaleX(${Math.min(1, Math.max(0, done))})`;
  };

  update();
  window.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", update);
  return () => {
    window.removeEventListener("scroll", update);
    window.removeEventListener("resize", update);
  };
}

/* 大綱編號：六層，隨著層級加深在「純數字」與「括號」之間交替 ——
   1. → (1). → A. → (A). → a. → (a). */
const TIER_FORMATTERS = [
  (n) => `${n}.`,
  (n) => `(${n}).`,
  (n) => `${letterLabel(n).toUpperCase()}.`,
  (n) => `(${letterLabel(n).toUpperCase()}).`,
  (n) => `${letterLabel(n)}.`,
  (n) => `(${letterLabel(n)}).`,
];

/** 1 → a、2 → b、…、27 → aa（試算表式編號，深層清單也不會用完）。 */
function letterLabel(n) {
  let out = "";
  let value = n;
  while (value > 0) {
    out = String.fromCharCode(97 + ((value - 1) % 26)) + out;
    value = Math.floor((value - 1) / 26);
  }
  return out || "a";
}

/**
 * 給每個標題一個階層編號。計數器是依「巢狀深度」而不是原始標題層級，
 * 所以就算內文跳級（h2 → h4）也能編得乾淨，而且每一層在換父節點時會重新從 1 開始。
 */
function numberOutline(items) {
  const openLevels = [];
  const counts = [];
  return items.map((item) => {
    // 只收掉「更深」的層級（嚴格大於）。同層的兄弟必須沿用同一個計數器，
    // 才會往下數而不是重新從 1 開始。
    while (openLevels.length && openLevels[openLevels.length - 1] > item.level) {
      openLevels.pop();
      counts.pop();
    }
    if (!openLevels.length || openLevels[openLevels.length - 1] !== item.level) {
      openLevels.push(item.level);
    }
    const tier = openLevels.length - 1;
    counts.length = openLevels.length;
    counts[tier] = (counts[tier] || 0) + 1;
    const format = TIER_FORMATTERS[Math.min(tier, TIER_FORMATTERS.length - 1)];
    return { ...item, tier, prefix: format(counts[tier]) };
  });
}

function renderOutline(host, aside, headings, content, doc) {
  if (!host) return null;
  host.replaceChildren();
  const usable = headings.filter((h) => h.id && h.level >= 1);
  if (usable.length < 2) {
    if (aside) aside.hidden = true;
    return null;
  }
  if (aside) aside.hidden = false;

  const numbered = numberOutline(usable);
  const links = new Map();
  for (const h of numbered) {
    const link = el("a", {
      class: "outline-link",
      // 真正的路由網址：中鍵開新分頁與「複製連結」都能用。
      href: buildHash("entry", { id: doc.id, from: doc.type, h: h.id }),
      title: `${h.prefix} ${h.text}`,
      dataset: { target: h.id, level: String(h.level), tier: String(h.tier) },
      style: `--indent:${h.tier}`,
      onclick: (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        const node = document.getElementById(h.id);
        if (!node) return;
        node.scrollIntoView({ behavior: "smooth", block: "start" });
        replaceParams("entry", { id: doc.id, from: doc.type, h: h.id });
        setActive(h.id);
      },
    },
      el("span", { class: "outline-num" }, h.prefix),
      el("span", { class: "outline-text" }, h.text),
    );
    links.set(h.id, link);
    host.appendChild(link);
  }

  function setActive(id) {
    let activeLink = null;
    for (const [key, link] of links) {
      const isActive = key === id;
      link.classList.toggle("is-active", isActive);
      if (isActive) activeLink = link;
    }
    if (activeLink) keepOutlineLinkVisible(activeLink, host, aside);
  }

  const outlineTitle = aside?.querySelector(".outline-title");
  const scrollToTop = () => {
    content.closest(".viewer")?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActive(null);
  };
  outlineTitle?.addEventListener("click", scrollToTop);

  // 用 IntersectionObserver 做捲動定位。
  const visible = new Set();
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) visible.add(entry.target.id);
      else visible.delete(entry.target.id);
    }
    // 標示最上面那個看得到的標題；都看不到時就維持剛剛經過的那一個。
    const ordered = usable.map((h) => h.id).filter((hid) => visible.has(hid));
    if (ordered.length) setActive(ordered[0]);
  }, { rootMargin: "0px 0px -70% 0px", threshold: 0 });

  for (const h of usable) {
    const node = document.getElementById(h.id);
    if (node) observer.observe(node);
  }
  setActive(usable[0].id);

  return () => {
    observer.disconnect();
    outlineTitle?.removeEventListener("click", scrollToTop);
  };
}

/** 讓目前這一項留在會捲動的那個容器可視範圍內。 */
function keepOutlineLinkVisible(link, host, aside) {
  const scrollContainer = [host, aside].find(
    (node) => node && node.scrollHeight > node.clientHeight + 1,
  );
  if (!scrollContainer) return;

  const linkRect = link.getBoundingClientRect();
  const containerRect = scrollContainer.getBoundingClientRect();
  const edgePadding = 8;
  let offset = 0;

  if (linkRect.top < containerRect.top + edgePadding) {
    offset = linkRect.top - containerRect.top - edgePadding;
  } else if (linkRect.bottom > containerRect.bottom - edgePadding) {
    offset = linkRect.bottom - containerRect.bottom + edgePadding;
  }

  if (offset) scrollContainer.scrollBy({ top: offset, behavior: "smooth" });
}
