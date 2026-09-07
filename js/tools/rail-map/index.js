// js/tools/rail-map/index.js — 臺灣鐵路路網圖。
//
// 臺鐵、高鐵, 加上臺北、新北、桃園、臺中、高雄的捷運與輕軌, 畫在同一張圖上。
//
// 整張圖是從 OpenStreetMap 的資料算出來的, 沒有人手工擺過任何一個節點:
// 車站的位置、屬於哪條線、排第幾站全部來自資料。所以捷運通車、臺鐵加開新站
// 的時候, 重跑一次 tools/build-rail.mjs 就好, 或者使用者自己按「線上更新」。

import { panel, row, field, segmented, button, textInput, status, note, el, icon } from "../kit.js";
import { downloadSvg } from "../svg.js";
import { notify } from "../../ui/notifications.js";
import { loadInitial, fetchLive, writeCache } from "./source.js";
import {
  fitTransform, boundsOf, topologizeNetwork, placeLabels, toWorld, stationGroupNames,
} from "./layout.js";
import { drawMap, drawLabels, standalone, MAJOR_PRIORITY } from "./render.js";

export const styles = new URL("./rail-map.css", import.meta.url).href;

export const meta = { title: "臺灣鐵路路網圖" };

/** 地區快捷鍵。值是該地區會用到的系統, 用來決定要把畫面框在哪裡。 */
const REGIONS = [
  { id: "all", label: "全臺", systems: [] },
  // 臺北不含桃園: 機場捷運一路拉到中壢, 框進來的話臺北市區會被壓成一小團。
  { id: "taipei", label: "臺北", systems: ["trtc", "ntmc"] },
  { id: "taoyuan", label: "桃園", systems: ["tymc"] },
  { id: "taichung", label: "臺中", systems: ["tmrt"] },
  { id: "kaohsiung", label: "高雄", systems: ["krtc"] },
];

/**
 * 縮放的上下限, 單位是「每公尺幾個畫素」。
 *
 * 下限大約是整個臺灣縮到 150 px 高, 再小就沒有東西看得清楚；
 * 上限是 1 公里 400 px, 大概是一個站區的尺度, 再放大只會看到兩個點。
 */
const MIN_SCALE = 0.0004;
const MAX_SCALE = 0.4;

/**
 * 縮放級距對應到「優先度多少以上的車站才貼標籤」。
 *
 * 全圖的時候只留 15 分以上, 也就是等級 3 的那批大站（臺北、桃園、高雄、板橋…）——
 * 一個標籤都不貼會看不出自己在看哪裡, 全部貼上去則整個西部走廊會糊掉。
 * 優先度的算法在 render.js: 車站等級 ×5, 多一條交會的線 +2, 是轉乘站再 +2。
 */
const LABEL_CUTOFF = [15, 10, 5, 0];
const MIN_LABEL_GRADE = [3, 2, 1, 0];

