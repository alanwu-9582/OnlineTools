// js/tools/ig-template/index.js — IG 貼文模板。
//
// 載一份模板包（.zip），照著參考成品把自己的照片與文字直接填在畫布上，
// 輸出成品圖，或把改過的模板再存回一個 .zip。
//
// 全程在瀏覽器裡跑，照片不會上傳到任何地方。

import { panel, field, button, actions, status, note, subhead, el, icon } from "../kit.js";
import { openModal } from "../../ui/modal.js";
import { readBundle, loadBuiltin, writeBundle } from "./bundle.js";
import { createEditor } from "./editor.js";

export const styles = new URL("./ig-template.css", import.meta.url).href;

export const meta = { title: "IG 貼文模板" };

/**
 * 站上內建的範例模板，一份一個資料夾放在 assets/templates/ 底下，
 * 清單集中由 assets/templates/index.json 管理。路徑用 import.meta.url 推，
 * 站台掛在子目錄底下也對得到。
 */
const BUILTIN_INDEX_URL = new URL("../../../assets/templates/index.json", import.meta.url).href;
const builtinUrl = (dir) => new URL(`../../../assets/templates/${dir}/`, import.meta.url).href;

const FORMATS = [
  { value: "image/jpeg", label: "JPEG（檔案小，發文用）", ext: "jpg" },
  { value: "image/png", label: "PNG（無損，字最利）", ext: "png" },
];

