// js/ui/tool-host.js — 把 Markdown 裡的工具佔位換成真正的工具。
//
// 在 .md 內文的任何位置放一個空的容器：
//
//     ## 單位換算
//     <div data-tool="unit-converter"></div>
//
// 渲染完 Markdown 之後，這裡會把 js/tools/<id>.js 動態載進來掛上去。
// 佔位元素原本的內容會留到掛載成功前，所以可以先寫一句「載入中／需要 JavaScript」
// 當備援；掛載成功就被換掉。
//
// 工具模組的介面：
//
//     export const meta = { title: "單位換算" };            // 選填
//     export function mount(host, { options }) { … }        // 回傳 cleanup（選填）
//
// `options` 來自佔位元素的 data-options（JSON），例如：
//
//     <div data-tool="unit-converter" data-options='{"group":"length"}'></div>

import { escapeHtml } from "../utils/utils.js";

/** id 直接參與模組路徑，只放行安全字元。 */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function parseOptions(slot) {
  const raw = slot.dataset.options;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    console.warn(`工具 ${slot.dataset.tool} 的 data-options 不是合法 JSON：`, err);
    return {};
  }
}

function failure(slot, id, message) {
  slot.classList.add("tool-slot", "is-failed");
  slot.innerHTML =
    `<div class="banner banner-danger" role="alert">工具「${escapeHtml(id)}」載入失敗：${escapeHtml(message)}</div>`;
}

/**
 * 掛載 container 裡所有的 [data-tool]。
 * 每個工具各自載入，一個壞掉不會影響其他工具與內文。
 * @returns {Promise<Function>} cleanup
 */
export async function mountTools(container) {
  if (!container) return () => {};
  const slots = Array.from(container.querySelectorAll("[data-tool]"));
  if (!slots.length) return () => {};

  const teardown = [];

  await Promise.all(slots.map(async (slot) => {
    const id = String(slot.dataset.tool || "").trim();
    if (!ID_PATTERN.test(id)) {
      failure(slot, id || "(未命名)", "id 只能用小寫英數字與連字號");
      return;
    }

    slot.classList.add("tool-slot", "is-loading");
    try {
      const module = await import(`../tools/${id}.js`);
      if (typeof module.mount !== "function") {
        throw new Error("模組沒有 export mount()");
      }
      slot.replaceChildren();
      slot.classList.remove("is-loading");
      slot.dataset.toolReady = "1";
      const cleanup = await module.mount(slot, { options: parseOptions(slot) });
      if (typeof cleanup === "function") teardown.push(cleanup);
    } catch (err) {
      console.error(err);
      slot.classList.remove("is-loading");
      failure(slot, id, err.message);
    }
  }));

  return () => { for (const fn of teardown) fn?.(); };
}