export async function mount(host) {
  /* ---------- 狀態 ---------- */
  let network = null;
  let visible = new Set();
  let view = { scale: 1, tx: 0, ty: 0 };
  let focusLine = null;
  let selected = null;
  let frame = 0;
  let aborter = null;
  let currentRegion = REGIONS[0];
  let stationById = new Map();
  let transferByStation = new Map();
  // 使用者自己拖過、縮過之後, 就不要再因為視窗大小改變把畫面拉回去。
  let userMoved = false;

  /* ---------- 版面 ---------- */
  const stage = el("div", { class: "railmap-stage", tabindex: "0" });
  const legend = el("div", { class: "railmap-legend", hidden: true });
  const detail = el("div", { class: "railmap-detail", hidden: true });
  const info = status();

  const searchInput = textInput({ placeholder: "找車站…", onInput: onSearch });
  const results = el("div", { class: "railmap-results", hidden: true });

  const regionTabs = segmented(REGIONS.map((r) => ({ value: r.id, label: r.label })), {
    value: "all",
    onChange: (id) => focusRegion(REGIONS.find((r) => r.id === id)),
  });
  // 五個地區在窄畫面會被擠成一個字一行, 改成整排橫向捲。
  regionTabs.classList.add("railmap-regions");

  const legendToggle = el("button", {
    type: "button",
    class: "railmap-legend-toggle",
    title: "路線清單",
    "aria-label": "路線清單",
    onclick: () => { legend.hidden = !legend.hidden; },
  }, el("span", { html: icon("grid", { size: "14px" }) }));

  const zoomIn = el("button", { type: "button", class: "railmap-zoom", title: "放大", onclick: () => zoomBy(1.4) }, "＋");
  const zoomOut = el("button", { type: "button", class: "railmap-zoom", title: "縮小", onclick: () => zoomBy(1 / 1.4) }, "－");

  const updateButton = button("線上更新", { variant: "ghost", onClick: refresh });
  const downloadButton = button("下載 SVG", { variant: "ghost", onClick: () => {
    const svg = stage.querySelector("svg");
    if (!svg) { notify.warning("圖還沒畫出來。"); return; }
    downloadSvg(standalone(svg, stage), "taiwan-rail-map.svg");
  } });

  host.appendChild(panel(
    row(
      field("地區", regionTabs),
      field("搜尋", el("div", { class: "railmap-search" }, searchInput, results)),
    ),
    el("div", { class: "railmap-frame" },
      stage,
      el("div", { class: "railmap-controls" }, legendToggle, zoomIn, zoomOut),
      legend,
      detail,
    ),
    info,
    el("div", { class: "tool-actions" }, updateButton, downloadButton),
    note(
      "資料來自 ",
      el("a", { href: "https://www.openstreetmap.org/copyright", target: "_blank", rel: "noopener" }, "OpenStreetMap"),
      "（ODbL）。車站保留地理上的相對方位, 線段以拓撲方式簡化；新開的車站標進 OSM 後會自動出現。",
    ),
  ));

  /* ---------- 尺寸 ---------- */
  const measure = () => ({
    width: Math.max(320, stage.clientWidth || 640),
    height: Math.max(280, stage.clientHeight || 480),
  });

  const observer = new ResizeObserver(() => {
    // 剛掛上去時 stage 可能還沒有寬度, 第一次量到的比例是錯的；
    // 只要使用者還沒動過, 就照新的尺寸重新框一次。
    if (userMoved) schedule();
    else focusRegion(currentRegion);
  });
  observer.observe(stage);

  /* ---------- 畫 ---------- */

  /**
   * 排一次重畫。拖曳與滾輪會連續觸發, 用 rAF 併成一次。
   *
   * 後面那個 setTimeout 是保險。requestAnimationFrame 在視窗最小化、或工具被
   * 放在不繪製的容器裡時可能一次都不會被呼叫, `frame` 就會一直卡著非 0 值, 
   * 之後每一次 schedule() 都會被開頭那個 guard 擋掉 —— 整張圖從此不再更新。
   * 兩條路徑都會先把 frame 清成 0, 所以只會畫一次。
   */
  function schedule() {
    if (frame) return;
    const run = () => {
      if (!frame) return;
      frame = 0;
      paint();
    };
    frame = requestAnimationFrame(run);
    setTimeout(run, 120);
  }

  function paint() {
    if (!network) return;
    const { width, height } = measure();

    const { root, marks, obstacles, size } = drawMap({
      network, view, width, height, visible, focusLine, selected,
    });

    const cutoff = LABEL_CUTOFF[size.label];
    if (Number.isFinite(cutoff)) {
      const wanted = marks.filter(
        (mark) => mark.grade >= MIN_LABEL_GRADE[size.label] && mark.priority >= cutoff,
      );
      const placed = placeLabels(wanted, {
        width, height, fontSize: size.font, obstacles, majorPriority: MAJOR_PRIORITY,
      });
      drawLabels(root, placed, size.font);
    }
    root.addEventListener("click", onPick);
    stage.replaceChildren(root);
  }

  /* ---------- 互動 ---------- */

  function onPick(event) {
    const node = event.target.closest("[data-station]");
    if (node) { select(stationById.get(node.dataset.station)); return; }
    const lineNode = event.target.closest("[data-line]");
    if (lineNode) { setFocus(focusLine === lineNode.dataset.line ? null : lineNode.dataset.line); return; }
    select(null);
  }

  function select(station) {
    const group = station ? stationGroup(station) : [];
    const head = group.length ? groupHead(group) : null;
    selected = head;
    if (!station) { detail.hidden = true; paint(); return; }

    const lines = [...new Set(group.flatMap((member) => member.lines))]
      .map((id) => network.lines.find((line) => line.id === id))
      .filter(Boolean);
    const codes = [...new Set(group.flatMap((member) => member.codes))];
    const nameEn = group.map((member) => member.nameEn).find(Boolean) || "";
    const displayName = stationGroupNames(group, head).join("／");

    // 用陣列再濾掉空的, 不能直接把 null 丟給 replaceChildren ——
    // 它會把 null 轉成字串, 畫面上就會多出一個「null」。el() 才會自己略過。
    detail.replaceChildren(...[
      el("button", {
        type: "button", class: "railmap-detail-close", "aria-label": "關閉",
        onclick: () => select(null),
      }, el("span", { html: icon("x", { size: "13px" }) })),
      el("div", { class: "railmap-detail-name" }, displayName),
      nameEn ? el("div", { class: "railmap-detail-en" }, nameEn) : null,
      codes.length
        ? el("div", { class: "railmap-detail-codes" },
          codes.map((code) => el("span", { class: "railmap-code" }, code)))
        : null,
      el("div", { class: "railmap-detail-lines" }, lines.map((line) => el("button", {
        type: "button",
        class: "railmap-detail-line",
        onclick: () => setFocus(focusLine === line.id ? null : line.id),
      },
        el("span", { class: "railmap-swatch", style: `background:${line.colour}` }),
        line.name,
      ))),
      group.length > 1
        ? el("div", { class: "railmap-detail-transfer" },
          `整合站體：${group.map((member) => `${systemName(member.system)} ${member.name}`).join("、")}`)
        : null,
    ].filter(Boolean));
    detail.hidden = false;
    paint();
  }

  const systemName = (id) => network.systems.find((sys) => sys.id === id)?.name || id;

  function stationGroup(station) {
    const ids = transferByStation.get(station.id) || [station.id];
    return ids.map((id) => stationById.get(id)).filter(Boolean);
  }

  /** 優先採用「車站」名稱, 再看等級與交會線數, 所有入口會得到同一個代表名稱。 */
  function groupHead(group) {
    return group.slice().sort((a, b) =>
      Number(/車站$/.test(b.name)) - Number(/車站$/.test(a.name))
      || (b.grade ?? 0) - (a.grade ?? 0)
      || b.lines.length - a.lines.length
      || a.name.length - b.name.length)[0];
  }

  function setFocus(lineId) {
    focusLine = lineId;
    for (const node of legend.querySelectorAll("[data-legend-line]")) {
      node.classList.toggle("is-focus", node.dataset.legendLine === lineId);
    }
    paint();
  }

  function zoomBy(factor, at) {
    const { width, height } = measure();
    const mx = at ? at[0] : width / 2;
    const my = at ? at[1] : height / 2;
    const [wx, wy] = toWorld(view, mx, my);
    const next = Math.max(MIN_SCALE, Math.min(view.scale * factor, MAX_SCALE));
    if (next === view.scale) return;
    // 以游標（或畫面中心）為圓心縮放: 那一點在世界座標上的位置不能跑掉。
    view = { scale: next, tx: mx - wx * next, ty: my + wy * next };
    userMoved = true;
    schedule();
  }

  function focusRegion(region) {
    if (!network || !region) return;
    currentRegion = region;
    userMoved = false;
    const { width, height } = measure();
    view = fitTransform(boundsOf(network, region.systems), width, height, 28);
    select(null);
    schedule();
  }

  function centreOn(station) {
    const { width, height } = measure();
    const group = stationGroup(station);
    const centre = group.reduce((point, member) =>
      [point[0] + member.x / group.length, point[1] + member.y / group.length], [0, 0]);
    // 拉近到看得到站名的程度, 但不要比目前更遠。
    const scale = Math.min(Math.max(view.scale, 0.02), MAX_SCALE);
    view = { scale, tx: width / 2 - centre[0] * scale, ty: height / 2 + centre[1] * scale };
    userMoved = true;
    select(station);
    schedule();
  }

  function onSearch() {
    const query = searchInput.value.trim().toLowerCase();
    if (!query || !network) { results.hidden = true; results.replaceChildren(); return; }

    const seen = new Set();
    const hits = [];
    for (const station of network.stations) {
      const group = stationGroup(station);
      const key = group.map((member) => member.id).sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      if (!group.some((member) =>
        member.name.toLowerCase().includes(query)
        || member.nameEn.toLowerCase().includes(query)
        || member.codes.some((code) => code.toLowerCase().startsWith(query)))) continue;
      hits.push({ head: groupHead(group), group });
      if (hits.length >= 8) break;
    }

    results.replaceChildren(...hits.map(({ head, group }) => {
      const codes = [...new Set(group.flatMap((member) => member.codes))];
      const systems = [...new Set(group.map((member) => systemName(member.system)))];
      const displayName = stationGroupNames(group, head).join("／");
      return el("button", {
        type: "button",
        class: "railmap-result",
        onclick: () => { results.hidden = true; searchInput.value = displayName; centreOn(head); },
      },
        el("span", { class: "railmap-result-name" }, displayName),
        el("span", { class: "railmap-result-meta" }, `${systems.join("／")}${codes.length ? ` · ${codes.join(" ")}` : ""}`),
      );
    }));
    results.hidden = !hits.length;
  }

  /* ---------- 拖曳與滾輪 ---------- */

  let dragging = null;
  stage.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    dragging = { x: event.clientX, y: event.clientY, tx: view.tx, ty: view.ty, moved: false };
    try { stage.setPointerCapture(event.pointerId); } catch { /* 沒抓到就算了, 照樣能拖 */ }
  });
  stage.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const dx = event.clientX - dragging.x;
    const dy = event.clientY - dragging.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) { dragging.moved = true; userMoved = true; }
    view = { ...view, tx: dragging.tx + dx, ty: dragging.ty + dy };
    schedule();
  });
  const endDrag = () => { dragging = null; };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);

  stage.addEventListener("wheel", (event) => {
    event.preventDefault();
    const box = stage.getBoundingClientRect();
    zoomBy(event.deltaY < 0 ? 1.18 : 1 / 1.18, [event.clientX - box.left, event.clientY - box.top]);
  }, { passive: false });

  /* ---------- 圖例 ---------- */

  function buildLegend() {
    legend.replaceChildren(el("div", { class: "railmap-legend-head" }, "路線"));
    for (const system of network.systems) {
      const lines = network.lines.filter((line) => line.system === system.id);
      if (!lines.length) continue;

      const box = el("input", {
        type: "checkbox",
        class: "tool-check",
        checked: true,
        onchange: () => {
          for (const line of lines) {
            if (box.checked) visible.add(line.id); else visible.delete(line.id);
          }
          schedule();
        },
      });
      legend.appendChild(el("label", { class: "tool-flag railmap-legend-system" },
        box, el("span", {}, system.name)));

      for (const line of lines) {
        legend.appendChild(el("button", {
          type: "button",
          class: "railmap-legend-line",
          "data-legend-line": line.id,
          onclick: () => setFocus(focusLine === line.id ? null : line.id),
        },
          el("span", {
            class: line.partial ? "railmap-swatch is-partial" : "railmap-swatch",
            style: `background:${line.colour};--swatch:${line.colour}`,
          }),
          el("span", { class: "railmap-legend-name" }, line.name),
          el("span", {
            class: "railmap-legend-count",
            title: line.partial ? "OSM 上還沒有這條線的車站資料" : null,
          }, line.partial ? "無站點" : `${line.stations.length}`),
        ));
      }
    }
  }

  /* ---------- 載入 ---------- */

  function adopt(next, source) {
    network = topologizeNetwork(next);
    stationById = new Map(network.stations.map((station) => [station.id, station]));
    transferByStation = new Map();
    for (const group of network.transfers || []) {
      for (const id of group) transferByStation.set(id, group);
    }
    visible = new Set(network.lines.map((line) => line.id));
    focusLine = null;
    selected = null;
    detail.hidden = true;

    buildLegend();
    regionTabs.select("all");
    focusRegion(REGIONS[0]);

    const stations = network.stations.length;
    info.set(
      `${network.lines.length} 條路線、${stations} 座車站, 資料日期 ${network.generated}`
      + (source === "cache" ? "（來自你上次的線上更新）" : ""),
      "ok",
    );
  }

  async function refresh() {
    if (aborter) { aborter.abort(); aborter = null; }
    aborter = new AbortController();
    updateButton.disabled = true;

    try {
      const next = await fetchLive({
        signal: aborter.signal,
        onProgress: (text) => info.set(text, "warn"),
      });
      if (!next.lines.length) throw new Error("回來的資料是空的");
      adopt(next, "cache");
      if (writeCache(next)) notify.success("已更新, 並記住這一份");
      else notify.warning("已更新, 但存不進瀏覽器快取");
    } catch (error) {
      if (error.name === "AbortError") return;
      info.set(`線上更新失敗: ${error.message}。目前顯示的仍是原本的資料。`, "error");
      notify.danger("線上更新失敗");
    } finally {
      updateButton.disabled = false;
      aborter = null;
    }
  }

  info.set("正在載入路網…", "warn");
  try {
    const { network: initial, from } = await loadInitial();
    adopt(initial, from);
  } catch (error) {
    info.set(`讀不到路網資料: ${error.message}`, "error");
    stage.appendChild(el("div", { class: "railmap-empty" },
      "路網資料載不進來。",
      button("改成線上抓", { variant: "primary", onClick: refresh }),
    ));
  }

  /* ---------- 收拾 ---------- */
  return () => {
    observer.disconnect();
    if (frame) cancelAnimationFrame(frame);
    if (aborter) aborter.abort();
  };
}