/** 存成檔案。 */
function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 立刻 revoke 有些瀏覽器會抓不到檔案，等一下再放。
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** 檔名用的安全字串。 */
const safeName = (name) => String(name || "ig-post").replace(/[\\/:*?"<>|]+/g, "-").trim() || "ig-post";

export function mount(host) {
  let bundle = null;
  let editor = null;
  let builtinCatalog = [];

  const info = status();
  const warnBox = el("div", { class: "igt-warnings", hidden: true });

  /* ---------------- 模板來源 ---------------- */

  const filePicker = el("input", {
    class: "igt-file", type: "file", accept: ".zip,.json,application/zip,application/json",
  });
  filePicker.addEventListener("change", () => {
    const file = filePicker.files?.[0];
    filePicker.value = "";
    if (file) void openBundle(() => readBundle(file), file.name);
  });

  const dropZone = el("div", {
    class: "igt-drop",
    tabindex: "0",
    role: "button",
    "aria-label": "選擇或拖放模板包",
    // filePicker.click() 會冒泡回這裡，不擋掉就無限遞迴。
    onclick: (e) => { if (e.target !== filePicker) filePicker.click(); },
    onkeydown: (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); filePicker.click(); }
    },
    ondragover: (e) => { e.preventDefault(); dropZone.classList.add("is-over"); },
    ondragleave: () => dropZone.classList.remove("is-over"),
    ondrop: (e) => {
      e.preventDefault();
      dropZone.classList.remove("is-over");
      const file = e.dataTransfer?.files?.[0];
      if (file) void openBundle(() => readBundle(file), file.name);
    },
  },
    el("span", { class: "igt-drop-ico", html: icon("arrowRight", { size: "20px" }) }),
    el("div", {},
      el("div", { class: "igt-drop-title" }, "拖曳或選擇檔案"),
      el("div", { class: "igt-drop-hint" }, ".zip 包含素材；只有版面 .json"),
    ),
    filePicker,
  );
  filePicker.addEventListener("click", (e) => e.stopPropagation());

  const builtinSelect = el("select", {
    class: "tool-input",
    disabled: true,
    onchange: () => {
      const item = builtinCatalog.find((entry) => entry.id === builtinSelect.value);
      if (item) void openBundle(() => loadBuiltin(builtinUrl(item.directory)), item.label);
    },
  }, el("option", { value: "" }, "正在讀取範例模板…"));

  async function loadBuiltinCatalog() {
    try {
      const res = await fetch(BUILTIN_INDEX_URL, { cache: "no-cache" });
      if (!res.ok) throw new Error(`範例模板清單載入失敗 (${res.status})`);
      const data = await res.json();
      if (!Array.isArray(data.templates)) throw new Error("範例模板清單缺少 templates 陣列");

      builtinCatalog = data.templates.filter((item) => (
        item && typeof item.id === "string" && typeof item.label === "string"
        && typeof item.directory === "string" && /^[a-z0-9][a-z0-9_-]*$/i.test(item.directory)
      ));
      if (!builtinCatalog.length) throw new Error("範例模板清單是空的");

      builtinSelect.replaceChildren(
        el("option", { value: "" }, "請選擇範例模板"),
        ...builtinCatalog.map((item) => el("option", { value: item.id }, item.label)),
      );
      builtinSelect.disabled = false;
    } catch (err) {
      builtinSelect.replaceChildren(el("option", { value: "" }, "範例模板清單無法使用"));
      builtinSelect.disabled = true;
      info.set(err.message, "error");
    }
  }

  /* ---------------- 兩個預覽 ---------------- */

  const referenceImg = el("img", { class: "igt-ref-img", alt: "參考成品" });
  const openReference = () => { if (referenceImg.getAttribute("src")) enlarge("參考成品", referenceImg.src); };

  // 參考成品只是拿來對照的，做成一張窄卡片；要看細節就點開放大。
  // 這樣編輯區才吃得到整個內文欄寬 —— 並排兩欄的話兩邊都只剩三百多 px，
  // 在上面直接點文字、拖照片會很難按。
  const refCard = el("div", { class: "igt-ref-card", hidden: true },
    el("button", { class: "igt-ref-btn", type: "button", title: "點一下放大", onclick: openReference },
      referenceImg),
    el("div", { class: "igt-ref-text" },
      el("div", { class: "igt-pane-label" }, "參考成品"),
      el("div", { class: "igt-ref-hint" }, "點擊圖片放大"),
    ),
    button("放大", { iconName: "search", onClick: openReference }),
  );

  const editorHost = el("div", { class: "igt-editor-host" });
  const workPane = el("div", { class: "igt-pane igt-pane-work", hidden: true },
    el("div", { class: "igt-pane-head" },
      el("span", { class: "igt-pane-label" }, "成品預覽"),
      button("放大", { iconName: "search", onClick: () => void zoomResult() }),
    ),
    editorHost,
  );

  /** 點開放大。參考圖與成品走同一個出口，兩邊行為才一致。 */
  function enlarge(title, src, onClose) {
    openModal({
      title,
      body: el("div", { class: "igt-zoom" },
        el("img", { class: "igt-zoom-img", src, alt: title })),
      maxWidth: "min(94vw, 1120px)",
      className: "igt-zoom-modal",
      onClose,
    });
  }

  /** 放大看成品：用乾淨的那一張（沒有空框提示、沒有選取框）。 */
  async function zoomResult() {
    if (!editor) return;
    try {
      const blob = await editor.toBlob({ type: "image/png" });
      const url = URL.createObjectURL(blob);
      enlarge("成品預覽", url, () => URL.revokeObjectURL(url));
    } catch (err) {
      info.set(`放大失敗：${err.message}`, "error");
    }
  }

  /* ---------------- 輸出 ---------------- */

  const formatSelect = el("select", { class: "tool-input" },
    ...FORMATS.map((f) => el("option", { value: f.value }, f.label)));

  const includePhotos = el("input", { class: "tool-check", type: "checkbox", checked: true });

  const exportImage = button("下載成品圖", { variant: "primary", iconName: "arrowRight", onClick: async () => {
    if (!editor) return;
    const format = FORMATS.find((f) => f.value === formatSelect.value) || FORMATS[0];
    try {
      const blob = await editor.toBlob({ type: format.value, quality: 0.92 });
      const side = bundle.template.canvas.size;
      saveBlob(blob, `${safeName(bundle.template.name)}-${side}x${side}.${format.ext}`);
      info.set(`已輸出 ${side} × ${side} 的成品圖。`, "ok");
    } catch (err) {
      info.set(`匯出失敗：${err.message}`, "error");
    }
  } });

  const exportBundleBtn = button("下載模板包", { iconName: "copy", onClick: async () => {
    if (!editor) return;
    try {
      // 順手把現在的成品存成包裡的 preview.jpg —— 下次載入它就是參考成品。
      const preview = await editor.toBlob({ type: "image/jpeg", quality: 0.85 });
      const zip = await writeBundle(bundle, editor.slots, {
        includePhotos: includePhotos.checked,
        preview,
      });
      saveBlob(zip, `${safeName(bundle.template.name)}.zip`);
      info.set(
        `已輸出模板包（${Math.round(zip.size / 1024)} KB）`
        + `${includePhotos.checked ? "，含你放的照片" : "，不含你放的照片"}。`,
        "ok",
      );
    } catch (err) {
      info.set(`匯出失敗：${err.message}`, "error");
    }
  } });

  const exportRow = el("div", { class: "igt-export", hidden: true },
    subhead("輸出"),
    field("圖片格式", formatSelect),
    field("模板包內容", el("label", { class: "tool-flag" },
      includePhotos, el("span", {}, "把我放的照片一起打包"))),
    actions(exportImage, exportBundleBtn),
  );

  /* ---------------- 載入 ---------------- */

  function showWarnings(list) {
    warnBox.replaceChildren();
    warnBox.hidden = !list.length;
    if (!list.length) return;
    warnBox.append(
      el("div", { class: "igt-warn-head" },
        el("span", { class: "igt-warn-ico", html: icon("alert", { size: "14px" }) }),
        `模板有 ${list.length} 個地方要注意`),
      el("ul", { class: "igt-warn-list" }, ...list.map((w) => el("li", {}, w))),
    );
  }

  async function openBundle(loader, sourceName) {
    info.set("載入中…", "ok");
    let next;
    try {
      next = await loader();
    } catch (err) {
      info.set(`無法讀取模板：${err.message}`, "error");
      return;
    }

    // 舊的先收乾淨，不然每載一次就漏掉一批 blob URL。
    editor?.destroy();
    bundle?.dispose();
    bundle = next;

    editor = createEditor({
      bundle,
      onRender: paintStatus,
      onNotify: (message, kind) => info.set(message, kind),
    });
    editorHost.replaceChildren(editor.el);

    const preview = bundle.previewUrl;
    if (preview) referenceImg.src = preview;
    else referenceImg.removeAttribute("src");
    refCard.hidden = !preview;
    workPane.hidden = false;
    exportRow.hidden = false;
    showWarnings(bundle.warnings);

    await editor.ready;
    info.set(
      `已載入「${bundle.template.name}」${sourceName ? `（${sourceName}）` : ""}。`,
      "ok",
    );
  }

  /** 每次重畫之後回報還缺什麼、哪一層爆框。 */
  function paintStatus({ overflow, missing }) {
    const parts = [];
    if (missing.length) parts.push(`還沒放圖：${missing.join("、")}`);
    if (overflow.length) parts.push(`字太多塞不下：${overflow.join("、")}`);
    if (parts.length) info.set(parts.join("　·　"), "warn");
    else info.set("看起來可以了，按「下載成品圖」輸出。", "ok");
  }

  /* ---------------- 組起來 ---------------- */

  host.appendChild(panel(
    subhead("模板"),
    dropZone,
    field("範例模板", builtinSelect),
    info,
    warnBox,
    refCard,
    workPane,
    exportRow,
  ));

  info.set("選擇範例模板或上傳 .zip、.json 模板", "ok");
  void loadBuiltinCatalog();

  return () => {
    editor?.destroy();
    bundle?.dispose();
  };
}
