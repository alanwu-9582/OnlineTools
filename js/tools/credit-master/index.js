// js/tools/credit-master/index.js — 學分大師。
//
// 北科大工程科技學士班【材資系材料組】的成績與畢業學分管理。自己加課、填分數, 
// 算 GPA 與各類學分, 並逐項對照畢業門檻（含「幾選幾」、通識博雅三向度、
// 基礎實驗課程）。
//
// 兩份資料:
//   data/ntut-curriculum.json  自己的課程科目表 + 畢業門檻（一開就載）
//   data/ntut-courses.json     全校 3000 多門課, 給「新增課程」挑（用到才載）
//
// 兩份都是 tools/build-{curriculum,courses}.mjs 從學校網站抓的快照 ——
// 學分數與幾選幾的組合都不是寫死在程式裡。

import {
  panel, row, field, segmented, button, numberInput, textInput, select,
  status, note, subhead, actions, copyButton, el, icon,
} from "../kit.js";
import { s } from "../svg.js";
import { notify } from "../../ui/notifications.js";
import { summarise, SCALE_KEYS } from "./grades.js";
import {
  loadLocal, saveLocal, clearLocal, readSheet, pullFromScript, pushToScript,
  toTable, APPS_SCRIPT,
} from "./storage.js";

export const styles = new URL("./credit-master.css", import.meta.url).href;

export const meta = { title: "學分大師" };

const CURRICULUM_URL = new URL("../../../data/ntut-curriculum.json", import.meta.url).href;
const POOL_URL = new URL("../../../data/ntut-courses.json", import.meta.url).href;

/** 課表比對用的鍵。同一學期同名課程不會重複, 所以這樣就夠。 */
const keyOf = (semester, name) => `${semester}|${name}`;

const blankState = () => ({
  entries: [], ranks: {},
  scale: "4.3", includeFailed: true, sheetUrl: "", scriptUrl: "",
});

const round = (value, digits = 2) => {
  if (value == null || !Number.isFinite(value)) return "—";
  return String(Math.round(value * 10 ** digits) / 10 ** digits);
};

/** 使用者自己填的類別選項。空值代表課表以外的課, 歸「跨域及自由選修」。 */
const CATEGORY_OPTIONS = [
  { value: "", label: "跨域及自由選修" },
  { value: "校定共同必修", label: "共同必修" },
  { value: "校定專業必修", label: "專業必修" },
  { value: "校定專業選修", label: "專業選修" },
  { value: "校定共同選修", label: "共同選修" },
];

