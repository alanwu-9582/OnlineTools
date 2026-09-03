// js/tools/ig-template/editor.js — 直接在畫布上編輯。
//
// 沒有「一層一個控制欄位」的清單了。想改哪裡就點哪裡: 
//   空的照片框  → 點一下開檔案選擇
//   放好的照片  → 拖曳平移，選取後用工具列換圖／縮放
//   文字        → 點一下就地打字
//   被蓋住的層  → 右上角圖層鈕展開清單去選
//
// 做法上的關鍵: canvas 上面疊一層 DOM 覆蓋層，用 transform: scale() 縮到
// 跟顯示尺寸一致。覆蓋層裡面的東西全部用「畫布座標」（1080 那一套）擺，
// 不用到處乘除比例，旋轉過的圖層也能直接把 rotate 套在命中框上。

import { el, icon } from "../kit.js";
import { FONT_FAMILIES, WEIGHTS, MAX_FONT_SIZE, MAX_STROKE_WIDTH } from "./schema.js";
import { renderTemplate, loadImage, exportBlob } from "./render.js";
import { layoutText, clampOffset } from "./layout.js";
import { extForType } from "./bundle.js";
import { rgbPart, alphaOf, withAlpha, withRgb } from "./color.js";

const TYPE_ICON = { photo: "grid", image: "grid", text: "book", rect: "filter" };
const TYPE_NAME = { photo: "照片", image: "素材", text: "文字", rect: "色塊" };

/* ---------------- 主體 ---------------- */

/**
 * @param {{bundle:object, onRender?:Function, onNotify?:Function}} cfg
 * @returns {{el:HTMLElement, slots:Map, canvas:HTMLCanvasElement,
 *            render:Function, toBlob:Function, destroy:Function}}
 */
