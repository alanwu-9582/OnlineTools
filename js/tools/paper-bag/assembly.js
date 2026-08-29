// js/tools/paper-bag/assembly.js — 組裝動畫的播放器：播放／暫停、
// 進度條、章節，以及捲出畫面就停下來的那套邏輯。

import { s, SVG_NS } from "../svg.js";
import { el, icon, note } from "../kit.js";
import { STAGES, clamp01 } from "./fold-model.js";
import { buildFoldFrame } from "./fold-view.js";

const DURATION = 13000;
const HOLD = 1100;

/**
 * 組裝動畫本體：一個會自己播的 SVG，加上播放／暫停、進度條與章節。
 * @returns {{node: HTMLElement, destroy: Function}}
 */
export function buildAssembly(geo, showHoles) {
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  const svg = s("svg", {
    xmlns: SVG_NS, class: "bag-anim-svg", role: "img",
    "aria-label": "紙袋組裝動畫",
  });
  const title = el("div", { class: "bag-anim-title" });
  const desc = el("p", { class: "bag-anim-desc" });
  const scrub = el("input", {
    type: "range", class: "bag-anim-scrub", min: "0", max: "1000", value: "0",
    "aria-label": "組裝進度",
  });
  const playIcon = el("span", { class: "bag-anim-play-ico" });
  const playLabel = el("span", {}, "");
  const playBtn = el("button", { type: "button", class: "btn btn-sm btn-ghost bag-anim-play" },
    playIcon, playLabel);
  const chips = el("div", { class: "bag-anim-chips" });

  let t = 0;
  let playing = !reduced;
  let raf = null;
  let last = null;
  let holdUntil = 0;

  // 不裝提把的話最後一章就只是「完成」。章節鈕與說明共用同一份文案，
  // 免得鈕上寫著「打洞、穿提把」、底下卻寫「完成」。
  const stageTitle = (i) => (showHoles || i !== STAGES.length - 1 ? STAGES[i].title : "完成");
  const stageDesc = (i) => (showHoles || i !== STAGES.length - 1
    ? STAGES[i].desc(geo)
    : "袋身完成。沒有要裝提把的話，這裡就結束了。");

  const chipNodes = STAGES.map((stage, i) => {
    const node = el("button", {
      type: "button", class: "bag-anim-chip",
      onclick: () => { seek(stage.at + 0.001); },
    }, `${i + 1}. ${stageTitle(i)}`);
    chips.appendChild(node);
    return node;
  });

  function activeStage() {
    let index = 0;
    for (let i = 0; i < STAGES.length; i += 1) if (t >= STAGES[i].at) index = i;
    return index;
  }

  function draw() {
    const { nodes, viewBox } = buildFoldFrame(geo, t, showHoles);
    svg.replaceChildren(...nodes);
    svg.setAttribute("viewBox", viewBox);

    const index = activeStage();
    title.textContent = `${index + 1}. ${stageTitle(index)}`;
    desc.textContent = stageDesc(index);
    chipNodes.forEach((node, i) => node.classList.toggle("is-active", i === index));
    scrub.value = String(Math.round(t * 1000));
  }

  function paint() {
    playIcon.innerHTML = icon(playing ? "pause" : "play", { size: "13px" });
    playLabel.textContent = playing ? "暫停" : "播放";
    playBtn.setAttribute("aria-pressed", String(playing));
  }

  function step(now) {
    if (last == null) last = now;
    // 切到別的分頁時 rAF 會停，回來的第一格 now − last 可能是好幾秒，
    // 不夾住的話進度會直接跳掉一大段。
    const dt = Math.min(now - last, 100);
    last = now;
    if (playing) {
      if (holdUntil) {
        // 折完之後停一下再重來，不然看起來像沒播完就跳掉。
        if (now >= holdUntil) { holdUntil = 0; t = 0; }
      } else {
        t += dt / DURATION;
        if (t >= 1) { t = 1; holdUntil = now + HOLD; }
      }
      draw();
    }
    raf = requestAnimationFrame(step);
  }

  function seek(next) {
    t = clamp01(next);
    holdUntil = 0;
    draw();
  }

  playBtn.addEventListener("click", () => {
    playing = !playing;
    if (playing && t >= 1) t = 0;
    holdUntil = 0;
    paint();
  });
  scrub.addEventListener("input", () => {
    playing = false;
    paint();
    seek(Number(scrub.value) / 1000);
  });

  const node = el("div", { class: "bag-anim" },
    el("div", { class: "bag-anim-stage" }, svg),
    el("div", { class: "bag-anim-controls" }, playBtn, scrub),
    chips,
    el("div", { class: "bag-anim-caption" }, title, desc),
    reduced ? note("偵測到系統設定為減少動態效果，動畫預設不自動播放 —— 按播放或直接拖進度條。") : null,
  );

  // 捲出畫面就不要再算了。這頁很長，沒必要在看不到的地方燒 CPU。
  let observer = null;
  if (typeof IntersectionObserver === "function") {
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          if (raf == null) { last = null; raf = requestAnimationFrame(step); }
        } else if (raf != null) {
          cancelAnimationFrame(raf); raf = null;
        }
      }
    }, { threshold: 0.05 });
    observer.observe(node);
  } else {
    raf = requestAnimationFrame(step);
  }

  if (reduced) { t = 1; }
  paint();
  draw();

  return {
    node,
    destroy() {
      observer?.disconnect();
      if (raf != null) cancelAnimationFrame(raf);
      raf = null;
    },
  };
}
