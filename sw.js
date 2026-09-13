// sw.js — 離線支援。
//
// 策略刻意偏向「拿到最新的」: 
//
//   同源的所有東西  → 先走網路, 失敗才用快取
//   圖片            → 先用快取（圖片只會新增, 不會就地改內容）
//   CDN 函式庫      → 先用快取（網址都鎖了版本）
//
// 如果程式碼也先走快取, 改過的工具或修好的 bug 就要等第二次造訪才看得到。
// 有網路的人一律拿到目前的檔案；快取只是為了完全沒網路的時候。
//
// CACHE_VERSION 與 SHELL 由 tools/build-data.mjs 產生, 不要手改 ——
// 以前是手動維護的, 結果清單裡躺著九個早就刪掉的檔案, 而且每次改東西
// 都要記得把版本號往上加。現在版本號是檔案內容的雜湊, 改了就自動換。

/* build:precache:start */
const CACHE_VERSION = "onlinetools-9d4eba76d393";
const SHELL = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "assets/images/icon.svg",
  "css/catalog.css",
  "css/components.css",
  "css/layout.css",
  "css/pages.css",
  "css/theme.css",
  "css/tools.css",
  "css/viewer.css",
  "js/core/main.js",
  "js/core/offline.js",
  "js/core/router.js",
  "js/core/storage.js",
  "js/pages/catalog.js",
  "js/pages/entry.js",
  "js/pages/home.js",
  "js/pages/links.js",
  "js/pages/not-found.js",
  "js/services/data-service.js",
  "js/tools/ig-template/bundle.js",
  "js/tools/ig-template/color.js",
  "js/tools/ig-template/editor.js",
  "js/tools/ig-template/ig-template.css",
  "js/tools/ig-template/import-pptx.js",
  "js/tools/ig-template/index.js",
  "js/tools/ig-template/layout.js",
  "js/tools/ig-template/render.js",
  "js/tools/ig-template/schema.js",
  "js/tools/kit.js",
  "js/tools/md2docs/diagram.js",
  "js/tools/md2docs/doc-model.js",
  "js/tools/md2docs/docx.js",
  "js/tools/md2docs/images.js",
  "js/tools/md2docs/index.js",
  "js/tools/md2docs/math.js",
  "js/tools/md2docs/md2docs.css",
  "js/tools/md2docs/meta.js",
  "js/tools/md2docs/paper.js",
  "js/tools/md2docs/templates.js",
  "js/tools/paper-bag/assembly.js",
  "js/tools/paper-bag/fold-model.js",
  "js/tools/paper-bag/fold-view.js",
  "js/tools/paper-bag/geometry.js",
  "js/tools/paper-bag/index.js",
  "js/tools/paper-bag/net.js",
  "js/tools/paper-bag/paper-bag.css",
  "js/tools/split-bill/index.js",
  "js/tools/split-bill/settle.js",
  "js/tools/split-bill/split-bill.css",
  "js/tools/split-bill/storage.js",
  "js/tools/svg.js",
  "js/tools/text-stats/index.js",
  "js/tools/zip.js",
  "js/ui/code-copy.js",
  "js/ui/labels.js",
  "js/ui/lightbox.js",
  "js/ui/modal.js",
  "js/ui/notifications.js",
  "js/ui/sidebar.js",
  "js/ui/storage-panel.js",
  "js/ui/tool-host.js",
  "js/utils/clipboard.js",
  "js/utils/markdown.js",
  "js/utils/search.js",
  "js/utils/utils.js",
  "pages/catalog.html",
  "pages/entry.html",
  "pages/home.html",
  "pages/links.html",
  "pages/not-found.html",
  "data/entries.json",
  "data/links.json",
  "data/rail-network.json",
  "data/search-index.json",
  "data/site.json",
  "assets/icons/airport.svg",
  "assets/icons/alert.svg",
  "assets/icons/arrow-right.svg",
  "assets/icons/book.svg",
  "assets/icons/check.svg",
  "assets/icons/chevron-left.svg",
  "assets/icons/copy.svg",
  "assets/icons/external.svg",
  "assets/icons/filter.svg",
  "assets/icons/grid.svg",
  "assets/icons/home.svg",
  "assets/icons/info.svg",
  "assets/icons/link.svg",
  "assets/icons/lock.svg",
  "assets/icons/menu.svg",
  "assets/icons/pause.svg",
  "assets/icons/play.svg",
  "assets/icons/search.svg",
  "assets/icons/tool.svg",
  "assets/icons/x.svg",
  "assets/templates/basic/preview.jpg",
  "assets/templates/basic/template.json",
  "assets/templates/index.json",
];
/* build:precache:end */

const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const ASSET_CACHE = `${CACHE_VERSION}-assets`;
const CDN_CACHE = `${CACHE_VERSION}-cdn`;
const KEEP = new Set([SHELL_CACHE, ASSET_CACHE, CDN_CACHE]);


const CDN_HOSTS = new Set(["cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com"]);

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // 不讓單一個 404 把整個 install 弄失敗。
    await Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (!KEEP.has(key)) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

/** 走網路, 順手留一份；網路不通時再拿出來用。 */
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request);
    return cached || Response.error();
  }
}

/** 優先用快取；沒存過才去打網路。 */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) {
    // 背景更新, 不讓這次請求等它。
    fetch(request).then((r) => { if (r.ok) cache.put(request, r.clone()); }).catch(() => {});
    return cached;
  }
  try {
    const response = await fetch(request);
    if (response.ok || response.type === "opaque") cache.put(request, response.clone());
    return response;
  } catch {
    return Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (CDN_HOSTS.has(url.hostname)) {
    event.respondWith(cacheFirst(request, CDN_CACHE));
    return;
  }
  if (url.origin !== self.location.origin) return;

  // 圖片檔案大, 而且都是「新增一張」而不是就地改掉, 快取那份永遠是對的。
  if (/\.(png|jpe?g|gif|svg|webp|ico)$/i.test(url.pathname)) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }

  event.respondWith((async () => {
    const cacheName = url.pathname.includes("/assets/") ? ASSET_CACHE : SHELL_CACHE;
    const response = await networkFirst(request, cacheName);
    // 整個 miss 掉的導覽請求, 至少要落到一個能用的頁面。
    if (response.type === "error" && request.mode === "navigate") {
      const shell = await caches.match("index.html");
      if (shell) return shell;
    }
    return response;
  })());
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});
