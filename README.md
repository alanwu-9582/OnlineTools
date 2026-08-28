# OnlineTools

線上工具箱：純靜態、沒有後端，所有工具都在瀏覽器裡跑，輸入的資料不會離開使用者的電腦。
內容用 Markdown 寫，前端用 hash 路由（`#/home`、`#/tools`、`#/entry?id=…`）在瀏覽器端渲染。

網站上有三種東西：

| 種類 | 是什麼 | 放在哪 |
| --- | --- | --- |
| **工具** | Markdown 內文裡嵌了一個互動工具 | `content/tools/` + `js/tools/` |
| **教學文檔** | 純 Markdown | `content/docs/` |
| **其他工具** | 別人做的工具網站連結 | `data/links.json` |

工具與文檔的檔頭寫法完全一樣，差別只在工具的 `.md` 裡放了一個 `<div data-tool="…"></div>`。

## 本機預覽

必須用 HTTP 伺服器開，直接用 `file://` 會因為瀏覽器限制而載入失敗。

```bash
npx --yes http-server . -p 8788 -c-1
```

沒有 Node 的話，Python 內建的也可以：

```bash
python -m http.server 8788
```

## 新增一個工具

### 1. 寫工具模組

在 `js/tools/` 建一個檔案，檔名就是工具 id（小寫英數與連字號）。模組要 export 一個 `mount`：

```js
// js/tools/gear-ratio.js
import { panel, row, field, numberInput, outputRow } from "./kit.js";

export const meta = { title: "齒輪比" };

export function mount(host, { options = {} } = {}) {
  const driving = numberInput({ value: "12", onInput: update });
  const driven = numberInput({ value: "60", onInput: update });
  const ratio = outputRow("減速比");

  function update() {
    const a = Number(driving.value);
    ratio.set(a > 0 ? `${(Number(driven.value) / a).toFixed(3)} : 1` : "");
  }

  host.appendChild(panel(
    row(field("主動齒數", driving), field("被動齒數", driven)),
    ratio,
  ));

  update();
  return null;   // 有計時器或全域監聽時回傳 cleanup 函式
}
```

共用元件都在 `js/tools/kit.js`：`panel`、`row`、`field`、`textInput`、`numberInput`、
`textArea`、`select`、`segmented`、`button`、`outputRow`、`outputBlock`、`status`、`note`、`subhead`。
用它們做出來的工具長相會一致，也自動跟著主題變數走。

### 2. 寫內容

在 `content/tools/` 建 `.md`，檔名建議與工具 id 相同：

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

後面繼續寫文字、表格、圖片。
```

佔位可以放在內文任何位置，一頁也可以放好幾個不同的工具。
要帶預設值就加 `data-options`（外層單引號、裡面 JSON 用雙引號）：

```md
<div data-tool="unit-converter" data-options='{"group":"temperature"}'></div>
```

模組在 `mount(host, { options })` 的 `options` 收到它。

### 3. 更新資料

```bash
node tools/build-data.mjs
```

## 新增一篇教學文檔

一樣的檔頭，放進 `content/docs/`，不放 `data-tool` 就好。然後跑一次 `build-data.mjs`。

## 檔頭欄位

| 欄位 | 必填 | 說明 |
| --- | --- | --- |
| `title` | 是 | 顯示的標題。 |
| `description` | 建議 | 一句話說明，會出現在列表與首頁卡片。 |
| `category` | 是 | 定義在 `data/site.json` 的 `categories`。 |
| `tags` | 建議 | 逗號分隔，可多個；定義在 `data/site.json` 的 `tags`。 |
| `published time` | 是 | 發佈日期，格式 `年/月/日`。 |
| `cover` | 否 | 封面圖。只寫檔名時會去 `assets/images/covers/` 找。 |
| `type` | 否 | `tool` 或 `doc`。不填就依資料夾判斷。 |

「最後更新」不用自己填，會從 git 紀錄自動抓（不是 git 專案時退回發佈日期）。

## 放圖片

圖片放在 `assets/images/content/`，建議每一頁一個資料夾：

```text
assets/images/content/gear-ratio/wiring.png
```

內文用相對路徑就好（會自動補上 `assets/images/content/`）：

```md
![接線方式](gear-ratio/wiring.png)
```

方括號裡填簡短說明，滑鼠移到圖片上會顯示，點圖片可以放大。

## 更新資料

```bash
node tools/build-data.mjs
```

會重新產生兩個檔案：

- `data/entries.json` — 工具與文檔的清單
- `data/search-index.json` — 全文搜尋索引（內文與程式碼都會被搜到）

**這兩個檔案是自動產生的，不要手動編輯。** 出現 `!` 開頭的訊息就照著修 ——
它會檢查工具模組存不存在、類別與標籤有沒有定義過、有沒有工具沒被任何頁面用到。

想確認有沒有忘記更新：

```bash
node tools/build-data.mjs --check
```

## 改站台內容

| 想改什麼 | 改哪裡 |
| --- | --- |
| 站名、標語、說明 | `data/site.json` |
| 類別與標籤（名稱、顏色） | `data/site.json` 的 `categories` / `tags` |
| 其他工具的連結與分類 | `data/links.json` |
| 顏色、字體、圓角、間距 | `css/theme.css`（全站唯一的來源） |
| 工具本身的樣式 | `css/tools.css` |

## 專案結構

```text
content/tools/      工具頁的 Markdown
content/docs/       教學文檔的 Markdown
js/tools/           工具模組（一個工具一個檔），kit.js 是共用元件
assets/images/      圖示、封面、內文插圖
data/               設定與自動產生的資料
  site.json           站台資訊、類別與標籤（手動維護）
  links.json          其他工具（手動維護）
  entries.json        自動產生，勿手動編輯
  search-index.json   自動產生，勿手動編輯
tools/build-data.mjs  產生上面兩個 JSON
js/                 前端程式（core 路由 / pages 各頁 / ui 元件 / utils 工具 / tools 各工具）
css/                樣式（theme 變數 / layout / components / catalog / viewer / tools / pages）
pages/              各頁面的 HTML 片段
sw.js               離線快取
```

## 離線支援

網站有註冊 Service Worker（`sw.js`）：有網路時一律讀最新版本，沒網路時用先前載入過的內容。
工具模組是動態載入的，所以**新增工具時要記得把它加進 `sw.js` 的 `SHELL` 清單**，
並把 `CACHE_VERSION` 往上加一版，不然離線時那個工具會掛不起來。

## 一條原則

工具跑在使用者的瀏覽器裡，**不要把輸入送到任何地方**。
這是這個網站相對於其他線上工具站最大的差別，任何一個工具都不該破壞這個前提。
