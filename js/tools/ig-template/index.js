// js/tools/ig-template/index.js — IG 貼文模板。
//
// 載一份標準模板（.zip），照著參考成品把自己的照片與文字直接填在畫布上，
// 輸出成品圖，或把改過的模板再存回一個 .zip。
//
// 全程在瀏覽器裡跑，照片不會上傳到任何地方。

import { panel, field, button, actions, status, subhead, el, icon } from "../kit.js";
import { openModal } from "../../ui/modal.js";
import {
  readBundle, loadBuiltin, writeBundle, bundleFromPptx, bundleFromFiles,
  dropEntries, filesFromEntries, filesFromInput, PREVIEW,
} from "./bundle.js";
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
    class: "igt-file", type: "file",
    accept: ".zip,.pptx,.json,application/zip,application/json,"
      + "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  });
  filePicker.addEventListener("change", () => {
    const file = filePicker.files?.[0];
    filePicker.value = "";
    if (file) void openBundle(() => readBundle(file), file.name);
  });

  // 解壓縮之後的資料夾也要能直接讀 —— 改完 template.json 就不用再壓回去。
  // webkitdirectory 的 input 只選得到資料夾，所以跟檔案那個分開兩顆。
  const folderPicker = el("input", { class: "igt-file", type: "file", webkitdirectory: "", multiple: "" });
  folderPicker.addEventListener("change", async () => {
    const list = [...folderPicker.files || []];
    folderPicker.value = "";
    if (!list.length) return;
    const name = (list[0].webkitRelativePath || "").split("/")[0] || "資料夾";
    void openBundle(async () => bundleFromFiles(await filesFromInput(list), { source: "資料夾" }), name);
  });
  folderPicker.addEventListener("click", (e) => e.stopPropagation());

  const dropZone = el("div", {
    class: "igt-drop",
    tabindex: "0",
    role: "button",
    "aria-label": "選擇或拖放標準模板",
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
      // entry 一定要在 await 之前同步取出來，不然 DataTransfer 就失效了。
      const entries = dropEntries(e.dataTransfer);
      const folders = entries.filter((entry) => entry.isDirectory);
      if (folders.length || entries.length > 1) {
        const name = folders[0]?.name || "拖進來的檔案";
        void openBundle(
          async () => bundleFromFiles(await filesFromEntries(entries), { source: "資料夾" }),
          name,
        );
        return;
      }
      const file = e.dataTransfer?.files?.[0];
      if (file) void openBundle(() => readBundle(file), file.name);
    },
  },
    el("span", { class: "igt-drop-ico", html: icon("arrowRight", { size: "20px" }) }),
    el("div", {},
      el("div", { class: "igt-drop-title" }, "拖曳或選擇檔案"),
      el("div", { class: "igt-drop-hint" },
        "標準模板 .zip、解壓縮後的資料夾，或只有版面的 .json"),
      // 「不知道怎麼從 Canva 匯出」是自己做模板時最大的卡點，
      // 所以把那條選單路徑直接寫在這裡，不要只留在說明文件裡。
      el("div", { class: "igt-drop-hint igt-drop-canva" },
        "Canva 分享 → 下載(建議單個頁面) → PowerPoint (.pptx)，上傳檔案"),
    ),
    filePicker,
    folderPicker,
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

  /* ---------------- 匯入的多頁檔案 ---------------- */

  // .pptx 可能有好幾頁（Canva 的多頁設計、輪播貼文）。一次只做一張，
  // 但要能換 —— 來源檔案留在 bundle.source 上，換頁不用重讀檔。
  const slideSelect = el("select", {
    class: "tool-input",
    onchange: () => {
      const src = bundle?.source;
      if (!src || src.kind !== "pptx") return;
      const next = Number(slideSelect.value);
      void openBundle(() => bundleFromPptx(src.files, { slide: next }));
    },
  });
  const slideRow = el("div", { class: "igt-slides", hidden: true },
    field("頁面", slideSelect));

  function syncSlidePicker() {
    const src = bundle?.source;
    const many = src?.kind === "pptx" && src.slideCount > 1;
    slideRow.hidden = !many;
    if (!many) return;
    slideSelect.replaceChildren(...Array.from({ length: src.slideCount }, (_, i) =>
      el("option", { value: String(i) }, `第 ${i + 1} 頁（共 ${src.slideCount} 頁）`)));
    slideSelect.value = String(src.slide);
  }

  /* ---------------- 兩個預覽 ---------------- */

  const referenceImg = el("img", { class: "igt-ref-img", alt: "參考成品" });
  const openReference = () => { if (referenceImg.getAttribute("src")) enlarge("參考成品", referenceImg.src); };

  // 參考成品只是拿來對照的，做成一張窄卡片；要看細節就點開放大。
  // 這樣編輯區才吃得到整個內文欄寬 —— 並排兩欄的話兩邊都只剩三百多 px，
  // 在上面直接點文字、拖照片會很難按。
  const refCard = el("button", {
    class: "igt-ref-card",
    type: "button",
    title: "點一下放大",
    onclick: openReference,
    hidden: true,
  },
    referenceImg,
    el("div", { class: "igt-ref-text" },
      el("div", { class: "igt-pane-label" }, "參考成品"),
      el("div", { class: "igt-ref-hint" }, "點擊圖片放大"),
    ),
  );

  const editorHost = el("div", { class: "igt-editor-host" });
  const workPane = el("div", { class: "igt-pane igt-pane-work", hidden: true },
    el("div", { class: "igt-pane-head" },
      el("span", { class: "igt-pane-label" }, "成品預覽"),
      button("檢視", { iconName: "search", onClick: () => void zoomResult() }),
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

  /** 放大看成品: 用乾淨的那一張（沒有空框提示、沒有選取框）。 */
  async function zoomResult() {
    if (!editor) return;
    try {
      const blob = await editor.toBlob({ type: "image/png" });
      const url = URL.createObjectURL(blob);
      enlarge("成品預覽", url, () => URL.revokeObjectURL(url));
    } catch (err) {
      info.set(`放大失敗: ${err.message}`, "error");
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
      const { width, height } = bundle.template.canvas;
      saveBlob(blob, `${safeName(bundle.template.name)}-${width}x${height}.${format.ext}`);
      info.set(`已輸出 ${width} × ${height} 的成品圖。`, "ok");
    } catch (err) {
      info.set(`匯出失敗: ${err.message}`, "error");
    }
  } });

  const exportBundleBtn = button("下載標準模板", { iconName: "copy", onClick: async () => {
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
        `已輸出標準模板（${Math.round(zip.size / 1024)} KB）`
        + `${includePhotos.checked ? "，含你放的照片" : "，不含你放的照片"}。`,
        "ok",
      );
    } catch (err) {
      info.set(`匯出失敗: ${err.message}`, "error");
    }
  } });

  const exportRow = el("div", { class: "igt-export", hidden: true },
    subhead("輸出"),
    field("圖片格式", formatSelect),
    field("標準模板內容", el("label", { class: "tool-flag" },
      includePhotos, el("span", {}, "打包我的照片"))),
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
      info.set(`無法讀取模板: ${err.message}`, "error");
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
    // 縮圖的長寬比跟著模板走，直式模板才不會在正方形的框裡上下留一堆空白。
    const { width, height } = bundle.template.canvas;
    referenceImg.style.aspectRatio = `${width} / ${height}`;
    refCard.hidden = !preview;
    workPane.hidden = false;
    exportRow.hidden = false;
    showWarnings(bundle.warnings);

    await editor.ready;
    syncSlidePicker();

    // 匯入來的模板沒有 preview.jpg。拿第一次渲染的結果當參考成品 ——
    // 那就是「原稿的樣子」，之後把照片文字換掉還看得到原本長什麼樣。
    if (!bundle.previewPath) {
      try {
        const shot = await editor.toBlob({ type: "image/jpeg", quality: 0.85 });
        bundle.put(PREVIEW, new Uint8Array(await shot.arrayBuffer()), "image/jpeg");
        bundle.previewPath = PREVIEW;
        bundle.template.preview = PREVIEW;
        referenceImg.src = bundle.previewUrl;
        referenceImg.style.aspectRatio = `${bundle.template.canvas.width} / ${bundle.template.canvas.height}`;
        refCard.hidden = false;
      } catch {
        /* 產不出參考圖不影響編輯，就不顯示那張卡片。 */
      }
    }

    info.set(
      `已載入「${bundle.template.name}」${sourceName ? `（${sourceName}）` : ""}。`,
      "ok",
    );
  }

  /** 每次重畫之後回報還缺什麼、哪一層爆框。 */
  function paintStatus({ overflow, missing }) {
    const parts = [];
    if (missing.length) parts.push(`還沒放圖: ${missing.join("、")}`);
    if (overflow.length) parts.push(`字太多了!!: ${overflow.join("、")}`);
    if (parts.length) info.set(parts.join(" · "), "warn");
    else info.set("看起來可以了，按「下載成品圖」輸出。", "ok");
  }

  /* ---------------- 組起來 ---------------- */

  host.appendChild(panel(
    subhead("模板"),
    dropZone,
    actions(button("選擇已解壓縮的標準模板", { iconName: "grid", onClick: () => folderPicker.click() })),
    field("範例模板", builtinSelect),
    info,
    slideRow,
    warnBox,
    refCard,
    workPane,
    exportRow,
  ));

  info.set("選擇範例模板，或上傳 .zip／.pptx／解壓縮後的資料夾", "ok");
  void loadBuiltinCatalog();

  return () => {
    editor?.destroy();
    bundle?.dispose();
  };
}
