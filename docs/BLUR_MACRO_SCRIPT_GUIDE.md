# Blur Macro Script 指南

本文件說明 Macro 編輯器支援的命令與語法。每個命令獨立佔一行；區塊命令的 `{` 必須放在條件或命令之後，區塊內容從下一行開始。以 `#` 開頭的行是註解。

```bms
# 選取目標視窗，並執行一個簡單動作
target process="game.exe" title_contains="Game"
mode foreground
move x=500 y=300 space=screen duration=150ms
click button=left count=1
```

## 命令一覽

| 命令                      | 說明                               | 範例                                                                  |
| ------------------------- | ---------------------------------- | --------------------------------------------------------------------- |
| `target`                  | 設定目標視窗，可指定一個或多個條件 | `target process="game.exe" title_contains="Game" class="WindowClass"` |
| `mode`                    | 選擇前景或背景輸入模式             | `mode foreground`、`mode background strict=true`                      |
| `move`                    | 移動滑鼠游標                       | `move x=500 y=300 space=screen duration=150ms`                        |
| `click`                   | 點擊，可指定座標、按鍵、次數與範圍 | `click button=left x=500 y=300 count=2 radius=3`                      |
| `mouse_down` / `mouse_up` | 按住或放開滑鼠按鍵                 | `mouse_down button=right`                                             |
| `key_down` / `key_up`     | 按住或放開鍵盤按鍵                 | `key_down "CTRL"`                                                     |
| `press`                   | 按下一個按鍵或以 `+` 組成的快捷鍵  | `press "CTRL+S"`                                                      |
| `type`                    | 輸入文字                           | `type "Hello"`                                                        |
| `scroll`                  | 滾動滑鼠滾輪                       | `scroll delta=-120 x=500 y=300`                                       |
| `wait`                    | 等待指定時間                       | `wait 250ms`、`wait 2s`                                               |
| `let` / `set`             | 建立或更新變數                     | `let count = 0`、`set count = count + 1`                              |
| `repeat`                  | 重複執行區塊                       | 請參考下方多行範例                                                    |
| `while`                   | 條件成立時重複執行區塊             | 請參考下方多行範例                                                    |
| `if` / `else`             | 條件分支                           | 請參考下方多行範例                                                    |
| `log`                     | 寫入一筆執行記錄                   | `log "已完成"`                                                        |

## 滑鼠座標與選項

- 座標必須是 32 位元有號整數。
- `space=screen` 表示螢幕座標；`space=client` 表示目標視窗的用戶端座標。預設為 `screen`。
- `move` 必須提供 `x` 和 `y`，`duration` 可用毫秒 `ms` 或秒 `s`；預設為 `0`。
- `click` 的 `button` 可用 `left`、`right` 或 `middle`，預設為 `left`；`count` 預設為 `1`，範圍為 1 到 10000；`radius` 預設為 `0`。只有在指定座標時，`x` 和 `y` 必須一起提供。
- `scroll` 的 `delta` 必須是整數；正值與負值代表相反的滾動方向。座標 `x`、`y` 可省略，但不可只提供其中一個。
- `mouse_down` 和 `mouse_up` 的 `button` 可用 `left`、`right` 或 `middle`，預設為 `left`。

## 鍵盤與文字

按鍵名稱需是程式支援的鍵碼；常用名稱包括 `CTRL`、`SHIFT`、`ALT`、`WIN`、`ENTER`、`ESC`、`SPACE`、英文字母、數字、`F1`–`F24` 和 `NUMPAD0`–`NUMPAD9`。快捷鍵以 `+` 連接，例如 `press "CTRL+SHIFT+S"`。`type` 每行最多接受 10000 個 UTF-16 字元單位。

錄製器只會在開始錄製後擷取實體鍵盤事件，並將鍵名寫入本機錄製資料。IME 組字不會以文字形式記錄。

## Pick Point

開啟 Pick Point 後，在應用程式視窗外左鍵或右鍵點擊會新增對應按鍵的 click；按住任一鍵拖曳會新增 `mouse_down`、滑鼠移動和 `mouse_up`，用來重現平移。拖曳需要前景輸入，因此會將 Macro 模式切換為 `foreground`。按 Esc 或關閉 Pick Point 可結束。

## 變數、條件與區塊

表達式支援整數、`true` / `false`、變數、加減、比較運算子 `==`、`!=`、`<`、`<=`、`>`、`>=`、括號，以及 `window_exists(process="執行檔.exe")`（檢查指定執行檔的視窗是否存在）。`let` 用於建立變數，`set` 用於更新變數。

區塊必須如下換行；空區塊可以寫成 `{}`：

```bms
let count = 0
repeat 3 {
  click button=left
  wait 100ms
}

if window_exists(process="game.exe") {
  log "視窗存在"
} else {
  log "找不到視窗"
}
```

`repeat` 次數可為 0 到 1000000。迴圈執行時間仍受 Macro 執行器的中止與執行限制管理。

## 字串與限制

字串必須使用雙引號。支援跳脫字元 `\"`、`\\`、`\n`、`\r` 和 `\t`；字串不能直接跨行。程式上限為 1,000,000 bytes、50,000 個陳述式、32 層區塊巢狀，以及每個表達式 32 層巢狀 / 256 個節點。

未知命令、重複或不支援的選項、錯誤型別和超出範圍的值會在驗證時顯示錯誤。可以先在編輯器驗證，再執行 Macro。