export function createEditor({ bundle, onRender, onNotify }) {
  const template = bundle.template;
  // 畫布可以是正方形也可以是長方形，所以兩個邊都要各自帶著走。
  const canvasW = template.canvas.width;
  const canvasH = template.canvas.height;
  /** @type {Map<string, {path:string, img:HTMLImageElement, scale:number, dx:number, dy:number}>} */
  const slots = new Map();
  const byId = new Map(template.layers.map((l) => [l.id, l]));

  let selectedId = null;
  let editingId = null;
  let scaleFactor = 1;          // 顯示尺寸 ÷ 畫布尺寸
  let destroyed = false;

  /* ---- DOM ---- */

  const canvas = el("canvas", { class: "ige-canvas", width: canvasW, height: canvasH });
  const ctx = canvas.getContext("2d");

  const overlay = el("div", { class: "ige-overlay" });
  overlay.style.width = `${canvasW}px`;
  overlay.style.height = `${canvasH}px`;

  const toolbar = el("div", { class: "ige-toolbar", hidden: true, role: "toolbar" });
  const layerList = el("div", { class: "ige-layer-list", role: "listbox" });
  const layerPanel = el("div", { class: "ige-layers", hidden: true },
    el("div", { class: "ige-layers-head" }, "圖層（由上到下）"),
    layerList,
  );
  const layerToggle = el("button", {
    class: "ige-layers-toggle",
    type: "button",
    title: "圖層",
    "aria-label": "圖層",
    "aria-expanded": "false",
    onclick: () => toggleLayers(),
  }, el("span", { class: "ige-ico", html: icon("grid", { size: "15px" }) }));

  const stage = el("div", { class: "ige-stage" }, canvas, overlay, layerToggle, layerPanel, toolbar);
  // 舞台的長寬比由模板決定，不能寫死在 CSS 裡 —— 寫死的話直式模板會被
  // 壓成正方形，命中框的位置就跟畫出來的東西對不上了。
  stage.style.aspectRatio = `${canvasW} / ${canvasH}`;
  const root = el("div", { class: "ige-editor" }, stage);

  // 檔案選擇器共用一個，用完把 value 清掉，同一個檔案才選得了第二次。
  const filePicker = el("input", { class: "ige-file", type: "file", accept: "image/*" });
  let pendingLayer = null;
  filePicker.addEventListener("change", () => {
    const file = filePicker.files?.[0];
    const layer = pendingLayer;
    filePicker.value = "";
    pendingLayer = null;
    if (file && layer) void putImage(layer, file);
  });
  root.appendChild(filePicker);

  /* ---- 命中框 ---- */

  const hits = new Map();
  for (const layer of template.layers) {
    // DOM 順序 = 疊放順序，跟 canvas 的畫法一致，所以最上層自然接到點擊。
    const hit = el("button", {
      class: `ige-hit ige-hit-${layer.type}`,
      type: "button",
      dataset: { id: layer.id },
      "aria-label": `${TYPE_NAME[layer.type]}: ${layer.label}`,
    });
    const { x, y, w, h } = layer.rect;
    Object.assign(hit.style, {
      left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`,
      borderRadius: layer.radius ? `${layer.radius}px` : "",
      transform: layer.rotate ? `rotate(${layer.rotate}deg)` : "",
    });
    // 鎖住的圖層（背景色塊、裝飾）在畫布上點不到，免得擋住底下真正要編輯的
    // 東西；要改它們就從圖層面板選。
    if (layer.locked) hit.classList.add("is-locked");
    hits.set(layer.id, hit);
    overlay.appendChild(hit);
  }

  /* ---- 縮放同步 ---- */

  function syncScale() {
    const width = canvas.clientWidth || stage.clientWidth || canvasW;
    // 舞台的 aspect-ratio 跟畫布一致，所以只用寬度算比例就夠，
    // 橫向與縱向永遠是同一個縮放值（不會把圖拉變形）。
    scaleFactor = width / canvasW;
    overlay.style.transform = `scale(${scaleFactor})`;
    if (selectedId) placeToolbar();
  }
  const resizeObserver = new ResizeObserver(syncScale);
  resizeObserver.observe(stage);

  // 保險：萬一瀏覽器不吃 overflow: clip，退回 hidden 之後還是捲得動。
  // 一被捲走就拉回原位，成品預覽永遠對齊舞台。
  stage.addEventListener("scroll", () => {
    if (stage.scrollLeft || stage.scrollTop) { stage.scrollLeft = 0; stage.scrollTop = 0; }
  });

  /* ---- 繪製 ---- */

  function render() {
    if (destroyed) return;
    const result = renderTemplate(ctx, template, {
      slots,
      placeholders: true,
      hideText: editingId ? new Set([editingId]) : null,
    });
    syncEmptyMarks();
    onRender?.(result);
    return result;
  }

  /** 哪些圖槽還是空的。拖曳時每一格都會跑到，所以只切 class 不重建 DOM。 */
  function syncEmptyMarks() {
    for (const [id, hit] of hits) {
      const layer = byId.get(id);
      const empty = (layer.type === "photo" || layer.type === "image") && !slots.has(id);
      hit.classList.toggle("is-empty", empty);
      const row = layerList.querySelector(`[data-id="${CSS.escape(id)}"]`);
      if (row) {
        row.classList.toggle("is-empty", empty);
        row.querySelector(".ige-layer-kind").textContent = empty ? "未填" : TYPE_NAME[layer.type];
      }
    }
  }

  /* ---- 圖片 ---- */

  async function putImage(layer, file) {
    if (!file.type.startsWith("image/")) {
      onNotify?.("這不是圖片檔。", "error");
      return;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const dir = layer.type === "photo" ? "photos/" : "assets/";
      const path = `${dir}${layer.id}.${extForType(file.type)}`;
      const url = bundle.put(path, bytes, file.type);
      const img = await loadImage(url);
      // 換圖等於重來，縮放與位移歸零 —— 沿用上一張的位移幾乎一定是錯的。
      slots.set(layer.id, { path, img, scale: 1, dx: 0, dy: 0 });
      render();
      select(layer.id);
      onNotify?.(`已放上「${layer.label}」。拖曳可以調整位置。`, "ok");
    } catch (err) {
      onNotify?.(`圖片讀不進來: ${err.message}`, "error");
    }
  }

  function pickImage(layer) {
    pendingLayer = layer;
    filePicker.click();
  }

  function clearImage(layer) {
    slots.delete(layer.id);
    layer.src = "";
    render();
    buildToolbar();
  }

  /* ---- 選取 ---- */

  function select(id) {
    if (editingId && editingId !== id) commitText();
    selectedId = id;
    for (const [key, hit] of hits) hit.classList.toggle("is-selected", key === id);
    for (const row of layerList.children) row.classList.toggle("is-active", row.dataset.id === id);
    buildToolbar();
  }

  function deselect() {
    if (editingId) commitText();
    selectedId = null;
    for (const hit of hits.values()) hit.classList.remove("is-selected");
    for (const row of layerList.children) row.classList.remove("is-active");
    toolbar.hidden = true;
  }

  /* ---- 工具列 ---- */

  function placeToolbar() {
    if (toolbar.hidden || !selectedId) return;
    const hit = hits.get(selectedId);
    const stageBox = stage.getBoundingClientRect();
    // 用命中框自己的 bounding rect —— 它已經套過 rotate，旋轉後的外框
    // 直接就是對的，不用自己算四個角。
    const box = hit.getBoundingClientRect();
    const top = box.top - stageBox.top;
    const left = box.left - stageBox.left + box.width / 2;

    toolbar.style.visibility = "hidden";
    toolbar.style.left = "0px";
    toolbar.style.top = "0px";
    const tw = toolbar.offsetWidth;
    const th = toolbar.offsetHeight;

    // 預設放在元素上方；上面塞不下就翻到下方，兩邊都不行就貼在畫布頂端。
    let ty = top - th - 8;
    if (ty < 4) ty = box.bottom - stageBox.top + 8;
    if (ty + th > stageBox.height - 4) ty = 4;
    const tx = Math.min(Math.max(left - tw / 2, 4), stageBox.width - tw - 4);

    toolbar.style.left = `${Math.round(tx)}px`;
    toolbar.style.top = `${Math.round(ty)}px`;
    toolbar.style.visibility = "";
  }

  function tbGroup(label, ...children) {
    return el("div", { class: "ige-tb-group" },
      label ? el("span", { class: "ige-tb-label" }, label) : null, ...children);
  }

  function tbButton(label, onClick, { iconName, active } = {}) {
    return el("button", {
      class: `ige-tb-btn${active ? " is-active" : ""}`,
      type: "button",
      onclick: onClick,
      title: label,
    }, iconName ? el("span", { class: "ige-ico", html: icon(iconName, { size: "14px" }) }) : label);
  }

  /**
   * 色票 + 透明度。
   *
   * <input type="color"> 只吃 6 位 hex，塞 8 位進去透明度會被丟掉，
   * 所以透明度另外用一個 0–100 的欄位，兩邊合成回 #RRGGBBAA。
   *
   * @param {string} value    目前的顏色（任何 CSS 寫法都行）
   * @param {(hex:string)=>void} onPick  收到的一律是正規化過的 hex
   */
  function tbColor(value, onPick, label) {
    let current = value;
    const swatch = el("input", {
      class: "ige-tb-color", type: "color", value: rgbPart(current),
      title: `${label}`, "aria-label": label,
    });
    const alpha = el("input", {
      class: "ige-tb-num ige-tb-alpha", type: "number", min: "0", max: "100", step: "1",
      value: String(Math.round(alphaOf(current) * 100)),
      title: `${label}的不透明度（%）`, "aria-label": `${label}的不透明度`,
    });
    const push = (next) => { current = next; onPick(next); render(); };
    swatch.addEventListener("input", () => push(withRgb(current, swatch.value)));
    alpha.addEventListener("input", () => {
      const v = Number(alpha.value);
      if (!Number.isFinite(v) || v < 0 || v > 100) return;
      push(withAlpha(current, v / 100));
    });
    // 兩個欄位是一組，包在一起才不會被 flex 換行拆開。
    return el("span", { class: "ige-tb-colorset" }, swatch, alpha);
  }

  function buildToolbar() {
    toolbar.replaceChildren();
    if (!selectedId) { toolbar.hidden = true; return; }
    const layer = byId.get(selectedId);
    toolbar.appendChild(el("span", { class: "ige-tb-name" }, layer.label));

    // 設計鎖: 內容還是能改（文字照打、照片照換），但決定「長相」的東西
    // 一律不放上來 —— 與其做成禁用的灰色欄位，不如根本不出現，
    // 使用者才不會一直去點一個點不動的東西。
    const locked = layer.lockDesign;
    if (locked) {
      // 只放一把鎖。說明留在 title 與 aria-label 裡 —— 工具列很窄，
      // 一行字會把真正的控制項擠掉，而少了哪些控制項本來就看得出來。
      const why = layer.type === "text" ? "這一層的設計由模板鎖定，只能改文字"
        : layer.type === "rect" ? "這一層的設計由模板鎖定"
          : "這一層的設計由模板鎖定，只能換圖";
      toolbar.appendChild(el("span", {
        class: "ige-tb-lock", title: why, role: "img", "aria-label": why,
        html: icon("lock", { size: "14px" }),
      }));
    }

    if (layer.type === "text") {
      const fontFamilies = [
        ...bundle.fonts.map(({ value, label }) => ({ value, label: `${label} (模板)` })),
        ...FONT_FAMILIES,
      ];
      // 比對只看第一個字族名，不看後面的備援串。匯入的圖層寫的是
      // `"Roboto", sans-serif`，模板字型註冊的是 `"Roboto"` —— 逐字比的話
      // 會被當成兩種字型，下拉選單就會多出一個醜的重複項。
      const primary = (css) => String(css).split(",")[0].trim().replace(/^["']|["']$/g, "").toLowerCase();
      const want = primary(layer.font.family);
      const match = fontFamilies.find((font) => primary(font.value) === want);
      if (!match) {
        fontFamilies.unshift({ value: layer.font.family, label: `${layer.font.family}（模板指定）` });
      }
      const fontSel = el("select", { class: "ige-tb-select", title: "字型", "aria-label": "字型" },
        ...fontFamilies.map((f) => el("option", { value: f.value }, f.label)));
      fontSel.value = match ? match.value : layer.font.family;
      fontSel.addEventListener("change", () => {
        layer.font.family = fontSel.value; render(); syncInlineStyle();
      });

      const sizeInput = el("input", {
        class: "ige-tb-num", type: "number", min: "6", max: String(MAX_FONT_SIZE), step: "1",
        value: String(Math.round(layer.font.size)), title: "字級", "aria-label": "字級",
      });
      sizeInput.addEventListener("input", () => {
        const v = Number(sizeInput.value);
        if (Number.isFinite(v) && v >= 6 && v <= MAX_FONT_SIZE) {
          layer.font.size = v; render(); syncInlineStyle();
        }
      });

      const weightSel = el("select", { class: "ige-tb-select", title: "粗細", "aria-label": "粗細" },
        ...WEIGHTS.map((w) => el("option", { value: w.value }, w.label)));
      weightSel.value = String(layer.font.weight);
      if (weightSel.value !== String(layer.font.weight)) {
        // 模板寫了清單裡沒有的字重（例如 600），補一個選項，不然會顯示成別的值。
        weightSel.prepend(el("option", { value: String(layer.font.weight) }, `${layer.font.weight}`));
        weightSel.value = String(layer.font.weight);
      }
      weightSel.addEventListener("change", () => {
        layer.font.weight = Number(weightSel.value); render(); syncInlineStyle();
      });

      const alignGroup = el("div", { class: "ige-tb-seg" },
        ...[["left", "靠左"], ["center", "置中"], ["right", "靠右"]].map(([value, name]) =>
          tbButton(name, () => {
            layer.align = value; render(); syncInlineStyle(); buildToolbar();
          }, { active: layer.align === value })));

      // 文字外框。粗細填 0 就是關掉 —— 這樣不用另外做一個開關。
      const strokeWidth = el("input", {
        class: "ige-tb-num", type: "number", min: "0", max: String(MAX_STROKE_WIDTH), step: "0.5",
        value: String(layer.stroke ? layer.stroke.width : 0),
        title: "外框粗細（0 = 不描邊）", "aria-label": "外框粗細",
      });
      const applyStroke = (width, color) => {
        if (width > 0) layer.stroke = { color, width };
        else delete layer.stroke;
        render();
        syncInlineStyle();
      };
      strokeWidth.addEventListener("input", () => {
        const v = Number(strokeWidth.value);
        if (!Number.isFinite(v) || v < 0 || v > MAX_STROKE_WIDTH) return;
        applyStroke(v, layer.stroke?.color || "#ffffff");
      });
      const strokeColor = tbColor(layer.stroke?.color || "#ffffff",
        (hex) => applyStroke(layer.stroke?.width || Number(strokeWidth.value) || 0, hex), "外框");

      if (!locked) {
        toolbar.append(
          tbGroup("", fontSel),
          tbGroup("", sizeInput),
          tbGroup("", weightSel),
          tbGroup("", tbColor(layer.color, (hex) => { layer.color = hex; syncInlineStyle(); }, "文字")),
          tbGroup("", alignGroup),
          tbGroup("外框", strokeColor, strokeWidth),
        );
      }
    } else if (layer.type === "photo" || layer.type === "image") {
      const has = slots.has(layer.id);
      toolbar.append(tbGroup("", tbButton(has ? "換圖" : "上傳", () => pickImage(layer))));

      if (has) {
        const state = slots.get(layer.id);
        const zoom = el("input", {
          class: "ige-tb-range", type: "range", min: "100", max: "400", step: "1",
          value: String(Math.round(state.scale * 100)), title: "縮放", "aria-label": "縮放",
        });
        zoom.addEventListener("input", () => {
          state.scale = Number(zoom.value) / 100;
          // 縮小之後原本的位移可能讓框邊露出底色，重新夾一次。
          const fixed = clampOffset({
            imgW: state.img.naturalWidth, imgH: state.img.naturalHeight,
            box: layer.rect, fit: layer.fit, scale: state.scale, dx: state.dx, dy: state.dy,
          });
          state.dx = fixed.dx; state.dy = fixed.dy;
          render();
        });
        // 照片沒有「顏色」可以調透明度，所以給圖層本身的不透明度。
        const opacity = el("input", {
          class: "ige-tb-num ige-tb-alpha", type: "number", min: "0", max: "100", step: "1",
          value: String(Math.round(layer.opacity * 100)),
          title: "不透明度（%）", "aria-label": "不透明度",
        });
        opacity.addEventListener("input", () => {
          const v = Number(opacity.value);
          if (!Number.isFinite(v) || v < 0 || v > 100) return;
          layer.opacity = v / 100;
          render();
        });

        // 縮放與置中留著 —— 換了新照片總得把它擺進框裡，那是內容不是設計。
        toolbar.append(tbGroup("縮放", zoom));
        if (!locked) toolbar.append(tbGroup("透明", opacity));
        toolbar.append(
          tbGroup("", tbButton("置中", () => {
            state.scale = 1; state.dx = 0; state.dy = 0; render(); buildToolbar();
          })),
          tbGroup("", tbButton("移除", () => clearImage(layer))),
        );
      }
    } else if (layer.type === "rect" && !locked) {
      // 色塊沒有「內容」可言，整層都是設計，所以鎖住就什麼都不放。
      if (layer.gradient) {
        toolbar.append(
          tbGroup("起", tbColor(layer.gradient.from,
            (hex) => { layer.gradient.from = hex; }, "漸層起點")),
          tbGroup("迄", tbColor(layer.gradient.to,
            (hex) => { layer.gradient.to = hex; }, "漸層終點")),
        );
      } else {
        toolbar.append(tbGroup("", tbColor(layer.color,
          (hex) => { layer.color = hex; }, "顏色")));
      }
    }

    toolbar.hidden = false;
    placeToolbar();
  }

  /* ---- 文字的行內編輯 ---- */

  let inlineBox = null;

  function syncInlineStyle() {
    if (!inlineBox || !editingId) return;
    const layer = byId.get(editingId);
    const { x, y, w, h } = layer.rect;
    // 用 canvas 那邊算出來的結果來擺輸入框，autoShrink 縮字、垂直對齊
    // 才會跟成品一致 —— 不然打完字一放開位置會整個跳掉。
    const laid = layoutText(ctx, { ...layer, text: inlineBox.value });
    const total = Math.max(laid.size * layer.font.lineHeight, laid.total);
    const top = layer.valign === "middle" ? y + (h - total) / 2
      : layer.valign === "bottom" ? y + h - total
        : y;

    Object.assign(inlineBox.style, {
      left: `${x}px`,
      top: `${Math.round(top)}px`,
      width: `${w}px`,
      height: `${Math.max(total, laid.size * layer.font.lineHeight)}px`,
      fontFamily: layer.font.family,
      fontSize: `${laid.size}px`,
      fontWeight: String(layer.font.weight),
      lineHeight: String(layer.font.lineHeight),
      letterSpacing: `${layer.font.letterSpacing || 0}px`,
      color: layer.color,
      // 讓行內輸入框也帶上外框，打字時看到的跟放開之後一致。
      WebkitTextStrokeWidth: layer.stroke ? `${layer.stroke.width}px` : "",
      WebkitTextStrokeColor: layer.stroke ? layer.stroke.color : "",
      textAlign: layer.align,
      transform: layer.rotate ? `rotate(${layer.rotate}deg)` : "",
      // 旋轉的基準要對齊 canvas: canvas 是繞 rect 中心轉，這裡的框卻是
      // 從 top 開始量，所以把原點挪到 rect 中心相對於框的位置。
      transformOrigin: layer.rotate ? `${w / 2}px ${y + h / 2 - top}px` : "",
    });
  }

  function startTextEdit(layer) {
    if (editingId === layer.id) return;
    if (editingId) commitText();
    editingId = layer.id;
    selectedId = layer.id;

    inlineBox = el("textarea", { class: "ige-inline", spellcheck: "false" });
    inlineBox.value = layer.text;
    inlineBox.addEventListener("input", () => {
      layer.text = inlineBox.value;
      render();
      syncInlineStyle();
    });
    inlineBox.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); commitText(); }
      // Enter 要能換行（多行標題是常態），所以用 Ctrl/Cmd + Enter 結束。
      else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commitText(); }
      e.stopPropagation();
    });
    inlineBox.addEventListener("blur", () => commitText());

    overlay.appendChild(inlineBox);
    hits.get(layer.id).classList.add("is-editing");
    render();
    syncInlineStyle();
    inlineBox.focus();
    inlineBox.setSelectionRange(inlineBox.value.length, inlineBox.value.length);
    buildToolbar();
  }

  function commitText() {
    if (!editingId) return;
    const layer = byId.get(editingId);
    if (inlineBox) {
      layer.text = inlineBox.value;
      inlineBox.remove();
      inlineBox = null;
    }
    hits.get(editingId)?.classList.remove("is-editing");
    editingId = null;
    render();
    placeToolbar();
  }

  /* ---- 指標: 點一下 vs 拖曳 ---- */

  const DRAG_SLOP = 4;   // px，超過這個距離才算拖曳而不是點擊

  overlay.addEventListener("pointerdown", (e) => {
    const hit = e.target.closest(".ige-hit");
    if (!hit) return;
    const layer = byId.get(hit.dataset.id);
    if (!layer) return;

    const state = slots.get(layer.id);
    const draggable = state && (layer.type === "photo" || layer.type === "image");
    let moved = false;
    const start = { x: e.clientX, y: e.clientY, dx: state?.dx ?? 0, dy: state?.dy ?? 0 };

    const onMove = (ev) => {
      const mx = ev.clientX - start.x;
      const my = ev.clientY - start.y;
      if (!moved && Math.hypot(mx, my) < DRAG_SLOP) return;
      if (!draggable) return;
      if (!moved) { moved = true; select(layer.id); stage.classList.add("is-dragging"); }
      // 螢幕位移換回畫布座標。
      state.dx = start.dx + mx / scaleFactor;
      state.dy = start.dy + my / scaleFactor;
      const fixed = clampOffset({
        imgW: state.img.naturalWidth, imgH: state.img.naturalHeight,
        box: layer.rect, fit: layer.fit, scale: state.scale, dx: state.dx, dy: state.dy,
      });
      state.dx = fixed.dx; state.dy = fixed.dy;
      render();
    };

    const onUp = () => {
      hit.removeEventListener("pointermove", onMove);
      hit.removeEventListener("pointerup", onUp);
      hit.removeEventListener("pointercancel", onUp);
      stage.classList.remove("is-dragging");
      if (moved) return;                       // 拖過了就不當成點擊
      activate(layer);
    };

    // 抓住指標，拖到框外面也還收得到 move。合成事件的 pointerId 可能不是
    // 真的作用中的指標，那會丟 NotFoundError，不能讓它中斷後面的註冊。
    try { hit.setPointerCapture?.(e.pointerId); } catch { /* 沒抓到就算了，照樣能拖 */ }
    hit.addEventListener("pointermove", onMove);
    hit.addEventListener("pointerup", onUp);
    hit.addEventListener("pointercancel", onUp);
  });

  /** 點下去（或鍵盤 Enter）之後真正發生的事。 */
  function activate(layer) {
    select(layer.id);
    if (layer.type === "text") startTextEdit(layer);
    else if ((layer.type === "photo" || layer.type === "image") && !slots.has(layer.id)) {
      pickImage(layer);            // 空的框直接開檔案選擇，少一次點擊
    }
  }

  // 鍵盤操作: 命中框是 <button>，Enter / Space 會發 click。
  overlay.addEventListener("click", (e) => {
    const hit = e.target.closest(".ige-hit");
    if (!hit || e.detail !== 0) return;        // detail 0 = 鍵盤觸發
    const layer = byId.get(hit.dataset.id);
    if (layer) activate(layer);
  });

  // 覆蓋層本身不吃事件，所以沒有命中框的地方會直接落在 canvas 上 —— 當作取消選取。
  canvas.addEventListener("pointerdown", () => deselect());

  // 點畫布以外的地方就收工具列。
  const onDocPointerDown = (e) => {
    if (!root.contains(e.target)) deselect();
  };
  document.addEventListener("pointerdown", onDocPointerDown);

  const onKeydown = (e) => {
    if (e.key === "Escape" && !editingId && selectedId) deselect();
  };
  document.addEventListener("keydown", onKeydown);

  /* ---- 圖層面板 ---- */

  function toggleLayers(force) {
    const open = force ?? layerPanel.hidden;
    layerPanel.hidden = !open;
    layerToggle.setAttribute("aria-expanded", String(open));
    layerToggle.classList.toggle("is-open", open);
  }

  function buildLayerList() {
    layerList.replaceChildren();
    // 由上到下 —— 使用者看到的疊放順序，跟 layers 陣列相反。
    for (const layer of [...template.layers].reverse()) {
      const empty = (layer.type === "photo" || layer.type === "image") && !slots.has(layer.id);
      const row = el("button", {
        class: "ige-layer-row",
        type: "button",
        dataset: { id: layer.id },
        onclick: () => {
          toggleLayers(false);
          activate(layer);
          // 文字層 activate 之後焦點在行內輸入框上，再 focus 命中框會把它踢掉。
          if (layer.type !== "text") hits.get(layer.id)?.focus({ preventScroll: true });
        },
      },
        el("span", { class: "ige-ico", html: icon(TYPE_ICON[layer.type], { size: "14px" }) }),
        el("span", { class: "ige-layer-name" }, layer.label),
        el("span", { class: "ige-layer-kind" }, empty ? "未填" : TYPE_NAME[layer.type]),
      );
      // 設計鎖在清單上也標一下，不然使用者只會覺得工具列「怎麼少東西」。
      if (layer.lockDesign) {
        row.classList.add("is-design-locked");
        row.title = "這一層的設計由模板鎖定，只能改內容";
        // 清單上同樣只放圖示，跟工具列一致。
        row.insertBefore(
          el("span", { class: "ige-layer-lock", html: icon("lock", { size: "12px" }) }),
          row.querySelector(".ige-layer-kind"),
        );
      }
      if (empty) row.classList.add("is-empty");
      if (layer.id === selectedId) row.classList.add("is-active");
      layerList.appendChild(row);
    }
  }

  /* ---- 匯出 ---- */

  /**
   * 畫一張沒有提示框、沒有選取框的乾淨成品。
   * 畫完會把預覽狀態畫回去，不然畫面上的照片框提示會消失。
   */
  async function toBlob({ type = "image/jpeg", quality = 0.92 } = {}) {
    if (editingId) commitText();
    renderTemplate(ctx, template, { slots, placeholders: false });
    try {
      return await exportBlob(canvas, { type, quality });
    } finally {
      render();
    }
  }

  /* ---- 起手式 ---- */

  async function init() {
    // 字型沒載完就量字寬，換行會全部算錯。
    if (document.fonts?.ready) { try { await document.fonts.ready; } catch { /* 不擋流程 */ } }

    await Promise.all(template.layers.map(async (layer) => {
      if (layer.type !== "photo" && layer.type !== "image") return;
      const url = bundle.resolve(layer.src);
      if (!url) return;
      try {
        const img = await loadImage(url);
        slots.set(layer.id, {
          path: layer.src, img, scale: layer.scale, dx: layer.dx, dy: layer.dy,
        });
      } catch {
        onNotify?.(`「${layer.label}」的圖載不進來。`, "warn");
      }
    }));

    if (destroyed) return;
    syncScale();
    render();
    buildLayerList();
  }

  const ready = init();

  function destroy() {
    destroyed = true;
    resizeObserver.disconnect();
    document.removeEventListener("pointerdown", onDocPointerDown);
    document.removeEventListener("keydown", onKeydown);
    inlineBox?.remove();
  }

  return {
    el: root,
    canvas,
    slots,
    ready,
    render: () => { render(); buildLayerList(); },
    toBlob,
    destroy,
  };
}
