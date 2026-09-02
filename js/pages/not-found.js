// js/pages/not-found.js — 404。

import { $, escapeHtml } from "../utils/utils.js";

export async function mountPage() {
  const msg = $("#not-found-msg");
  if (msg) {
    const hash = location.hash || "#/";
    msg.innerHTML = `這個網址沒有對應的頁面: <code>${escapeHtml(hash)}</code>`;
  }
  return null;
}
