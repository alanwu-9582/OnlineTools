// js/tools/split-bill/index.js — 分帳結算。
//
// 一群人出去玩，誰付了什麼、誰有份，最後算出誰要轉給誰多少。

import {
  panel, row, field, textInput, numberInput, select, button, actions,
  copyButton, status, note, subhead, el, icon,
} from "../kit.js";
import { computeBalances, settle, asText, fmt } from "./settle.js";
import { load, save, clear } from "./storage.js";

export const styles = new URL("./split-bill.css", import.meta.url).href;

export const meta = { title: "分帳結算" };

const DEFAULT = {
  members: ["小明", "小華", "小美"],
  expenses: [{ title: "晚餐", amount: 1200, payer: "小明", participants: null }],
};

export function mount(host) {
  const saved = load();
  let members = (saved?.members?.length ? saved.members : DEFAULT.members).slice();
  let expenses = (saved?.expenses?.length ? saved.expenses : DEFAULT.expenses)
    .map((e) => ({ ...e }));
  let result = { balances: {}, transfers: [], total: 0 };

  /* ---------------- 成員 ---------------- */

  const memberList = el("div", { class: "sb-members" });
  const memberInput = textInput({
    placeholder: "輸入名字後按 Enter",
    onInput: () => { addMember.disabled = !memberInput.value.trim(); },
  });
  memberInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    commitMember();
  });
  const addMember = button("加入", { variant: "primary", onClick: commitMember });
  addMember.disabled = true;

  function commitMember() {
    const name = memberInput.value.trim();
    if (!name) return;
    if (members.includes(name)) {
      flash(`「${name}」已經在名單裡了`);
      return;
    }
    members.push(name);
    memberInput.value = "";
    addMember.disabled = true;
    memberInput.focus();
    renderAll();
  }

  function removeMember(name) {
    members = members.filter((m) => m !== name);
    // 這個人付的帳要改人，不然那筆錢會憑空消失。
    for (const item of expenses) {
      if (item.payer === name) item.payer = members[0] || "";
      if (Array.isArray(item.participants)) {
        item.participants = item.participants.filter((p) => p !== name);
      }
    }
    renderAll();
  }

  function renderMembers() {
    memberList.replaceChildren(...members.map((name) => el("span", { class: "sb-chip" },
      name,
      el("button", {
        type: "button", class: "sb-chip-x",
        "aria-label": `移除 ${name}`,
        title: `移除 ${name}`,
        onclick: () => removeMember(name),
      }, "×"),
    )));
    if (!members.length) {
      memberList.appendChild(el("span", { class: "sb-empty" }, "還沒有人"));
    }
  }

  /* ---------------- 支出 ---------------- */

  const expenseList = el("div", { class: "sb-expenses" });

  /** participants 是 null 代表「全部人分」，成員變動時自動跟著走。 */
  const partsOf = (item) => (Array.isArray(item.participants)
    ? item.participants.filter((p) => members.includes(p))
    : members.slice());

  function renderExpenses() {
    expenseList.replaceChildren(...expenses.map((item, index) => expenseRow(item, index)));
    if (!expenses.length) {
      expenseList.appendChild(el("div", { class: "sb-empty" }, "還沒有支出"));
    }
  }

  function expenseRow(item, index) {
    const title = textInput({
      value: item.title || "",
      placeholder: "項目",
      onInput: () => { item.title = title.value; persist(); },
    });
    const amount = numberInput({
      value: String(item.amount ?? ""),
      min: "0", step: "1", placeholder: "金額",
      onInput: () => { item.amount = Number(amount.value); recompute(); },
    });
    const payer = select({
      options: members.map((m) => ({ value: m, label: m })),
      value: members.includes(item.payer) ? item.payer : (members[0] || ""),
      onChange: () => { item.payer = payer.value; recompute(); },
    });
    if (!members.includes(item.payer)) item.payer = members[0] || "";

    const chosen = new Set(partsOf(item));
    const boxes = el("div", { class: "sb-participants" }, members.map((name) => {
      const box = el("input", {
        type: "checkbox", class: "tool-check",
        oninput: () => {
          if (box.checked) chosen.add(name); else chosen.delete(name);
          item.participants = members.filter((m) => chosen.has(m));
          recompute();
        },
      });
      box.checked = chosen.has(name);
      return el("label", { class: "tool-flag sb-participant" }, box, el("span", {}, name));
    }));

    const all = button("全選", {
      onClick: () => { item.participants = null; renderExpenses(); recompute(); },
    });
    const remove = el("button", {
      type: "button", class: "sb-remove",
      "aria-label": "刪掉這筆", title: "刪掉這筆",
      html: icon("x", { size: "15px" }),
      onclick: () => { expenses.splice(index, 1); renderAll(); },
    });

    return el("div", { class: "sb-expense" },
      el("div", { class: "sb-expense-head" },
        row(
          field("項目", title),
          field("金額", amount),
          field("誰付的", payer),
        ),
        remove,
      ),
      el("div", { class: "sb-expense-who" },
        el("span", { class: "sb-who-label" }, "誰分攤"),
        boxes,
        all,
      ),
    );
  }

  const addExpense = button("加一筆支出", {
    variant: "primary", iconName: "arrowRight",
    onClick: () => {
      expenses.push({ title: "", amount: 0, payer: members[0] || "", participants: null });
      renderAll();
    },
  });

  /* ---------------- 結果 ---------------- */

  const balanceTable = el("div", { class: "sb-balances" });
  const transferList = el("div", { class: "sb-transfers" });
  const info = status();
  const copyResult = copyButton(
    () => asText({ members, balances: result.balances, transfers: result.transfers, total: result.total }),
    { label: "複製結果" },
  );
  const reset = button("全部清除", {
    onClick: () => {
      members = DEFAULT.members.slice();
      expenses = DEFAULT.expenses.map((e) => ({ ...e }));
      clear();
      renderAll();
      flash("已清空，回到預設的範例");
    },
  });

  function recompute() {
    persist();
    // participants 是 null 代表「全部人分」，那是給 UI 用的簡寫。
    // 算式那一層只認實際名單，要先展開，不然整筆會被當成沒人分攤而跳過。
    const resolved = expenses.map((item) => ({ ...item, participants: partsOf(item) }));
    const { balances, total, skipped } = computeBalances(members, resolved);
    const transfers = settle(balances);
    result = { balances, transfers, total };

    balanceTable.replaceChildren(...members.map((name) => {
      const v = balances[name] || 0;
      const settledUp = v === 0;
      return el("div", { class: `sb-balance${settledUp ? " is-even" : v > 0 ? " is-plus" : " is-minus"}` },
        el("span", { class: "sb-balance-name" }, name),
        el("span", { class: "sb-balance-value" },
          settledUp ? "剛好" : v > 0 ? `多付 ${fmt(v)}` : `少付 ${fmt(-v)}`),
      );
    }));

    transferList.replaceChildren(...transfers.map((t) => el("div", { class: "sb-transfer" },
      el("span", { class: "sb-transfer-from" }, t.from),
      el("span", { class: "sb-transfer-arrow" }, "→"),
      el("span", { class: "sb-transfer-to" }, t.to),
      el("span", { class: "sb-transfer-amount" }, fmt(t.amount)),
    )));
    if (!transfers.length) {
      transferList.appendChild(el("div", { class: "sb-empty" },
        result.total > 0 ? "不用轉，剛好打平。" : "還沒有可以結算的支出。"));
    }

    const messages = [`總支出 ${fmt(total)} 元，${members.length} 人`];
    if (transfers.length) messages.push(`${transfers.length} 筆轉帳就結清`);
    if (skipped) messages.push(`有 ${skipped} 筆沒算進去（金額是 0、沒選付款人或沒人分攤）`);
    info.set(messages.join(" · "), skipped ? "warn" : "ok");
    copyResult.disabled = !members.length;
  }

  function renderAll() {
    renderMembers();
    renderExpenses();
    recompute();
  }

  function persist() {
    save({ members, expenses });
  }

  function flash(message) {
    info.set(message, "warn");
  }

  host.appendChild(panel(
    subhead("有誰"),
    memberList,
    row(field("加入成員", memberInput), field(" ", addMember)),

    subhead("花了什麼"),
    expenseList,
    actions(addExpense),

    subhead("結果"),
    balanceTable,
    transferList,
    info,
    actions(copyResult, reset),
    note("轉帳筆數用貪婪法壓到「欠最多的先還給該收最多的」，人數 N 最多 N−1 筆。嚴格的最少筆數是 NP-hard，這裡不保證絕對最少，但實務上幾乎都是最好的解。"),
  ));

  renderAll();
  return null;
}
