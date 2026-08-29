// js/tools/spacing/index.js — 等分排列計算機。
//
// 一段長度要平均放 N 個東西，算出每個「從邊緣量起」的位置。
// 主要輸出是那一串累計位置：實際劃線是拿尺壓著同一個邊量到底，
// 一段一段接力量的話誤差會一路累積。

import {
  panel, row, field, numberInput, select, segmented, actions, outputRow,
  copyButton, status, note, subhead, el,
} from "../kit.js";
import { linearLayout, circleLayout, MODES } from "./layout.js";
import { linearDiagram, circleDiagram } from "./diagram.js";

export const styles = new URL("./spacing.css", import.meta.url).href;

export const meta = { title: "等分排列計算機" };

const round = (n, d = 2) => String(Math.round(n * 10 ** d) / 10 ** d);

export function mount(host, { options = {} } = {}) {
  let shape = options.shape === "circle" ? "circle" : "line";
  let mode = MODES[options.mode] ? options.mode : "around";
  let positions = [];

  /* ---- 直線 ---- */
  const lengthInput = numberInput({ value: "1830", min: "1", step: "any", onInput: update });
  const countInput = numberInput({ value: "5", min: "1", step: "1", onInput: update });
  const widthInput = numberInput({ value: "300", min: "0", step: "any", onInput: update });
  const stepSelect = select({
    options: [
      { value: "1", label: "1 mm" },
      { value: "0.5", label: "0.5 mm" },
      { value: "5", label: "5 mm" },
      { value: "0", label: "不取整（保留小數）" },
    ],
    value: "1",
    onChange: update,
  });
  const modeTabs = segmented(
    Object.entries(MODES).map(([value, m]) => ({ value, label: m.label })),
    { value: mode, onChange: (value) => { mode = value; update(); } },
  );

  /* ---- 圓周 ---- */
  const diameterInput = numberInput({ value: "120", min: "1", step: "any", onInput: update });
  const circleCount = numberInput({ value: "6", min: "2", step: "1", onInput: update });

  const shapeTabs = segmented(
    [{ value: "line", label: "直線等分" }, { value: "circle", label: "圓周等分" }],
    {
      value: shape,
      onChange: (value) => {
        shape = value;
        lineFields.hidden = shape !== "line";
        circleFields.hidden = shape !== "circle";
        for (const [node, forShape] of ownership) node.hidden = forShape !== shape;
        update();
      },
    },
  );

  const lineFields = el("div", {},
    row(
      field("總長度（mm）", lengthInput),
      field("數量", countInput),
      field("物件寬度（mm）", widthInput, "填 0 就是純粹標點"),
    ),
    row(
      field("排法", modeTabs, MODES[mode].hint),
      field("取整", stepSelect),
    ),
  );
  const circleFields = row(
    field("直徑（mm）", diameterInput),
    field("等分數", circleCount),
  );

  /* ---- 輸出 ---- */
  const outGap = outputRow("間距");
  const outCell = outputRow("每格寬度");
  const outAngle = outputRow("每份角度");
  const outChord = outputRow("弦長");
  const outArc = outputRow("弧長");
  const outList = outputRow("位置（自左邊量）");
  const info = status();

  // 哪幾列屬於哪一種形狀，切換時一起顯示或收起來。
  const ownership = [
    [outGap, "line"], [outCell, "line"],
    [outAngle, "circle"], [outChord, "circle"], [outArc, "circle"],
  ];

  const figure = el("div", { class: "spacing-figure" });
  const copyList = copyButton(() => positions.join("\n"), { label: "複製位置清單" });
  const copyCsv = copyButton(() => positions.join(", "), { label: "複製成一行" });

  function update() {
    const step = Number(stepSelect.value);

    if (shape === "circle") {
      const result = circleLayout({
        diameter: Number(diameterInput.value),
        count: Number(circleCount.value),
      });
      if (!result) {
        fail("直徑要大於 0，等分數至少 2。");
        return;
      }
      positions = result.points.map((p) => `${round(p.x)}, ${round(p.y)}`);
      outAngle.set(`${round(result.angle)}°`);
      outChord.set(`${round(result.chord)} mm`);
      outArc.set(`${round(result.arc)} mm`);
      outList.set(positions.length <= 6 ? positions.join("　") : `${positions.length} 個座標`);
      figure.replaceChildren(circleDiagram({
        diameter: Number(diameterInput.value),
        points: result.points,
        chord: result.chord,
      }));
      info.set("座標是相對圓心的（X 向右、Y 向上）。手工劃線的話用弦長比較快：定好第一點，用圓規張開弦長，沿著圓周依序點下去。", "ok");
      setEnabled(true);
      return;
    }

    const length = Number(lengthInput.value);
    const count = Number(countInput.value);
    const width = Number(widthInput.value);
    const result = linearLayout({ length, count, width, mode, step });
    if (!result) {
      const total = width * count;
      if (total > length) fail(`放不下：${count} 個 × ${round(width)} = ${round(total)}，比總長 ${round(length)} 還大。`);
      else if (mode === "between" && count < 2) fail("「兩端不留邊」至少要放 2 個。");
      else fail("每一欄都要填正數，數量要是整數。");
      return;
    }

    positions = result.positions.map((p) => round(p));
    outGap.set(`${round(result.gap)} mm`);
    outCell.set(`${round(result.cell)} mm`);
    outList.set(positions.length <= 8 ? positions.join("　") : `${positions.length} 個位置`);

    figure.replaceChildren(linearDiagram({
      length, width,
      positions: result.positions,
      spans: result.spans,
    }));

    const messages = [];
    if (!result.exact && step) {
      const uniq = [...new Set(result.spans.map((v) => round(v)))].filter((v) => Number(v) > 0);
      messages.push(`除不盡，間距取整成 ${uniq.join(" / ")} mm（總長仍然剛好 ${round(length)}）`);
    }
    if (result.leftover > 1e-9) messages.push(`尾端多出 ${round(result.leftover, 3)} mm 分不掉`);
    if (width === 0) messages.push("物件寬度是 0，位置就是要劃線的點");
    info.set(messages.length ? messages.join("；") : `間距 ${round(result.gap)} mm，全部剛好`, messages.length ? "warn" : "ok");
    setEnabled(true);
  }

  function fail(message) {
    positions = [];
    info.set(message, "error");
    for (const outRow of [outGap, outCell, outAngle, outChord, outArc, outList]) outRow.set("");
    figure.replaceChildren();
    setEnabled(false);
  }

  function setEnabled(on) {
    copyList.disabled = !on;
    copyCsv.disabled = !on;
  }

  host.appendChild(panel(
    field("形狀", shapeTabs),
    lineFields,
    circleFields,

    subhead("結果"),
    el("div", { class: "tool-outs" }, outGap, outCell, outAngle, outChord, outArc, outList),
    info,
    actions(copyList, copyCsv),

    subhead("示意圖"),
    figure,
    note("下面那排數字是「從左邊量起」的累計位置，不是一段一段的間距 —— 拿尺壓著同一個邊一路量到底，誤差才不會累積。"),
  ));

  lineFields.hidden = shape !== "line";
  circleFields.hidden = shape !== "circle";
  for (const [node, forShape] of ownership) node.hidden = forShape !== shape;
  update();
  return null;
}
