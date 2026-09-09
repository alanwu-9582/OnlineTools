// js/ui/code-copy.js — add a copy button to every rendered code block.

import { notify } from "./notifications.js";
import { copyText } from "../utils/clipboard.js";
import { icon } from "../utils/utils.js";

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
    button.innerHTML = `<span class="code-copy-ico">${icon("copy", { size: "14px" })}</span>`;

    let resetTimer = null;
    button.addEventListener("click", async () => {
      const code = pre.querySelector("code");
      const text = code ? code.textContent : pre.textContent;
      const ok = await copyText(text);
      if (!ok) {
        notify.danger("複製失敗, 請手動選取程式碼。");
        return;
      }
      notify.success("已複製程式碼");
      button.classList.add("is-copied");
      button.innerHTML = `<span class="code-copy-ico">${icon("check", { size: "14px" })}</span>`;
      if (resetTimer) clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        button.classList.remove("is-copied");
        button.innerHTML = `<span class="code-copy-ico">${icon("copy", { size: "14px" })}</span>`;
      }, 1800);
    });

    wrap.appendChild(button);
  }
}
