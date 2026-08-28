// js/tools/timestamp.js — Unix 時間戳與日期互轉。
//
// 兩個方向各一塊，中間夾一個一直在跳的「現在」。
// 時間戳的單位（秒／毫秒）預設用位數自動判斷 —— 貼進來的值幾乎都是
// 十位數的秒或十三位數的毫秒，猜錯的成本比每次手動選還高。

import {
  panel, row, field, textInput, select, outputRow, status, note, subhead, el,
} from "./kit.js";

export const meta = { title: "時間戳轉換" };

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

const pad = (n, width = 2) => String(Math.abs(n)).padStart(width, "0");

/** 本地時區的 `YYYY/MM/DD HH:mm:ss（週X）`。 */
function formatLocal(date) {
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `（週${WEEKDAYS[date.getDay()]}）`;
}

/** UTC 的同一個時刻。 */
function formatUTC(date) {
  return `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}`
    + ` ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} UTC`;
}

/** 目前時區相對 UTC 的偏移，例如 UTC+08:00。 */
function offsetLabel(date) {
  const minutes = -date.getTimezoneOffset();
  const sign = minutes >= 0 ? "+" : "-";
  return `UTC${sign}${pad(Math.floor(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`;
}

/** 「3 天前 / 2 小時後」。 */
function relative(ms) {
  const diff = ms - Date.now();
  const future = diff > 0;
  const abs = Math.abs(diff);
  const steps = [
    [1000, "秒"], [60, "分鐘"], [60, "小時"], [24, "天"], [30, "個月"], [12, "年"],
  ];
  let value = abs;
  let unit = "毫秒";
  for (const [size, name] of steps) {
    if (value < size) break;
    value /= size;
    unit = name;
  }
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${rounded} ${unit}${future ? "後" : "前"}`;
}

/** datetime-local 需要 `YYYY-MM-DDTHH:mm:ss` 這種本地時間字串。 */
function toLocalInputValue(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 依位數猜單位，回傳毫秒。 */
function toMillis(value, unit) {
  if (unit === "s") return value * 1000;
  if (unit === "ms") return value;
  if (unit === "us") return value / 1000;
  const abs = Math.abs(value);
  if (abs >= 1e14) return value / 1000;   // 微秒
  if (abs >= 1e11) return value;          // 毫秒
  return value * 1000;                    // 秒
}

export function mount(host) {
  /* ---------- 現在 ---------- */
  const nowSeconds = outputRow("Unix 秒");
  const nowMillis = outputRow("Unix 毫秒");
  const nowLocal = outputRow("本地時間");

  const tick = () => {
    const now = new Date();
    nowSeconds.set(Math.floor(now.getTime() / 1000));
    nowMillis.set(now.getTime());
    nowLocal.set(`${formatLocal(now)}　${offsetLabel(now)}`);
  };
  const timer = setInterval(tick, 1000);
  tick();

  /* ---------- 時間戳 → 日期 ---------- */
  const stampInput = textInput({
    value: String(Math.floor(Date.now() / 1000)),
    mono: true,
    placeholder: "1700000000",
    onInput: fromStamp,
  });
  const unitSelect = select({
    options: [
      { value: "auto", label: "自動判斷" },
      { value: "s", label: "秒" },
      { value: "ms", label: "毫秒" },
      { value: "us", label: "微秒" },
    ],
    value: "auto",
    onChange: fromStamp,
  });
  const stampLocal = outputRow("本地時間");
  const stampUTC = outputRow("UTC");
  const stampISO = outputRow("ISO 8601");
  const stampRel = outputRow("相對現在");
  const stampStatus = status();

  function fromStamp() {
    const raw = stampInput.value.trim().replace(/[\s_,]/g, "");
    const value = raw === "" ? NaN : Number(raw);
    const outs = [stampLocal, stampUTC, stampISO, stampRel];
    if (!Number.isFinite(value)) {
      stampInput.classList.toggle("is-invalid", raw !== "");
      stampStatus.set(raw ? "這不是一個數字。" : "", "error");
      for (const out of outs) out.set("");
      return;
    }
    stampInput.classList.remove("is-invalid");
    const ms = toMillis(value, unitSelect.value);
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) {
      stampStatus.set("超出可表示的時間範圍。", "error");
      for (const out of outs) out.set("");
      return;
    }
    stampLocal.set(`${formatLocal(date)}　${offsetLabel(date)}`);
    stampUTC.set(formatUTC(date));
    stampISO.set(date.toISOString());
    stampRel.set(relative(ms));
    stampStatus.set(
      unitSelect.value === "auto" ? `判斷為${ms === value ? "毫秒" : ms === value * 1000 ? "秒" : "微秒"}` : "",
      "ok",
    );
  }

  /* ---------- 日期 → 時間戳 ---------- */
  const dateInput = el("input", {
    type: "datetime-local",
    class: "tool-input is-mono",
    step: "1",
    value: toLocalInputValue(new Date()),
    oninput: fromDate,
  });
  const dateSeconds = outputRow("Unix 秒");
  const dateMillis = outputRow("Unix 毫秒");
  const dateISO = outputRow("ISO 8601");
  const dateStatus = status();

  function fromDate() {
    const raw = dateInput.value;
    const outs = [dateSeconds, dateMillis, dateISO];
    if (!raw) {
      dateStatus.set("請選一個日期時間。", "warn");
      for (const out of outs) out.set("");
      return;
    }
    // datetime-local 沒有時區，瀏覽器會當成本地時間解讀 —— 這正是想要的。
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) {
      dateStatus.set("看不懂這個日期。", "error");
      for (const out of outs) out.set("");
      return;
    }
    dateSeconds.set(Math.floor(date.getTime() / 1000));
    dateMillis.set(date.getTime());
    dateISO.set(date.toISOString());
    dateStatus.set(`以本地時區 ${offsetLabel(date)} 解讀`, "ok");
  }

  host.appendChild(panel(
    subhead("現在"),
    el("div", { class: "tool-outs" }, nowSeconds, nowMillis, nowLocal),

    subhead("時間戳 → 日期"),
    row(
      field("時間戳", stampInput),
      field("單位", unitSelect),
    ),
    el("div", { class: "tool-outs" }, stampLocal, stampUTC, stampISO, stampRel),
    stampStatus,

    subhead("日期 → 時間戳"),
    row(field("日期時間（本地）", dateInput)),
    el("div", { class: "tool-outs" }, dateSeconds, dateMillis, dateISO),
    dateStatus,

    note("Unix 時間戳是「從 1970/01/01 00:00:00 UTC 起算的秒數」，本身不帶時區；會不一樣的只有拿它換算出來的當地時間。"),
  ));

  fromStamp();
  fromDate();

  return () => clearInterval(timer);
}
