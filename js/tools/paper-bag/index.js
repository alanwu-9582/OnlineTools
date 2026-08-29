// js/tools/paper-bag.js — 手工紙袋計算機。
//
// 算的是最常見的那種「方底提袋」（SOS bag）：一張長方形紙，捲成筒、
// 折出兩側的內凹側面，底部收成平的長方形。照片上那種牛皮紙袋就是這個結構。
//
// 展開圖的幾何：
//
//   橫向  [黏合邊 G][前 W][側 D][後 W][側 D]        紙寬 = G + 2W + 2D
//   縱向  [上緣折邊 T][袋身 H][底部 B]              紙高 = T + H + B
//
// 底部高度 B = D/2 + 重疊。理由：底面是一個 W×D 的長方形，前後兩片各要
// 蓋過中線才黏得住 —— 剛好蓋到中線是 D/2，再多出來的就是重疊量。
// 側面在底部收成兩個 45° 的三角形，頂點落在離底線 D/2 的地方，
// 所以斜折線一定是 45°，這不是估的。
//
// 提把只標打洞位置：真正的紙繩提把要另外穿，怎麼穿跟紙張怎麼裁無關。

import {
  panel, row, field, numberInput, select, segmented, button, actions, outputRow,
  status, note, subhead, el,
} from "../kit.js";
import { notify } from "../../ui/notifications.js";
import {
  mm, roundUp5, PAPER_SIZES, suggestPaper, fitToPaper, buildGeometry,
} from "./geometry.js";
import { buildNetSvg, buildLegend } from "./net.js";
import { downloadSvg } from "../svg.js";
import { buildAssembly } from "./assembly.js";

/** 這個工具自己的樣式。tool-host 會在掛載前先把它載進來。 */
export const styles = new URL("./paper-bag.css", import.meta.url).href;

export const meta = { title: "手工紙袋計算機" };

/* ================= 掛載 ================= */

const MODES = ["bag", "item", "paper"];

