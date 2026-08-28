<!-- title: 怎麼加一個新工具 -->
<!-- description: 寫一個 js/tools 模組、在 Markdown 裡放一個佔位、跑一次 build，就完成了 -->
<!-- category: guide -->
<!-- tags: meta -->
<!-- published time: 2026/08/19 -->

這個網站的每一頁 —— 不管是工具還是教學 —— 都是一個 Markdown 檔。
差別只在於：**工具頁的內文裡放了一個佔位，渲染完之後會被換成真的工具。**

所以加工具跟寫文章是同一件事，只是多寫一個 JavaScript 模組。

## 三個步驟

### 1. 寫工具模組

**一個工具一個資料夾**，資料夾名稱就是這個工具的 id（小寫英文、數字、連字號），
進入點固定是 `index.js`：

```text
js/tools/gear-ratio/
  index.js          ← 進入點，一定要有
  gear-ratio.css    ← 選填，只有這個工具會用到的樣式
  ratio-math.js     ← 選填，拆多少個檔案是你自己的事
```

外面只認 `index.js`，裡面要怎麼拆隨你 —— 小工具就一個檔案，
複雜的可以像 `js/tools/paper-bag/` 那樣分成幾何、繪圖、動畫幾層。

```js
// js/tools/gear-ratio/index.js — 齒輪比計算。

import { panel, row, field, numberInput, outputRow, note } from "../kit.js";

export const meta = { title: "齒輪比" };

export function mount(host, { options = {} } = {}) {
  const driving = numberInput({ value: "12", onInput: update });
  const driven = numberInput({ value: "60", onInput: update });
  const ratio = outputRow("減速比");

  function update() {
    const a = Number(driving.value);
    const b = Number(driven.value);
    ratio.set(a > 0 ? `${(b / a).toFixed(3)} : 1` : "");
  }

  host.appendChild(panel(
    row(field("主動齒數", driving), field("被動齒數", driven)),
    ratio,
    note("減速比大於 1 代表轉速變慢、扭力變大。"),
  ));

  update();
  return null;   // 有計時器或全域監聽時，這裡回傳 cleanup 函式
}
```

`index.js` 的介面只有三個規定：

| 匯出 | 必要 | 說明 |
| --- | --- | --- |
| `mount(host, { options })` | 是 | 把 UI 掛到 `host` 上。回傳 cleanup 函式或 `null`。 |
| `meta` | 否 | `{ title }`，目前只是備註用途。 |
| `styles` | 否 | 這個工具自己的樣式表網址（或陣列）。 |

`options` 來自佔位元素的 `data-options`，等一下會講。

### 自己的樣式

只有這個工具會用到的 CSS 就放在自己的資料夾裡，用 `import.meta.url` 指過去：

```js
export const styles = new URL("./gear-ratio.css", import.meta.url).href;
```

`tool-host` 會在掛載**之前**把它載進來並等它下載完，所以不會先閃一下沒排版的樣子；
同一個網址只會載一次，而且沒用到這個工具的頁面完全不會去抓它。

跨工具共用的樣式（`.tool-panel`、`.tool-out` 那些）還是留在 `css/tools.css`。
判斷方式很簡單：**別的工具會不會用到？** 會就放共用的，不會就放自己的資料夾。

### 2. 寫內容

在 `content/tools/` 建 `.md`，檔名建議跟工具 id 一樣。
最上面用註解寫檔頭，**列表、搜尋、統計全都是從這裡自動產生的**：

```md
<!-- title: 齒輪比 -->
<!-- description: 算減速比與輸出轉速 -->
<!-- category: convert -->
<!-- tags: math -->
<!-- published time: 2026/08/19 -->

一段前言。

## 計算

<div data-tool="gear-ratio"></div>

## 原理

後面繼續寫文字、表格、圖片，想寫多少都可以。
```

佔位可以放在內文的**任何位置**，也可以在同一頁放好幾個不同的工具。
它就只是一個空的 `<div>`，前後照常是正常的 Markdown。

### 3. 更新資料

```bash
node tools/build-data.mjs
```

會重新產生兩個檔案：

- `data/entries.json` — 工具與文檔的清單
- `data/search-index.json` — 全文搜尋索引

**這兩個檔案是自動產生的，不要手動編輯。**
出現 `!` 開頭的訊息就照著修 —— 它會檢查工具模組存不存在、類別與標籤有沒有定義過。

想確認有沒有忘記更新：

```bash
node tools/build-data.mjs --check
```

## 檔頭欄位

| 欄位 | 必填 | 說明 |
| --- | --- | --- |
| `title` | 是 | 顯示的標題。 |
| `description` | 建議 | 一句話說明，會出現在列表與首頁卡片。 |
| `category` | 是 | 定義在 `data/site.json` 的 `categories`。 |
| `tags` | 建議 | 逗號分隔，可多個；定義在 `data/site.json` 的 `tags`。 |
| `published time` | 是 | 發佈日期，格式 `年/月/日`。 |
| `cover` | 否 | 封面圖。只寫檔名時會去 `assets/images/covers/` 找。 |
| `type` | 否 | `tool` 或 `doc`。不填就看放在哪個資料夾。 |

「最後更新」不用自己填，會從 git 紀錄自動抓。

## 傳參數給工具

同一個工具模組可以在不同頁面帶不同的預設值，用 `data-options` 傳一段 JSON：

```md
<div data-tool="unit-converter" data-options='{"group":"temperature"}'></div>
```

模組那邊在 `mount(host, { options })` 的 `options` 收到它。
注意外層用單引號、裡面的 JSON 用雙引號 —— 反過來寫 HTML 會解析失敗。

## 沒有 JavaScript 的時候

佔位元素原本的內容會一直留著，直到工具掛載成功才被換掉。
所以可以先寫一句備援訊息：

```md
<div data-tool="gear-ratio">這個工具需要 JavaScript。</div>
```

## kit.js 有什麼

`js/tools/kit.js` 收了所有工具共用的元件（放在資料夾外面，因為它不是工具），
用它們做出來的工具長相會一致：

| 函式 | 用途 |
| --- | --- |
| `panel(...)` | 工具最外層的外框 |
| `row(...)` | 一排會自動換行的欄位 |
| `field(label, control, hint)` | 幫控制項加標籤與說明 |
| `textInput` / `numberInput` / `textArea` / `select` | 各種輸入 |
| `segmented(items, cfg)` | 互斥的分頁鈕 |
| `button(label, cfg)` | 按鈕 |
| `outputRow(label)` | 單行結果，自帶複製鈕 |
| `outputBlock(cfg)` | 多行結果，自帶複製鈕 |
| `status()` | 一行狀態訊息（ok／warn／error） |
| `note(...)` | 補充說明 |
| `subhead(text)` | 把一個工具切成幾段 |

`outputRow` 與 `outputBlock` 回傳的節點上有 `.set(value)`，更新結果時直接呼叫。