export async function mount(host) {
  let curriculum = null;
  let pool = null;
  let state = { ...blankState(), ...(loadLocal() || {}) };
  let view = "summary";
  let openSemester = null;
  let picker = null;   // { source, query } 開著的時候才有值

  const info = status();
  const board = el("div", { class: "cm-board" });

  /* ---------- 課程科目表 ---------- */
  try {
    const response = await fetch(CURRICULUM_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    curriculum = await response.json();
  } catch (error) {
    host.appendChild(panel(
      el("div", { class: "banner banner-danger" }, `讀不到課程標準: ${error.message}`),
    ));
    return null;
  }

  openSemester = curriculum.semesters[0];

  const bySemester = new Map(curriculum.semesters.map((label) => [label, []]));
  for (const course of curriculum.courses) bySemester.get(course.semester)?.push(course);
  const curriculumIndex = new Map(
    curriculum.courses.map((course) => [keyOf(course.semester, course.name), course]),
  );

  /**
   * 全校課程清單。321 KB, 只有按下「新增課程」才載 ——
   * 大部分時候使用者只是來看自己的進度, 不該為此多下載一份。
   */
  async function ensurePool() {
    if (pool) return pool;
    const response = await fetch(POOL_URL);
    if (!response.ok) throw new Error(`讀不到全校課程清單（HTTP ${response.status}）`);
    const data = await response.json();
    data.divisionByCode = new Map(data.divisions.map((division) => [division.code, division]));
    pool = data;
    return pool;
  }

  /* ---------- 狀態 ---------- */

  const namedEntries = () => state.entries.filter((entry) => String(entry.name || "").trim());

  /**
   * 這一輪畫面上成績列的參考, 還有學期下拉與狀態列。
   * 只更新衍生數字時要靠它們, 不用整塊重建。
   */
  let liveRows = [];
  let liveSemesterSelect = null;

  const save = () => saveLocal(state);

  /** 存檔並整塊重畫。只給「離散」的操作用（加課、刪課、換類別）。 */
  function persist() {
    save();
    paint();
  }

  /**
   * 只重算衍生數字, 不重建 DOM。
   *
   * 打字時一定要走這條。原本每按一個鍵都呼叫 paint(), 而 paint() 是
   * board.replaceChildren(...) —— 正在打字的那個 input 會被換成一個新的節點, 
   * 焦點與游標位置就跟著消失, 變成每打一個字就跳開一次。
   */
  function refreshDerived() {
    const result = summarise(namedEntries(), curriculum, {
      includeFailed: state.includeFailed,
      ranks: state.ranks,
    });
    for (const item of liveRows) {
      const resolved = result.rows.find(
        (candidate) => candidate.semester === item.entry.semester && candidate.name === item.entry.name,
      );
      item.row.className = resolved ? (resolved.passed ? "is-pass" : "is-fail") : "";
      item.points.textContent = resolved ? round(resolved.points[state.scale]) : "";
    }
    if (liveSemesterSelect) {
      for (const option of liveSemesterSelect.options) {
        option.textContent = semesterOptionLabel(option.value, result);
      }
    }
    setStatus(result);
    return result;
  }

  /** 學期下拉的一行字, 附帶該學期的進度。 */
  function semesterOptionLabel(label, result) {
    const own = result.semesters.find((semester) => semester.label === label);
    const taken = state.entries.filter((entry) => entry.semester === label).length;
    return taken ? `${label}　${taken} 門・${round(own?.credits ?? 0)} 學分` : `${label}　（還沒加課）`;
  }

  function setStatus(result) {
    info.set(
      `${curriculum.program.heading}　·　課程標準抓取日 ${curriculum.generated}`
      + `　·　已輸入 ${result.overall.graded} 科`
      + (result.overall.failed ? `（${result.overall.failed} 科不及格）` : ""),
      "ok",
    );
  }

  /** 這門課在自己的課表裡嗎（決定學分與類別要不要讓使用者改）。 */
  const curriculumCourse = (entry) => curriculumIndex.get(keyOf(entry.semester, entry.name)) || null;

  function addEntry(entry) {
    const exists = state.entries.some(
      (item) => item.semester === entry.semester && item.name === entry.name,
    );
    if (exists) { notify.warning(`${entry.semester} 已經有「${entry.name}」了`); return false; }
    state.entries.push({ score: "", ...entry });
    return true;
  }

  function removeEntry(entry) {
    state.entries = state.entries.filter((item) => item !== entry);
    persist();
  }

  /* ============================ 共用小塊 ============================ */

  function bar(earned, need) {
    const ratio = need > 0 ? Math.min(1, earned / need) : (earned > 0 ? 1 : 0);
    return el("div", { class: "cm-bar", role: "img", "aria-label": `${earned} / ${need}` },
      el("span", { class: "cm-bar-fill", style: `width:${(ratio * 100).toFixed(1)}%` }));
  }

  const flag = (met) => el("span", { class: met ? "cm-flag is-ok" : "cm-flag" }, met ? "✓" : "✕");

  /* ============================ 總覽 ============================ */

  function renderSummary(result) {
    const cards = el("div", { class: "cm-cards" },
      ...SCALE_KEYS.map((scale) => el("div", { class: "cm-card" },
        el("div", { class: "cm-card-label" }, `累進 GPA (${scale})`),
        el("div", { class: "cm-card-value" }, round(result.overall.gpa[scale])))),
      el("div", { class: "cm-card" },
        el("div", { class: "cm-card-label" }, "已取得學分"),
        el("div", { class: "cm-card-value" }, `${round(result.total.earned)}`),
        el("div", { class: "cm-card-note" }, `／ ${result.total.need}`)),
      el("div", { class: "cm-card" },
        el("div", { class: "cm-card-label" }, "加權平均"),
        el("div", { class: "cm-card-value" }, round(result.overall.weighted))),
    );

    const thresholds = el("table", { class: "cm-table" },
      el("thead", {}, el("tr", {},
        el("th", {}, "類別"), el("th", { class: "is-num" }, "已修"), el("th", { class: "is-num" }, "應修"),
        el("th", {}, "進度"), el("th", {}, ""))),
      el("tbody", {},
        ...result.buckets.map((bucket) => el("tr", {},
          el("td", {}, bucket.label,
            bucket.note ? el("span", { class: "cm-hint" }, ` ${bucket.note}`) : null),
          el("td", { class: "is-num" }, round(bucket.earned)),
          el("td", { class: "is-num" }, String(bucket.need)),
          el("td", {}, bar(bucket.earned, bucket.need)),
          el("td", {}, flag(bucket.met)))),
        el("tr", { class: "cm-total" },
          el("td", {}, "總學分"),
          el("td", { class: "is-num" }, round(result.total.earned)),
          el("td", { class: "is-num" }, String(result.total.need)),
          el("td", {}, bar(result.total.earned, result.total.need)),
          el("td", {}, flag(result.total.met)))),
    );

    const picks = el("div", { class: "cm-rules" }, ...result.picks.map((group) => el("div", {
      class: group.met ? "cm-rule is-ok" : "cm-rule",
    },
      el("div", { class: "cm-rule-head" },
        flag(group.met), el("strong", {}, group.label),
        el("span", { class: "cm-hint" }, `${group.have} / ${group.need} 門`)),
      el("div", { class: "cm-chips" }, ...group.courses.map((course) => el("span", {
        class: course.passed ? "cm-chip is-ok" : course.taken ? "cm-chip is-taken" : "cm-chip",
        title: course.passed ? "已通過" : course.taken ? "已修但未及格" : "尚未修",
      }, course.name))),
    )));

    const liberal = el("div", { class: "cm-rules" },
      el("div", { class: result.liberal.met ? "cm-rule is-ok" : "cm-rule" },
        el("div", { class: "cm-rule-head" },
          flag(result.liberal.met), el("strong", {}, "通識博雅"),
          el("span", { class: "cm-hint" }, `${round(result.liberal.earned)} / ${result.liberal.need} 學分`)),
        bar(result.liberal.earned, result.liberal.need),
        el("div", { class: "cm-dims" }, ...result.liberal.dimensions.map((dimension) => el("div", {
          class: "cm-dim",
        },
          flag(dimension.met),
          el("span", { class: "cm-dim-name" }, dimension.name),
          el("span", { class: "cm-hint" }, `${round(dimension.earned)}/${dimension.need}`)))),
        result.liberal.unassigned > 0
          ? el("div", { class: "cm-hint" }, `不分向度 ${round(result.liberal.unassigned)} 學分`)
          : null),
    );

    const others = el("div", { class: "cm-rules" },
      result.coreLabs ? el("div", { class: result.coreLabs.met ? "cm-rule is-ok" : "cm-rule" },
        el("div", { class: "cm-rule-head" },
          flag(result.coreLabs.met), el("strong", {}, "基礎實驗課程"),
          el("span", { class: "cm-hint" }, `${result.coreLabs.have} / ${result.coreLabs.need} 門`)),
        el("div", { class: "cm-chips" }, ...result.coreLabs.items.map((item) => el("span", {
          class: item.passed ? "cm-chip is-ok" : "cm-chip", title: item.semester,
        }, item.name)))) : null,
      result.mustPass.length ? el("div", {
        class: result.mustPass.every((item) => item.passed) ? "cm-rule is-ok" : "cm-rule",
      },
        el("div", { class: "cm-rule-head" },
          flag(result.mustPass.every((item) => item.passed)), el("strong", {}, "必須修習")),
        el("div", { class: "cm-chips" }, ...result.mustPass.map((item) => el("span", {
          class: item.passed ? "cm-chip is-ok" : "cm-chip",
        }, item.name)))) : null,
    );

    const semesterTable = el("table", { class: "cm-table" },
      el("thead", {}, el("tr", {},
        el("th", {}, "學期"), el("th", { class: "is-num" }, `GPA (${state.scale})`),
        el("th", { class: "is-num" }, "平均"), el("th", { class: "is-num" }, "加權平均"),
        el("th", { class: "is-num" }, "學分"), el("th", { class: "is-num" }, "排名"),
        el("th", { class: "is-num" }, "排名%"))),
      el("tbody", {}, ...result.semesters.map((semester) => el("tr", {},
        el("td", {}, semester.label),
        el("td", { class: "is-num" }, round(semester.gpa[state.scale])),
        el("td", { class: "is-num" }, round(semester.average)),
        el("td", { class: "is-num" }, round(semester.weighted)),
        el("td", { class: "is-num" }, round(semester.credits)),
        el("td", { class: "is-num" }, semester.rank ?? "—"),
        el("td", { class: "is-num" }, semester.rankPercent == null ? "—" : `${semester.rankPercent}%`)))),
    );

    const blockers = result.graduated
      ? el("div", { class: "banner banner-success" }, "所有畢業門檻都達成了。")
      : el("div", { class: "cm-blockers" },
        el("div", { class: "cm-blockers-head" }, `還差 ${result.blockers.length} 項`),
        el("ul", {}, ...result.blockers.map((text) => el("li", {}, text))));

    return el("div", {},
      cards, blockers,
      subhead("畢業門檻"), thresholds,
      subhead("必選修群組"), picks,
      subhead("通識博雅"), liberal,
      subhead("其他門檻"), others,
      subhead("各學期"), semesterTable,
      subhead("歷年趨勢"), trendChart(result),
      subhead("各類學分占比"), creditPie(result),
    );
  }

  /**
   * 環圈的一塊。
   *
   * 每段都切成不超過 90 度再畫, 這樣 large-arc-flag 永遠是 0, 
   * 也順便解決「只有一類學分時要畫整圈」的問題 ——
   * 起點與終點重合的單一弧線, SVG 會什麼都不畫。
   */
  function ringSlice(from, to, inner, outer, cx, cy) {
    const at = (angle, radius) => [
      (cx + Math.cos(angle) * radius).toFixed(2),
      (cy + Math.sin(angle) * radius).toFixed(2),
    ];
    const steps = Math.max(2, Math.ceil((to - from) / (Math.PI / 2)));
    const step = (to - from) / steps;

    let d = `M${at(from, outer).join(" ")}`;
    for (let i = 1; i <= steps; i++) d += `A${outer} ${outer} 0 0 1 ${at(from + step * i, outer).join(" ")}`;
    d += `L${at(to, inner).join(" ")}`;
    for (let i = steps - 1; i >= 0; i--) d += `A${inner} ${inner} 0 0 0 ${at(from + step * i, inner).join(" ")}`;
    return `${d}Z`;
  }

  /** 各類學分占比。環圈中間放總學分。 */
  function creditPie(result) {
    const slices = result.buckets
      .map((bucket, index) => ({ label: bucket.label, value: bucket.earned, index }))
      .filter((slice) => slice.value > 0);
    const total = slices.reduce((sum, slice) => sum + slice.value, 0);
    if (!total) {
      return el("p", { class: "tool-note" }, "填了成績之後這裡會出現各類學分的占比。");
    }

    const size = 210;
    const cx = size / 2;
    const cy = size / 2;
    let angle = -Math.PI / 2;   // 從十二點鐘方向開始

    const paths = slices.map((slice) => {
      const from = angle;
      angle += (slice.value / total) * Math.PI * 2;
      return s("path", {
        class: `cm-slice cm-slice-${slice.index}`,
        d: ringSlice(from, angle, 56, 92, cx, cy),
      }, s("title", {}, `${slice.label} ${round(slice.value)} 學分（${Math.round(slice.value / total * 100)}%）`));
    });

    return el("div", { class: "cm-pie-wrap" },
      s("svg", {
        class: "cm-pie", viewBox: `0 0 ${size} ${size}`,
        role: "img", "aria-label": `各類學分占比, 總共 ${round(total)} 學分`,
      },
        ...paths,
        s("text", { class: "cm-pie-total", x: cx, y: cy - 2, "text-anchor": "middle" }, round(total)),
        s("text", { class: "cm-pie-unit", x: cx, y: cy + 14, "text-anchor": "middle" }, "學分"),
      ),
      el("div", { class: "cm-pie-legend" }, ...result.buckets.map((bucket, index) => el("div", {
        class: "cm-pie-item",
      },
        el("span", { class: `cm-pie-dot cm-slice-${index}` }),
        el("span", { class: "cm-pie-name" }, bucket.label),
        el("span", { class: "cm-hint" },
          `${round(bucket.earned)} / ${bucket.need}`
          + (total ? `　${Math.round(bucket.earned / total * 100)}%` : "")),
      ))),
    );
  }

  /**
   * GPA 與加權平均的趨勢圖。
   * 兩條線量級差很多（GPA 0–4.3、分數 0–100）, 各自用自己的軸: 左 GPA、右分數。
   */
  function trendChart(result) {
    const points = result.semesters
      .map((semester, index) => ({ ...semester, index }))
      .filter((semester) => semester.gpa[state.scale] != null || semester.weighted != null);
    if (!points.length) {
      return el("p", { class: "tool-note" }, "填了成績之後這裡會出現歷年趨勢。");
    }

    const width = 640;
    const height = 220;
    const pad = { top: 16, right: 44, bottom: 28, left: 40 };
    const count = result.semesters.length;
    const maxGpa = Number(state.scale);
    const x = (index) => pad.left + (index / Math.max(1, count - 1)) * (width - pad.left - pad.right);
    const yGpa = (value) => height - pad.bottom - (value / maxGpa) * (height - pad.top - pad.bottom);
    const yScore = (value) => height - pad.bottom - (value / 100) * (height - pad.top - pad.bottom);

    const line = (accessor, scaler, className) => {
      const usable = points.filter((item) => accessor(item) != null);
      if (!usable.length) return null;
      // 只有一個學期就只畫點: polyline 至少要兩個點才連得起來。
      return s("g", { class: className },
        usable.length > 1 ? s("polyline", {
          points: usable.map((item) => `${x(item.index).toFixed(1)},${scaler(accessor(item)).toFixed(1)}`).join(" "),
        }) : null,
        ...usable.map((item) => s("circle", {
          cx: x(item.index).toFixed(1), cy: scaler(accessor(item)).toFixed(1), r: 3,
        })),
      );
    };

    return el("div", { class: "cm-chart-wrap" },
      el("div", { class: "cm-legend" },
        el("span", { class: "cm-legend-item is-gpa" }, `GPA (${state.scale})`),
        el("span", { class: "cm-legend-item is-score" }, "加權平均")),
      s("svg", {
        class: "cm-chart", viewBox: `0 0 ${width} ${height}`, width: "100%",
        role: "img", "aria-label": "各學期 GPA 與加權平均趨勢",
      },
        ...[0, 0.25, 0.5, 0.75, 1].map((fraction) => {
          const y = pad.top + fraction * (height - pad.top - pad.bottom);
          return s("g", {},
            s("line", { class: "cm-grid", x1: pad.left, y1: y, x2: width - pad.right, y2: y }),
            s("text", { class: "cm-axis", x: pad.left - 6, y: y + 3, "text-anchor": "end" },
              round(maxGpa * (1 - fraction), 1)),
            s("text", { class: "cm-axis", x: width - pad.right + 6, y: y + 3 },
              String(Math.round(100 * (1 - fraction)))));
        }),
        ...result.semesters.map((semester, index) => s("text", {
          class: "cm-axis", x: x(index), y: height - 8, "text-anchor": "middle",
        }, semester.label.replace("大", ""))),
        line((item) => item.weighted, yScore, "cm-line-score"),
        line((item) => item.gpa[state.scale], yGpa, "cm-line-gpa"),
      ));
  }

  /* ============================ 成績輸入 ============================ */

  function renderInput(result) {
    const semesterPicker = select({
      options: curriculum.semesters.map((label) => ({
        value: label,
        label: semesterOptionLabel(label, result),
      })),
      value: openSemester,
      onChange: () => { openSemester = semesterPicker.value; picker = null; paint(); },
    });
    liveSemesterSelect = semesterPicker;

    const mine = state.entries.filter((entry) => entry.semester === openSemester);
    const rows = mine.map((entry) => {
      const course = curriculumCourse(entry);
      const resolved = result.rows.find(
        (candidate) => candidate.semester === entry.semester && candidate.name === entry.name,
      );

      const score = numberInput({
        value: entry.score ?? "", min: "0", max: "100", step: "1",
        placeholder: "分數",
        onInput: () => { entry.score = score.value; save(); refreshDerived(); },
      });
      score.classList.add("cm-score");
      // 自己加的課那一列會有兩個數字輸入框（學分、分數）緊鄰著, 
      // 沒有標籤的話很容易把分數打進學分欄。
      score.setAttribute("aria-label", `${entry.name} 的分數`);
      score.dataset.field = "score";

      // 課表上的課, 學分與類別是學校定的, 不讓改；自己加的才給編輯。
      let creditCell;
      let categoryCell;
      if (course) {
        creditCell = el("td", { class: "is-num" }, String(course.credit));
        categoryCell = el("td", { class: "cm-cat" }, course.category);
      } else {
        const credit = numberInput({
          value: entry.credit ?? "", min: "0", step: "0.5",
          placeholder: "學分",
          onInput: () => { entry.credit = credit.value; save(); refreshDerived(); },
        });
        credit.classList.add("cm-score");
        credit.setAttribute("aria-label", `${entry.name} 的學分`);
        credit.dataset.field = "credit";
        const category = select({
          options: CATEGORY_OPTIONS,
          value: entry.category || "",
          onChange: () => { entry.category = category.value || undefined; persist(); },
        });
        category.classList.add("cm-mini");
        creditCell = el("td", {}, credit);
        categoryCell = el("td", {}, category);
      }

      const isLiberal = /向度|^博雅/.test(entry.name) || entry.dimension;
      const dimension = isLiberal
        ? select({
          options: [
            { value: "", label: "不分向度" },
            ...curriculum.liberal.dimensions.map((name) => ({ value: name, label: name })),
          ],
          value: entry.dimension || "",
          onChange: () => { entry.dimension = dimension.value || undefined; persist(); },
        })
        : null;
      if (dimension) dimension.classList.add("cm-mini");

      const points = el("td", { class: "is-num cm-cat" }, resolved ? round(resolved.points[state.scale]) : "");
      const tr = el("tr", { class: resolved ? (resolved.passed ? "is-pass" : "is-fail") : "" },
        el("td", {},
          entry.name,
          course?.mark ? el("span", { class: "cm-mark", title: "必選修群組" }, course.mark) : null,
          dimension ? el("div", { class: "cm-row-extra" }, dimension) : null),
        categoryCell,
        creditCell,
        el("td", {}, score),
        points,
        el("td", {}, el("button", {
          type: "button", class: "cm-remove", title: "移除這門課", "aria-label": `移除 ${entry.name}`,
          onclick: () => removeEntry(entry),
        }, el("span", { html: icon("x", { size: "13px" })}))),
      );
      liveRows.push({ entry, row: tr, points });
      return tr;
    });

    const rank = state.ranks[openSemester] || {};
    const rankInput = numberInput({
      value: rank.rank ?? "", min: "1", step: "1",
      onInput: () => {
        state.ranks[openSemester] = { ...state.ranks[openSemester], rank: rankInput.value || null };
        save();
      },
    });
    const percentInput = numberInput({
      value: rank.percent ?? "", min: "0", max: "100", step: "0.1",
      onInput: () => {
        state.ranks[openSemester] = { ...state.ranks[openSemester], percent: percentInput.value || null };
        save();
      },
    });

    return el("div", {},
      row(field("學期", semesterPicker)),

      mine.length
        ? el("table", { class: "cm-table cm-input" },
          el("thead", {}, el("tr", {},
            el("th", {}, "課程"), el("th", {}, "類別"), el("th", { class: "is-num" }, "學分"),
            el("th", {}, "分數"), el("th", { class: "is-num" }, `積點 (${state.scale})`), el("th", {}, ""))),
          el("tbody", {}, ...rows))
        : el("p", { class: "tool-note" }, `${openSemester}還沒有課。按下面的「新增課程」加。`),

      picker ? renderPicker() : actions(button("＋ 新增課程", {
        variant: "primary",
        onClick: () => { picker = { source: "semester", query: "" }; paint(); },
      })),

      subhead("學期排名"),
      note("排名是學校公布的, 工具算不出來, 填進來只是跟成績放在一起看。"),
      row(field("班排名", rankInput), field("排名百分比", percentInput)),
    );
  }

  /* ============================ 新增課程 ============================ */

/**
   * 挑選清單的來源。
   *
   * 博雅那幾項是固定列出來的, 不是等全校清單載進來才長出來 ——
   * 選項要靠載入才出現的話, 想加博雅課的人根本看不到這個入口。
   * 向度名稱課程標準裡就有, 真正需要全校清單的是課程本身, 選到才載。
   */
  function pickerSources() {
    return [
      { value: "semester", label: `${openSemester}課表` },
      { value: "curriculum", label: "我的課表（全部學期）" },
      { value: "liberal:*", label: "通識博雅（全部）" },
      ...curriculum.liberal.dimensions.map((name) => ({
        value: `liberal:${name}`,
        label: `通識博雅－${name}`,
      })),
      { value: "all", label: "全校課程" },
    ];
  }

  /** 這個來源要不要用到全校課程清單。 */
  const needsPool = (source) => source === "all" || source.startsWith("liberal:");

  /** 依來源與關鍵字算出候選課程。 */
  function pickerResults() {
    const query = picker.query.trim().toLowerCase();
    const already = new Set(
      state.entries.filter((entry) => entry.semester === openSemester).map((entry) => entry.name),
    );
    const match = (name, code) => !query
      || name.toLowerCase().includes(query) || String(code || "").includes(query);

    if (picker.source === "semester" || picker.source === "curriculum") {
      const scope = picker.source === "semester"
        ? (bySemester.get(openSemester) || [])
        : curriculum.courses;
      return scope
        .filter((course) => match(course.name, course.code))
        .filter((course) => !(picker.source === "semester" && already.has(course.name)))
        .map((course) => ({
          name: course.name, credit: course.credit, code: course.code,
          meta: `${course.category}${picker.source === "curriculum" ? `・${course.semester}` : ""}`,
          category: course.category, mark: course.mark,
          fromCurriculum: course.semester === openSemester,
        }));
    }

    if (!pool) return [];

    /** 選了某個向度時, 只留掛在那個向度底下的課。 */
    const wantedDimension = picker.source.startsWith("liberal:") ? picker.source.slice(8) : null;
    const liberalOf = (course) => course.divisions
      .map((code) => pool.divisionByCode.get(code))
      .find((division) => division?.liberal);

    return pool.courses
      .filter((course) => {
        if (!wantedDimension) return true;
        const liberal = liberalOf(course);
        if (!liberal) return false;
        return wantedDimension === "*" || liberal.dimension === wantedDimension;
      })
      .filter((course) => match(course.name, course.code))
      .map((course) => {
        // 博雅課程的向度就是它掛在哪個通識中心的系所底下。
        const liberal = course.divisions
          .map((code) => pool.divisionByCode.get(code))
          .find((division) => division?.liberal);
        const owner = pool.divisionByCode.get(course.divisions[0]);
        return {
          name: course.name, credit: course.credit, code: course.code,
          meta: liberal ? `博雅・${liberal.dimension || "不分向度"}` : (owner?.name || ""),
          category: liberal ? "校定共同必修" : "",
          dimension: liberal ? (liberal.dimension || "") : "",
          fromCurriculum: curriculumIndex.has(keyOf(openSemester, course.name)),
        };
      });
  }

  function renderPicker() {
    const source = select({
      options: pickerSources(),
      value: picker.source,
      onChange: async () => {
        const next = source.value;
        // 全校與博雅都要那份大清單, 第一次用到才載。
        if (needsPool(next) && !pool) {
          source.disabled = true;
          try { await ensurePool(); } catch (error) { notify.danger(error.message); source.value = picker.source; return; }
          finally { source.disabled = false; }
        }
        picker.source = next;
        paint();
      },
    });

    const search = textInput({
      value: picker.query,
      placeholder: "搜尋課名或課號…",
      onInput: () => { picker.query = search.value; refreshList(); },
    });

    const list = el("div", { class: "cm-picker-list" });
    const count = el("span", { class: "cm-hint" });

    function refreshList() {
      const found = pickerResults();
      count.textContent = `${found.length} 門`;
      list.replaceChildren(...found.slice(0, 200).map((course) => el("button", {
        type: "button",
        class: "cm-picker-row",
        onclick: () => {
          const added = addEntry({
            semester: openSemester,
            name: course.name,
            // 課表上的課不存學分與類別, 交給課表查 —— 學校改了學分數, 
            // 使用者的資料會自動跟著更新。
            ...(course.fromCurriculum ? {} : {
              credit: String(course.credit ?? ""),
              ...(course.category ? { category: course.category } : {}),
              ...(course.dimension ? { dimension: course.dimension } : {}),
            }),
            ...(course.code ? { code: course.code } : {}),
          });
          if (added) { picker = null; persist(); }
        },
      },
        el("span", { class: "cm-picker-name" }, course.name,
          course.mark ? el("span", { class: "cm-mark" }, course.mark) : null),
        el("span", { class: "cm-picker-meta" }, course.meta),
        el("span", { class: "cm-picker-credit" }, `${course.credit} 學分`),
        el("span", { class: "cm-picker-add" }, "＋"),
      )));
      if (!found.length) {
        list.appendChild(el("p", { class: "tool-note" },
          picker.query ? "沒有符合的課程。" : "這個來源沒有課程。"));
      }
    }

    refreshList();

    return el("div", { class: "cm-picker" },
      el("div", { class: "cm-picker-head" },
        el("strong", {}, `新增課程到 ${openSemester}`),
        count,
        el("button", {
          type: "button", class: "cm-remove", title: "關閉", "aria-label": "關閉",
          onclick: () => { picker = null; paint(); },
        }, el("span", { html: icon("x", { size: "13px" }) }))),
      row(field("來源", source), field("搜尋", search)),
      list,
      note("挑「全校課程」或「博雅」時會載入一份 3000 多門課的清單（約 320 KB）, 只載一次。"),
    );
  }

  /* ============================ 同步 ============================ */

  function renderSync() {
    const sheetInput = textInput({
      value: state.sheetUrl,
      placeholder: "https://docs.google.com/spreadsheets/d/…",
      onInput: () => { state.sheetUrl = sheetInput.value; saveLocal(state); },
    });
    const scriptInput = textInput({
      value: state.scriptUrl,
      placeholder: "https://script.google.com/macros/s/…/exec",
      onInput: () => { state.scriptUrl = scriptInput.value; saveLocal(state); },
    });

    const task = (label, variant, work) => {
      const node = button(label, { variant, onClick: async () => {
        node.disabled = true;
        const original = node.textContent;
        node.textContent = "處理中…";
        try { await work(); } finally { node.disabled = false; node.textContent = original; }
      } });
      return node;
    };

    const adopt = (entries, ranks) => {
      state.entries = (entries || []).map((entry) => ({ ...entry, score: String(entry.score ?? "") }));
      if (ranks) state.ranks = ranks;
      persist();
    };

    return el("div", {},
      subhead("① 讀取  Google Sheet"),
      note("Sheet 的共用權限要設成「知道連結的人」可以檢視。只會讀取資料。"),
      field("Google Sheet 連結", sheetInput),
      actions(task("從 Sheet 讀取", "ghost", async () => {
        try {
          const entries = await readSheet(state.sheetUrl);
          adopt(entries, null);
          notify.success(`讀進 ${entries.length} 筆成績`);
        } catch (error) { notify.danger(`讀取失敗: ${error.message}`); }
      })),

      subhead("② 寫入 Google Sheet"),
      note("使用 Apps Script 來寫入 Sheet。第一次要部署一次, 之後就可以直接存取。"),
      el("ol", { class: "cm-steps" },
        el("li", {}, "在 Sheet 上開「擴充功能 → Apps Script」"),
        el("li", {}, "把下面整段程式貼進去, 取代原本的內容, 存檔"),
        el("li", {}, "按「部署 → 新增部署作業 → 類型選『網頁應用程式』」"),
        el("li", {}, "「執行身分」選 我, 「誰可以存取」選 ", el("strong", {}, "任何人")),
        el("li", {}, "按部署、授權, 複製最後那個 ", el("code", {}, "/exec"), " 網址貼到下面")),
      el("div", { class: "cm-code" },
        actions(copyButton(() => APPS_SCRIPT, { label: "複製程式碼" })),
        el("pre", {}, el("code", {}, APPS_SCRIPT))),
      field("Apps Script 部署網址", scriptInput),
      actions(
        task("儲存到 Sheet", "primary", async () => {
          try {
            const result = await pushToScript(state.scriptUrl, { ...state, entries: namedEntries() });
            notify.success(`已存 ${result.saved ?? namedEntries().length} 筆到你的 Sheet`);
          } catch (error) { notify.danger(`儲存失敗: ${error.message}`); }
        }),
        task("從 Sheet 讀回", "ghost", async () => {
          try {
            const result = await pullFromScript(state.scriptUrl);
            adopt(result.entries, result.ranks);
            notify.success(`讀回 ${(result.entries || []).length} 筆成績`);
          } catch (error) { notify.danger(`讀回失敗: ${error.message}`); }
        }),
      ),

      subhead("其他"),
      actions(
        copyButton(() => toTable(namedEntries()), { label: "複製成表格" }),
        button("清除這台瀏覽器的資料", {
          onClick: () => {
            if (!confirm("會清掉這台瀏覽器裡的成績（Sheet 上的不會動）。要繼續嗎？")) return;
            clearLocal();
            state = blankState();
            paint();
            notify.success("已清除");
          },
        }),
      ),
      note("「複製成表格」複製的是定位字元分隔的表格, 直接貼進 Sheet 就會自動分欄。"),
    );
  }

  /* ============================ 組裝 ============================ */

  const viewTabs = segmented([
    { value: "summary", label: "總覽" },
    { value: "input", label: "成績輸入" },
    { value: "sync", label: "同步" },
  ], { value: view, onChange: (next) => { view = next; picker = null; paint(); } });
  viewTabs.classList.add("cm-seg");

  const scaleTabs = segmented(SCALE_KEYS.map((scale) => ({ value: scale, label: `GPA ${scale}` })), {
    value: state.scale,
    onChange: (next) => { state.scale = next; persist(); },
  });
  scaleTabs.classList.add("cm-seg");

  /**
   * 只有一顆鈕的分頁鈕, 當開關用。
   * 外框與選到時翻白的樣式都跟上面的「檢視」「GPA 級距」共用 .tool-seg, 
   * 一眼看得出是同一類控制項。用 <button aria-pressed> 而不是
   * <input type=checkbox>, 螢幕閱讀器照樣讀得到按下與否。
   */
  const failedButton = el("button", {
    type: "button",
    class: state.includeFailed ? "tool-seg is-active" : "tool-seg",
    "aria-pressed": String(state.includeFailed),
    onclick: () => {
      state.includeFailed = !state.includeFailed;
      failedButton.classList.toggle("is-active", state.includeFailed);
      failedButton.setAttribute("aria-pressed", String(state.includeFailed));
      persist();
    },
  }, "含不及格科目");
  const failedToggle = el("div", { class: "tool-segmented cm-seg" }, failedButton);

  function paint() {
    const result = summarise(namedEntries(), curriculum, {
      includeFailed: state.includeFailed,
      ranks: state.ranks,
    });
    // 上一輪的節點都要丟掉了, 參考也一起清掉, 免得抓著已經不在畫面上的東西。
    liveRows = [];
    liveSemesterSelect = null;
    board.replaceChildren(
      view === "summary" ? renderSummary(result)
        : view === "input" ? renderInput(result)
          : renderSync(),
    );
    setStatus(result);
  }

  host.appendChild(panel(
    row(
      field("檢視", viewTabs),
      field("GPA 級距", scaleTabs),
      field("平均分數", failedToggle),
    ),
    board,
    info,
    note(
      "課程與畢業門檻取自北科大 ",
      el("a", { href: curriculum.source, target: "_blank", rel: "noopener" }, "課程標準"),
      "。目前的課表是 ",
      el("strong", {}, curriculum.program.heading.replace(" 課程科目表", "")),
      ", 「新增課程」可以挑全校任何一門課。",
    ),
  ));

  paint();
  return null;
}
