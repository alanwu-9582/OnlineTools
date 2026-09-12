// js/ui/storage-panel.js — 首頁最底下的「本機儲存」: 看得到存了什麼, 也清得掉。
//
// 擺在最後面是刻意的: 這是維護用的東西, 不該跟工具與文檔搶位置。
//
// 清除分兩格而且預設只勾「離線快取」—— 快取刪掉只是下次重新下載, 但工具資料
// 裡有使用者寫到一半的報告草稿。把兩者綁在同一顆按鈕上, 遲早會有人手一滑
// 就失去一份稿子。

import { el, icon } from "../utils/utils.js";
import { openModal, closeModal } from "./modal.js";
import { notify } from "./notifications.js";
import { inspectStorage, clearStorage, formatBytes } from "../core/storage.js";

function row(label, value, hint) {
  return el("div", { class: "storage-row" },
    el("div", { class: "storage-row-main" },
      el("span", { class: "storage-row-label" }, label),
      el("span", { class: "storage-row-value" }, value),
    ),
    hint ? el("p", { class: "storage-row-hint" }, hint) : null,
  );
}

function checkbox(id, label, hint, checked) {
  const input = el("input", { type: "checkbox", id, class: "storage-check" });
  input.checked = checked;
  return {
    input,
    node: el("label", { class: "storage-option", for: id },
      input,
      el("span", {},
        el("span", { class: "storage-option-label" }, label),
        el("span", { class: "storage-option-hint" }, hint),
      )),
  };
}

async function openDialog(refresh) {
  const snapshot = await inspectStorage();
  const offline = checkbox("clear-offline", "離線快取",
    `${snapshot.offline.files} 個檔案。刪掉只是下次連線時重新下載。`, true);
  const data = checkbox("clear-data", "工具儲存的資料",
    snapshot.items.length
      ? `${snapshot.items.map((i) => i.label).join("、")}。刪掉就找不回來了。`
      : "目前沒有任何工具存過東西。", false);
  data.input.disabled = !snapshot.items.length;

  const body = el("div", { class: "storage-dialog" },
    el("p", { class: "storage-dialog-lead" }, "選擇要清除的項目。這些資料只存在這台裝置上。"),
    offline.node,
    data.node,
  );

  const run = async () => {
    const want = { offline: offline.input.checked, data: data.input.checked };
    if (!want.offline && !want.data) { closeModal(); return; }
    const done = await clearStorage(want);
    closeModal();
    const parts = [];
    if (want.offline) parts.push(`離線快取（${done.offline} 份）`);
    if (want.data) parts.push(`工具資料（${done.data} 項）`);
    notify.success(`已清除 ${parts.join("、")}`);
    await refresh();
    // 清了離線快取就重新載入: 讓使用者立刻拿到最新的檔案, 而不是等下一次開站。
    if (want.offline) setTimeout(() => location.reload(), 900);
  };

  const footer = el("div", { class: "storage-dialog-foot" },
    el("button", { type: "button", class: "btn btn-sm btn-ghost", onclick: () => closeModal() }, "取消"),
    el("button", { type: "button", class: "btn btn-sm btn-primary", onclick: run }, "清除"),
  );
  openModal({ title: "清除本機資料", body, footer, maxWidth: "420px" });
}

/**
 * 首頁的「本機儲存」區塊。
 * @returns {HTMLElement[]} 可以直接展開放進 replaceChildren 的節點
 */
export function storageSection() {
  const head = el("div", { class: "section-head" },
    el("div", {},
      el("h2", { class: "section-title" }, "本機儲存"),
      el("p", { class: "section-desc" }, "這個網站在你的瀏覽器裡留下的東西。沒有伺服器, 所有資料都只在本機。"),
    ));

  const panel = el("div", { class: "storage-panel" });

  async function refresh() {
    const { offline, items, usage } = await inspectStorage();
    const total = items.reduce((sum, i) => sum + i.bytes, 0);
    panel.replaceChildren(
      row("離線快取", offline.files ? `${offline.files} 個檔案` : "尚未建立",
        `離線時用來開啟這個網站${usage ? `。瀏覽器估計本站總共佔用約 ${formatBytes(usage)}` : ""}。`),
      row("工具資料", items.length ? `${items.length} 項 · ${formatBytes(total)}` : "沒有",
        items.length ? items.map((i) => i.label).join("、") : "各工具的草稿與設定會存在這裡。"),
      el("div", { class: "storage-actions" },
        el("button", {
          type: "button", class: "btn btn-sm btn-ghost",
          onclick: () => openDialog(refresh),
        },
        el("span", { class: "btn-ico", html: icon("x", { size: "13px" }) }),
        "清除快取…"),
      ),
    );
  }

  refresh().catch((err) => {
    console.warn("讀取本機儲存狀態失敗: ", err);
    panel.replaceChildren(el("p", { class: "storage-row-hint" }, "讀不到本機儲存狀態。"));
  });

  return [head, panel];
}
