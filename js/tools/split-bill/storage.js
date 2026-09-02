// js/tools/split-bill/storage.js — 把輸入存在瀏覽器裡。
//
// 這個工具沒有保存等於不能用: 輸入十幾筆之後不小心重新整理就全沒了。
// 只存在這台電腦的這個瀏覽器，不會送到任何地方。

const KEY = "onlinetools.split-bill.v1";

/** 讀不到、壞掉、或瀏覽器根本不給用（無痕模式）都當成沒有存過。 */
export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!Array.isArray(data?.members) || !Array.isArray(data?.expenses)) return null;
    return data;
  } catch {
    return null;
  }
}

export function save(data) {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
    return true;
  } catch {
    // 無痕模式或空間滿了。存不起來不該讓工具當掉，就安靜地算了。
    return false;
  }
}

export function clear() {
  try {
    localStorage.removeItem(KEY);
  } catch { /* 同上，不值得為此中斷 */ }
}
