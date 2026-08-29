// js/tools/split-bill/settle.js — 分帳的算法。這一層不碰 DOM。

/** 金額一律取整數元，避免結算結果出現零錢。 */
const toUnits = (n) => Math.round(Number(n));

/**
 * 把一筆金額拆給 n 個人，尾差指定給其中一個人吞掉。
 * 1000 分 3 人 = 334 / 333 / 333 —— 總和精確等於 1000。
 */
function share(units, n, absorber = 0) {
  const base = Math.floor(units / n);
  const rest = units - base * n;
  return Array.from({ length: n }, (_, i) => {
    // 尾差從吞的人開始往後發，每人最多多 1 分。
    const offset = (i - absorber + n) % n;
    return base + (offset < rest ? 1 : 0);
  });
}

/**
 * 算出每個人的淨額。
 *
 * @param {string[]} members
 * @param {Array<{amount:number, payer:string, participants:string[]}>} expenses
 * @returns {{balances:Object<string,number>, paid:Object<string,number>,
 *            owed:Object<string,number>, total:number, skipped:number}}
 *   金額單位都是元（已經處理過尾差，加總會精確歸零）。
 */
export function computeBalances(members, expenses) {
  const paid = {};
  const owed = {};
  for (const name of members) { paid[name] = 0; owed[name] = 0; }

  let total = 0;
  let skipped = 0;
  for (const item of expenses) {
    const units = toUnits(item.amount);
    const people = (item.participants || []).filter((p) => members.includes(p));
    if (!units || !people.length || !members.includes(item.payer)) { skipped += 1; continue; }
    total += units;
    paid[item.payer] += units;
    // 讓付錢的人吞尾差 —— 他本來就經手最多，多負擔一元最不會有人有意見。
    const absorber = Math.max(0, people.indexOf(item.payer));
    const parts = share(units, people.length, absorber);
    people.forEach((p, i) => { owed[p] += parts[i]; });
  }

  const balances = {};
  for (const name of members) balances[name] = paid[name] - owed[name];
  return {
    balances,
    paid,
    owed,
    total,
    skipped,
  };
}

/**
 * 把淨額結算成一串轉帳。
 *
 * 反覆把「欠最多的」配給「該收最多的」，這樣每做一筆至少有一個人歸零，
 * 所以筆數一定不超過 人數 − 1。
 *
 * 注意：真正的「最少轉帳次數」是 NP-hard，這個貪婪法不保證絕對最少，
 * 實務上幾乎都是最佳解。不要對外宣稱它是最少。
 *
 * @returns {Array<{from:string, to:string, amount:number}>}
 */
export function settle(balances) {
  const debtors = [];
  const creditors = [];
  for (const [name, value] of Object.entries(balances)) {
    const units = Math.round(value);
    if (units < 0) debtors.push({ name, units: -units });
    else if (units > 0) creditors.push({ name, units });
  }
  debtors.sort((a, b) => b.units - a.units || a.name.localeCompare(b.name));
  creditors.sort((a, b) => b.units - a.units || a.name.localeCompare(b.name));

  const transfers = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].units, creditors[j].units);
    transfers.push({ from: debtors[i].name, to: creditors[j].name, amount });
    debtors[i].units -= amount;
    creditors[j].units -= amount;
    if (debtors[i].units === 0) i += 1;
    if (creditors[j].units === 0) j += 1;
  }
  return transfers;
}

/** 貼回群組用的純文字。 */
export function asText({ members, balances, transfers, total }) {
  const lines = [`總支出 ${fmt(total)} 元，${members.length} 人`, ""];
  for (const name of members) {
    const v = balances[name] || 0;
    if (v === 0) lines.push(`${name}　剛好`);
    else if (v > 0) lines.push(`${name}　多付 ${fmt(v)}`);
    else lines.push(`${name}　少付 ${fmt(-v)}`);
  }
  lines.push("", transfers.length ? "怎麼轉：" : "不用轉，剛好打平。");
  for (const t of transfers) lines.push(`${t.from} → ${t.to}　${fmt(t.amount)}`);
  return lines.join("\n");
}

/** split-bill 的金額一律顯示為整數。 */
export function fmt(n) {
  return String(Math.round(n));
}
