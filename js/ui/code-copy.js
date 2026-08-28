// js/ui/code-copy.js — add a copy button to every rendered code block.

import { notify } from "./notifications.js";
import { copyText } from "../utils/clipboard.js";

const COPY_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"></rect><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"></path></svg>';
const DONE_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';

/**
 * Wrap each `pre.code-block` so a copy button can float above the code
 * without scrolling away with long lines.
 */
export function addCopyButtons(container) {
  if (!container) return;
  for (const pre of container.querySelectorAll("pre.code-block")) {
    if (pre.dataset.copyReady) continue;
    pre.dataset.copyReady = "1";

    const wrap = document.createElement("div");
    wrap.className = "code-wrap";
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "code-copy";
    button.title = "複製程式碼";
    button.setAttribute("aria-label", "複製程式碼");
    button.innerHTML = `<span class="code-copy-ico">${COPY_ICON}</span>`;

    let resetTimer = null;
    button.addEventListener("click", async () => {
      const code = pre.querySelector("code");
      const text = code ? code.textContent : pre.textContent;
      const ok = await copyText(text);
      if (!ok) {
        notify.danger("複製失敗，請手動選取程式碼。");
        return;
      }
      notify.success("已複製程式碼");
      button.classList.add("is-copied");
      button.innerHTML = `<span class="code-copy-ico">${DONE_ICON}</span>`;
      if (resetTimer) clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        button.classList.remove("is-copied");
        button.innerHTML = `<span class="code-copy-ico">${COPY_ICON}</span>`;
      }, 1800);
    });

    wrap.appendChild(button);
  }
}
