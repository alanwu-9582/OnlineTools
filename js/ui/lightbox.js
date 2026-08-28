// js/ui/lightbox.js — 點文章裡的圖片可以放大看。
//
// 截圖與示意圖在內文欄寬下常常看不清楚，而手機上「在新分頁開啟圖片」
// 又不是一般人會想到的操作。

let overlay = null;

function close() {
  if (!overlay) return;
  const node = overlay;
  overlay = null;
  document.removeEventListener("keydown", onKeydown);
  node.classList.remove("open");
  setTimeout(() => node.remove(), 160);
}

function onKeydown(e) {
  if (e.key === "Escape") close();
}

function open(src, caption) {
  close();
  overlay = document.createElement("div");
  overlay.className = "lightbox";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", caption || "圖片檢視");
  overlay.innerHTML = `
    <button class="lightbox-close" type="button" aria-label="關閉圖片">×</button>
    <img class="lightbox-img" alt="">
    <div class="lightbox-cap"></div>
  `;
  const img = overlay.querySelector(".lightbox-img");
  img.src = src;
  img.alt = caption || "";
  const cap = overlay.querySelector(".lightbox-cap");
  cap.textContent = caption || "";
  cap.hidden = !caption;

  overlay.querySelector(".lightbox-close").addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => {
    // Clicking the backdrop closes; clicking the image itself does not.
    if (e.target === overlay || e.target === cap) close();
  });

  document.body.appendChild(overlay);
  document.addEventListener("keydown", onKeydown);
  void overlay.offsetWidth;
  overlay.classList.add("open");
  overlay.querySelector(".lightbox-close").focus();
}

/**
 * Make every image inside `container` open in the lightbox.
 * @returns {Function} cleanup
 */
export function enableLightbox(container) {
  if (!container) return () => {};
  const targets = Array.from(container.querySelectorAll("img.doc-img, .doc-content img"));
  for (const img of targets) {
    // Images already wrapped in a link keep their link behaviour.
    if (img.closest("a")) continue;
    img.classList.add("is-zoomable");
    img.setAttribute("role", "button");
    img.setAttribute("tabindex", "0");
    img.title = img.title || "點擊放大";
  }

  const onClick = (e) => {
    const img = e.target.closest("img.is-zoomable");
    if (!img) return;
    e.preventDefault();
    open(img.currentSrc || img.src, img.getAttribute("alt") || img.getAttribute("title") || "");
  };
  const onKey = (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const img = e.target.closest?.("img.is-zoomable");
    if (!img) return;
    e.preventDefault();
    open(img.currentSrc || img.src, img.getAttribute("alt") || img.getAttribute("title") || "");
  };

  container.addEventListener("click", onClick);
  container.addEventListener("keydown", onKey);

  return () => {
    container.removeEventListener("click", onClick);
    container.removeEventListener("keydown", onKey);
    close();
  };
}