export function mount(host, { options = {} } = {}) {
  let mode = MODES.includes(options.mode) ? options.mode : "bag";
  let ratio = "0.4";
  let geo = null;

  /* ---- 輸入 ---- */
  const bagW = numberInput({ value: "240", min: "10", step: "1", onInput: update });
  const bagD = numberInput({ value: "100", min: "10", step: "1", onInput: update });
  const bagH = numberInput({ value: "300", min: "10", step: "1", onInput: update });

  const itemL = numberInput({ value: "200", min: "1", step: "1", onInput: update });
  const itemW = numberInput({ value: "80", min: "1", step: "1", onInput: update });
  const itemH = numberInput({ value: "250", min: "1", step: "1", onInput: update });
  const ease = numberInput({ value: "20", min: "0", step: "1", onInput: update });
  const headroom = numberInput({ value: "40", min: "0", step: "1", onInput: update });

  // 手動改了長寬就不再是某個標準尺寸，把下拉選單退回「自訂」。
  const onPaperInput = () => { presetSelect.value = ""; update(); };
  const paperWInput = numberInput({ value: "297", min: "20", step: "1", onInput: onPaperInput });
  const paperHInput = numberInput({ value: "210", min: "20", step: "1", onInput: onPaperInput });
  const presetSelect = select({
    options: [
      { value: "", label: "自訂尺寸" },
      ...PAPER_SIZES.map((size) => ({ value: size.label, label: `${size.label}　${size.w} × ${size.h}` })),
    ],
    value: "A4",
    onChange: () => {
      const size = PAPER_SIZES.find((item) => item.label === presetSelect.value);
      if (!size) return;
      // 帶入橫放。橫向要塞下整個袋子的一圈，幾乎都是那個方向先不夠用。
      paperWInput.value = String(size.h);
      paperHInput.value = String(size.w);
      update();
    },
  });
  const swapButton = button("轉 90°", {
    onClick: () => {
      const w = paperWInput.value;
      paperWInput.value = paperHInput.value;
      paperHInput.value = w;
      update();
    },
  });
  const ratioTabs = segmented(
    [
      { value: "0.25", label: "扁" },
      { value: "0.4", label: "標準" },
      { value: "0.6", label: "厚" },
      { value: "max", label: "最大容量" },
    ],
    { value: ratio, onChange: (value) => { ratio = value; update(); } },
  );

  const glue = numberInput({ value: "20", min: "5", step: "1", onInput: update });
  const hem = numberInput({ value: "30", min: "10", step: "1", onInput: update });
  const overlap = numberInput({ value: "15", min: "5", step: "1", onInput: update });
  const holeSpanInput = numberInput({ value: "", min: "10", step: "1", placeholder: "自動", onInput: update });
  const holeTop = numberInput({ value: "15", min: "3", step: "1", onInput: update });
  const holeToggle = el("input", { type: "checkbox", class: "tool-check", checked: "checked", oninput: update });

  const bagFields = row(
    field("袋寬 W（mm）", bagW, "正面的寬度"),
    field("袋深 D（mm）", bagD, "側面的厚度"),
    field("袋高 H（mm）", bagH, "完成後的高度"),
  );
  const itemFields = el("div", {},
    row(
      field("物品長（mm）", itemL),
      field("物品寬（mm）", itemW),
      field("物品高（mm）", itemH),
    ),
    row(
      field("寬鬆量（mm）", ease, "長寬各留這麼多空間"),
      field("袋口留高（mm）", headroom, "物品上方的空間"),
    ),
  );

  const paperFields = el("div", {},
    row(
      field("常見尺寸", presetSelect, "選了會帶入橫放的長短邊"),
      field("紙張寬（mm）", paperWInput, "繞著袋子一圈的方向"),
      field("紙張高（mm）", paperHInput),
      field("方向", swapButton),
    ),
    row(field("袋身比例", ratioTabs, "側面厚度相對於正面寬度。整張紙都會用掉，所以袋高不用選")),
  );

  const modeTabs = segmented(
    [
      { value: "bag", label: "我知道袋子尺寸" },
      { value: "item", label: "我知道物品尺寸" },
      { value: "paper", label: "我知道紙張尺寸" },
    ],
    {
      value: mode,
      onChange: (value) => {
        mode = value;
        applyMode();
        update();
      },
    },
  );

  function applyMode() {
    bagFields.hidden = mode !== "bag";
    itemFields.hidden = mode !== "item";
    paperFields.hidden = mode !== "paper";
    outLeftover.hidden = mode !== "paper";
  }

  /* ---- 輸出 ---- */
  const outPaper = outputRow("需要的紙張");
  const outStock = outputRow("可用的標準紙");
  const outBag = outputRow("成品尺寸");
  const outVolume = outputRow("容量");
  const outBottom = outputRow("底部折高");
  const outLeftover = outputRow("紙張餘料");
  const info = status();

  const netHost = el("div", { class: "bag-net-host" });
  const stepHost = el("div", {});
  // 動畫自己有 requestAnimationFrame 迴圈，換尺寸時要先把上一個關掉，
  // 不然每改一次數字就多一條迴圈在背景跑。
  let assembly = null;
  const dropAssembly = () => { assembly?.destroy(); assembly = null; };

  const download = button("下載展開圖 SVG（1:1）", {
    iconName: "arrowRight",
    onClick: () => {
      if (!geo) return;
      const svg = buildNetSvg(geo, { print: true, showHoles: holeToggle.checked });
      downloadSvg(svg, `紙袋展開圖-${mm(geo.W)}x${mm(geo.D)}x${mm(geo.H)}.svg`);
      notify.success("已下載，用瀏覽器或 Illustrator 開就是實際大小");
    },
  });

  /* ---- 計算 ---- */

  /**
   * 依目前的輸入方式算出袋子的三個尺寸。
   * @returns {{W:number, D:number, H:number, note?:string, fit?:object}}
   */
  function readBagSize(g, t, o) {
    if (mode === "bag") {
      return { W: Number(bagW.value), D: Number(bagD.value), H: Number(bagH.value) };
    }

    if (mode === "paper") {
      const pw = Number(paperWInput.value);
      const ph = Number(paperHInput.value);
      if (!Number.isFinite(pw) || !Number.isFinite(ph)) return { W: NaN, D: NaN, H: NaN };
      const fit = fitToPaper({ paperW: pw, paperH: ph, glue: g, hem: t, overlap: o, ratio });
      if (!fit) return { W: NaN, D: NaN, H: NaN, note: "這張紙太小，扣掉黏合邊與上下折邊之後不夠做成袋子。" };

      // 同一張紙轉 90° 常常差很多，算給使用者看，要不要轉他自己決定。
      const turned = fitToPaper({ paperW: ph, paperH: pw, glue: g, hem: t, overlap: o, ratio });
      const here = fit.W * fit.D * fit.H;
      const there = turned ? turned.W * turned.D * turned.H : 0;
      const note = there > here * 1.05
        ? `轉 90° 可以做到 ${(there / 1e6).toFixed(2)} 公升（多 ${Math.round((there / here - 1) * 100)}%）`
        : "";
      return { ...fit, fit, note };
    }

    const L = Number(itemL.value);
    const Wd = Number(itemW.value);
    const Ht = Number(itemH.value);
    const gap = Number(ease.value);
    const head = Number(headroom.value);
    if (![L, Wd, Ht, gap, head].every(Number.isFinite)) return { W: NaN, D: NaN, H: NaN };
    // 紙袋一律是「寬的那一面朝前」，所以長寬先分出大小再放進去。
    return {
      W: roundUp5(Math.max(L, Wd) + gap),
      D: roundUp5(Math.min(L, Wd) + gap),
      H: roundUp5(Ht + head),
      note: "",
      derived: true,
    };
  }

  function update() {
    const g = Number(glue.value);
    const t = Number(hem.value);
    const o = Number(overlap.value);
    const ht = Number(holeTop.value);
    const { W, D, H, derived, note, fit } = readBagSize(g, t, o);

    const numbers = [W, D, H, g, t, o, ht];
    if (!numbers.every((n) => Number.isFinite(n) && n > 0)) {
      geo = null;
      info.set(note || "每一欄都要填正數。", "error");
      for (const outRow of [outPaper, outStock, outBag, outVolume, outBottom, outLeftover]) outRow.set("");
      netHost.replaceChildren();
      dropAssembly();
      stepHost.replaceChildren();
      download.disabled = true;
      return;
    }

    const spanRaw = Number(holeSpanInput.value);
    const holeSpan = Number.isFinite(spanRaw) && spanRaw > 0
      ? spanRaw
      : Math.min(Math.max(W / 2, 40), W - 30 > 0 ? W - 30 : W / 2);

    geo = buildGeometry({ W, D, H, glue: g, hem: t, overlap: o, holeSpan, holeTop: ht });
    download.disabled = false;

    outPaper.set(`${mm(geo.paperW)} × ${mm(geo.paperH)} mm`);
    outBag.set(`${mm(W)} × ${mm(D)} × ${mm(H)} mm（寬 × 深 × 高）`);
    outVolume.set(`${(geo.volume).toFixed(2)} 公升`);
    outBottom.set(`${mm(geo.bottom)} mm　＝ 袋深一半 ${mm(D / 2)} ＋ 重疊 ${mm(o)}`);

    const stock = suggestPaper(geo.paperW, geo.paperH);
    outStock.set(stock
      ? `${stock.label}（${stock.w} × ${stock.h}）${stock.orientation}`
      : "比全開紙還大，得自己拼接");

    outLeftover.set(fit
      ? (fit.leftoverW < 0.5 && fit.leftoverH < 0.5
        ? "剛好用完"
        : `寬剩 ${mm(fit.leftoverW)}、高剩 ${mm(fit.leftoverH)} mm`)
      : "");

    const warnings = [];
    if (D > W) warnings.push("袋深比袋寬大，折起來會像個方盒子而不是提袋");
    if (ht + 8 > t) warnings.push(`上緣折邊只有 ${mm(t)}，打洞位置離邊太近容易撕破`);
    if (holeSpan > W - 20) warnings.push("提把孔太靠近側邊");
    if (geo.paperW > 1091 || geo.paperH > 1091) warnings.push("超過一般全開紙的尺寸");
    if (mode === "paper" && H > W * 3) warnings.push("這張紙又窄又長，做出來會是細細高高的袋子");

    if (warnings.length || note) info.set([note, ...warnings].filter(Boolean).join("；"), "warn");
    else if (mode === "paper") info.set(`這張紙最大能做 ${mm(W)} × ${mm(D)} × ${mm(H)} mm，${geo.volume.toFixed(2)} 公升`, "ok");
    else if (derived) info.set(`已從物品尺寸推算出袋子：${mm(W)} × ${mm(D)} × ${mm(H)} mm`, "ok");
    else info.set(`共 ${mm(geo.paperW * geo.paperH / 100)} 平方公分的紙`, "ok");

    netHost.replaceChildren(buildNetSvg(geo, { showHoles: holeToggle.checked }));
    dropAssembly();
    assembly = buildAssembly(geo, holeToggle.checked);
    stepHost.replaceChildren(assembly.node);
  }

  /* ---- 版面 ---- */
  host.appendChild(panel(
    field("輸入方式", modeTabs),
    bagFields,
    itemFields,
    paperFields,

    subhead("紙張與折邊"),
    row(
      field("黏合邊（mm）", glue, "捲成筒之後要黏的那一片"),
      field("上緣折邊（mm）", hem, "袋口往內折的寬度"),
      field("底部重疊（mm）", overlap, "底部兩片互相蓋住的量"),
    ),
    row(
      field("提把孔距（mm）", holeSpanInput, "留空 = 自動取袋寬的一半"),
      field("孔離上緣（mm）", holeTop),
      field("提把孔", el("label", { class: "tool-flag" }, holeToggle, el("span", {}, "標出打洞位置"))),
    ),

    subhead("結果"),
    el("div", { class: "tool-outs" }, outPaper, outStock, outBag, outVolume, outBottom, outLeftover),
    info,

    subhead("展開圖"),
    netHost,
    buildLegend(),
    actions(download),
    note("圖面朝上時看到的是紙袋的外側。除了兩條側面中線是谷折，其餘折線都往後折。"),
    note("畫線時用外圈那兩排「自左邊量／自上緣量」的累計數字 —— 一段一段接力量，誤差會一路累積下去。下載的 SVG 標了毫米單位，列印選「實際大小／100%」時圖面就是 1:1（含四周的標示，所以印出來的紙會比裁切用的紙大一圈）。"),

    subhead("組裝步驟"),
    stepHost,
  ));

  applyMode();
  update();
  return () => dropAssembly();
}
