# JG cd 在 ogame v12 的捕获路径

## 背景 — 为什么有这个文档

owner 多版本反复踩 "JG 跳完 cd 没显示" 问题。根因 forensic 抓到 (v0.0.945 `JG-JQ-AJAX`):

```json
v12 executeJump 真 response:
{
  "status": true,
  "targetMoon": 33653080,
  "errorbox": {"type":"notify","title":"確定","text":"已成功實施空間跳躍.",...},
  "components": [],
  "newAjaxToken": "..."
}
```

**v12 response 完全没有 cooldown / nextActionAt / 任何 cd 字段**。老 memory `feedback_jg_cd_response_native` 写的 "executeJump JSON 自带 resp.cooldown" 是**过时的** (v0.0.755 时候有，v12 拿掉了)。

api_executor.ts 老 success 路径 `resp.cooldown ?? resp.nextActionAt` 永远拿 null → 不 commit → PG cd 字段空 → panel 没显示。

## v12 cd 真值在哪里

owner 实证 paste 的 widget DOM:

```html
<p class="countdown" id="cooldown">21分 29秒</p>
```

**cd 在 rendered DOM 的 `<p id="cooldown">` 的 textContent**, 是已经被 jQuery 渲染成本地化文字的 countdown。不是 attribute, 不是 inline JS 变量, 不是 JSON 字段。

## 解析策略 — 为什么用 LocalizationStrings

i18n 是真问题。ogame 27 个 locale 用不同 unit chars:
- zh-TW: `21分 29秒` (時/分/秒)
- en: 可能 `21min 29sec` 或 HH:MM:SS
- de: `21Min 29Sek`
- 等等

**禁止 multi-fallback regex 蒙 (per memory `feedback_no_defensive_fallback`)**。正路: 读 ogame 自己暴露的 `window.LocalizationStrings.timeunits.short`:

```js
LocalizationStrings.timeunits.short = {
  year: "年", month: "月", week: "週", day: "日",
  hour: "時", minute: "分", second: "秒"
}
```

每个 locale 的 ogame UI 都用这个 object 作为本地化 unit chars。**用它的值作为 regex unit char 是 0 猜的真值源**。

## 实现 — boot.ts sniffer 内的 JG-JQ-AJAX wrap

位置: `packages/runtime-userscript/src/boot.ts` 的 jQuery.ajax wrap success callback。

流程:

1. **executeJump POST 拦截** → 缓存 `targetSpaceObjectId` 到 sessionStorage (key `OGAMEX_JG_LAST_TGT`)
2. **overlay GET success 拦截** → `setTimeout(500)` 等 ogame jQuery 渲染 widget DOM
3. 读 `document.getElementById("cooldown").textContent` → 拿到本地化字符串
4. 读 `window.LocalizationStrings.timeunits.short` → 拿到当前 locale 的 hour/minute/second chars
5. 用 `\d+\s*${escaped(unit_char)}` regex 分别 match 三个数字
6. 算 total = h\*3600 + m\*60 + s
7. 读 `<meta name="ogame-planet-id">` → src moon id
8. 从 sessionStorage 取 tgt moon id (之前缓存的)
9. postMessage `ogamex:jumpgateEvent` 含 srcMoonId / targetMoonId / cooldownSec
10. boot.ts isolated context 的 `ogamex:jumpgateEvent` handler 走 `commitCooldown` → `setPlanetsPatch` 双边写 PG

## 双边 cd

ogame v12 JG cd 是 bilateral (src 跟 tgt 都进 cd, per `feedback_jg_bilateral_cd`)。我们 src+tgt 都拿到了 (src 从 meta, tgt 从缓存), `commitCooldown` 双边写。

如果 owner 打开 widget 但 sessionStorage 里没 tgt (例如直接刷新页面后开 widget), 我们**只能 commit src**, tgt 等下次 owner 在 tgt 月球开 widget 时各自 commit。这是可接受降级。

## 不准猜 & 不准 fallback (per memory)

- ❌ multi-regex shotgun "试 5 条 pattern 哪条命中": 错命中比 null 更坏
- ❌ `?? 3600/level`: 老 ogame 公式 v12 不适用 (per v0.0.921)
- ✅ ogame 自己的 `LocalizationStrings.timeunits.short`: 跟 ogame UI 本身同源, 永远对齐

## Forensic tags

| tag | 触发 | 用途 |
|-----|------|------|
| `JG-CLICK-v0945` | 跳跃 button click capture phase | 抓 url + form body |
| `JG-JQ-AJAX-v0945` | jQuery.ajax success on jump\|executeJump url | 抓 url + body + 完整 response |
| `JG-CD-DOM-v0946` | overlay GET success → setTimeout 500 → DOM parse | 抓 cd text + lu + parsed h/m/s/total |

任一 tag 命中走 sidecar journal `[debug-log:TAG]`, 可直接 grep audit。

## 维护契约

- 任何 sidecar 上想拿 JG cd 的 consumer: **只信 PG `planets[*].jumpgate_cooldown_sec` + `jumpgate_harvested_at`**
- 不再尝试 parse executeJump response 拿 cd (v12 真没有, parse 一定 null)
- 如果 ogame 哪天又把 cd 放回 JSON, 加快路径不删慢路径 (DOM scrape 仍是兜底)

## 历史 incident timeline

| 版本 | 事件 |
|------|------|
| ≤ v0.0.754 | 各种猜 cd 公式 / scrape fallback |
| v0.0.755 | 信 executeJump response.cooldown / nextActionAt (当时对的, 已过时) |
| v0.0.823-826 | JG cd sync 给 planner |
| v0.0.830-836 | bilateral cd 写双边 |
| v0.0.919 | XHR 路径 isExecutePost hasNotReady fallback |
| v0.0.920 | 3600/level 公式兜底 |
| v0.0.921 | 撤 v0.0.920 公式 (owner "v12 数据不同") |
| v0.0.943-944 | sniffer 加 forensic POST, 拿 raw response |
| v0.0.945 | jQuery.ajax wrap + button click capture (绕过 ogame cache 原生 XHR 的问题) |
| **v0.0.946** | **DOM scrape #cooldown + LocalizationStrings i18n parse** |
