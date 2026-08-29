// js/tools/cone-unroll/index.js — 圓錐／圓台展開圖。
//
// 做紙漏斗、燈罩、派對帽、花器套。上口填 0 就是正圓錐，上下一樣大就是圓柱。

import {
  panel, row, field, numberInput, button, actions, outputRow,
  status, note, subhead, el,
} from "../kit.js";
import { downloadSvg } from "../svg.js";
import { notify } from "../../ui/notifications.js";
import { unroll } from "./geometry.js";
import { buildPattern, buildCylinderPattern } from "./pattern.js";

export const styles = new URL("./cone-unroll.css", import.meta.url).href;

export const meta = { title: "圓錐展開圖" };

const mm = (n) => String(Math.round(n * 10) / 10);

export function mount(host, { options = {} } = {}) {
  let geo = null;

  const topDia = numberInput({ value: String(options.top ?? 60), min: "0", step: "any", onInput: update });
  const bottomDia = numberInput({ value: String(options.bottom ?? 120), min: "1", step: "any", onInput: update });
  const heightInput = numberInput({ value: String(options.height ?? 100), min: "1", step: "any", onInput: update });
  const glueInput = numberInput({ value: "10", min: "0", step: "any", onInput: update });
  const lidsToggle = el("input", { type: "checkbox", class: "tool-check", oninput: update });

  const outAngle = outputRow("扇形角度");
  const outOuter = outputRow("外弧半徑");
  const outInner = outputRow("內弧半徑");
  const outChord = outputRow("弦長");
  const outSlant = outputRow("斜邊長");
  const outPaper = outputRow("需要的紙張");
  const outVolume = outputRow("容量");
  const info = status();

  const figure = el("div", { class: "cone-figure" });

  const download = button("下載裁切圖 SVG（1:1）", {
    iconName: "arrowRight",
    onClick: () => {
      if (!geo) return;
      const glue = Number(glueInput.value) || 0;
      const svg = geo.kind === "cylinder"
        ? buildCylinderPattern(geo, { print: true, glue })
        : buildPattern(geo, { print: true, glue, lids: lidsToggle.checked });
      downloadSvg(svg, `圓錐展開圖-${mm(geo.r * 2)}x${mm(geo.R * 2)}x${mm(geo.h)}.svg`);
      notify.success("已下載，列印選「實際大小」就是 1:1");
    },
  });

  function update() {
    geo = unroll({
      topDia: Number(topDia.value),
      bottomDia: Number(bottomDia.value),
      height: Number(heightInput.value),
    });
    const glue = Number(glueInput.value) || 0;
    const rows = [outAngle, outOuter, outInner, outChord, outSlant, outPaper, outVolume];

    if (!geo) {
      info.set("下口直徑與高度要大於 0，上口直徑不能是負的。", "error");
      for (const r of rows) r.set("");
      figure.replaceChildren();
      download.disabled = true;
      return;
    }
    download.disabled = false;

    outSlant.set(`${mm(geo.slant)} mm`);
    outVolume.set(`${geo.volume.toFixed(3)} 公升`);

    if (geo.kind === "cylinder") {
      for (const r of [outAngle, outOuter, outInner, outChord]) r.set("");
      outPaper.set(`${mm(geo.width + glue)} × ${mm(geo.height)} mm`);
      figure.replaceChildren(buildCylinderPattern(geo, { glue }));
      info.set("上下一樣大，這是圓柱 —— 展開圖就是一個長方形，不用畫扇形。", "ok");
      return;
    }

    outAngle.set(`${mm(geo.angle)}°`);
    outOuter.set(`${mm(geo.outer)} mm`);
    outInner.set(geo.inner > 0.05 ? `${mm(geo.inner)} mm` : "0（正圓錐，收在一點）");
    outChord.set(`${mm(geo.chord)} mm`);
    outPaper.set(`${mm(geo.paperW + glue)} × ${mm(geo.paperH)} mm`);

    figure.replaceChildren(buildPattern(geo, { glue, lids: lidsToggle.checked }));

    if (geo.tooLarge) {
      const f = geo.cylinderFallback;
      info.set(
        `上下口太接近，扇形半徑要 ${mm(geo.outer)} mm —— 沒有圓規畫得出來。`
        + `建議直接當圓柱裁一張 ${mm(f.width)} × ${mm(f.height)} mm 的長方形，`
        + `上下口會各差 ${mm(f.error)} mm。`,
        "warn",
      );
    } else {
      // 正圓錐的內弧半徑是 0，講「畫半徑 0 的弧」沒有意義。
      const how = geo.inner > 0.05
        ? `用圓規在同一個圓心畫兩段弧（${mm(geo.outer)} 與 ${mm(geo.inner)}）`
        : `用圓規畫一段半徑 ${mm(geo.outer)} mm 的弧，兩端連回圓心`;
      info.set(`${how}，再用尺量弦長 ${mm(geo.chord)} mm 定出開口。`, "ok");
    }
  }

  host.appendChild(panel(
    row(
      field("上口直徑（mm）", topDia, "填 0 就是正圓錐"),
      field("下口直徑（mm）", bottomDia),
      field("高度（mm）", heightInput, "垂直高，不是斜邊"),
    ),
    row(
      field("黏合邊（mm）", glueInput),
      field("上下底", el("label", { class: "tool-flag" }, lidsToggle, el("span", {}, "一起畫圓片"))),
    ),

    subhead("結果"),
    el("div", { class: "tool-outs" }, outAngle, outOuter, outInner, outChord, outSlant, outPaper, outVolume),
    info,

    subhead("裁切圖"),
    figure,
    actions(download),
    note("實線是裁切線，虛線是折線。沒有量角器也沒關係 —— 畫好兩段弧之後，用尺量「弦長」就能定出扇形的開口大小。"),
  ));

  update();
  return null;
}
