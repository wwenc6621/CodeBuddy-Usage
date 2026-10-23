# Change Log

[English](./CHANGELOG.en.md) | 简体中文

所有值得注意的变更都会记录在此文件。

## [0.9.4]

### 修复

- 修复「登录已过期」点击后无法恢复：原先点击只会弹出 Access Token 输入框，
  而登录失效的正确解法是「重新登录 + 重读登录态」。现在点击状态栏会弹出修复菜单
  （重新读取登录态并刷新 / 手动输入 Token / 清除手动 Token / 打开官网用量页）。
- 修复 401 重试时复用同一个失效 token：`invalidateAuth()` 默认不会解除「本次会话不再读系统凭据」
  的封锁，导致重试必然失败并直接显示「登录已过期」。现在重试前会解除封锁并真正重读一次登录态。
- 修复把 HTTP 403 误判为登录过期：403 可能来自网关/WAF 或权限不足，现在单独报 `HTTP_403`，
  不再误导用户去重新登录。
- 修复内置 SQLite 解析器读不到最新数据：`state.vscdb` 以 WAL 模式打开时，CodeBuddy 刚刷新过的
  accessToken 可能还只在 `state.vscdb-wal` 里，旧实现只读主库，因此一直拿到旧 token
  （Windows 上没有 `sqlite3` 命令，只能走内置解析器，问题最明显）。
- 修复 macOS 上第一个候选宿主的钥匙串条目不存在时直接放弃整个自动读取（提示
  `keychain access denied`）：条目不存在（`security` 退出码 44）不会弹授权框，
  现在会继续尝试下一个宿主，多 IDE 共存的机器也能读到 CodeBuddy 的登录态。

### 移除

- 移除 `codebuddyUsage.userAgent` 配置项：UA 仅在早期 Cookie 模式下与登录态强绑定，
  改用 accessToken 鉴权后不再参与鉴权，固定使用内置浏览器 UA 即可。

## [0.9.3]

### 修复

- 修复 Windows 上自动读取始终失败（反复提示 `credential store unavailable`）：
  Windows PowerShell 5.1 默认没有加载 `System.Security` 程序集，调用 DPAPI 前必须先
  `Add-Type -AssemblyName System.Security`，否则找不到 `ProtectedData` 类型。

### 变更

- 自动读取失败时的提示改为给出具体原因（Local State 路径、DPAPI 报错摘要、解密失败等），便于定位问题。
- Windows 上某个候选宿主失败会继续尝试下一个（DPAPI 不弹窗）；macOS 钥匙串被拒则立即停止，避免连环弹授权框。

## [0.9.2]

### 新增

- **自动读取 CodeBuddy 登录态（accessToken 模式）**：在 VS Code 中安装 CodeBuddy 扩展并登录后，
  扩展直接读取其登录态里的 `accessToken`（JWT），以 `Authorization: Bearer` 调用接口，
  不再需要 Cookie，也不受 Cookie 快速失效、与 UA 强绑定的困扰。
- **token 持久化缓存（钥匙串只读一次）**：首次读到的 token 写入扩展自己的 SecretStorage
  （VS Code 负责加解密，读写不需要任何授权），此后直到 token 临近过期（约 60 天）都不再访问钥匙串；
  钥匙串读取失败时本次会话不再重试，避免反复弹授权框。
- 新增 `codebuddyUsage.accessToken` 配置与命令 **`CodeBuddy Usage: 输入 Access Token（自动读取失败时）`**，
  作为自动读取失败后的唯一手动兜底；留空提交表示清除并重新尝试自动读取。
- 悬浮框 `Remaining` 行右侧展示凭据有效期（如 `有效期至 11-14`），仅在读取失败时提示未登录。
- **支持 Windows 自动读取**：从 `<userData>/Local State` 取 DPAPI 保护的密钥（经 PowerShell 调用 DPAPI），
  再用 AES-256-GCM 解密登录态，全程无需手动交互。
- 读取 state.vscdb 依次尝试 `node:sqlite` → 系统 `sqlite3` → **内置最小 SQLite 解析器**，
  不再强依赖外部命令（Windows 上没有 `sqlite3`）。

### 变更

- **移除 Cookie 模式**：删除 `codebuddyUsage.cookie` 配置与「设置登录凭证（Cookie + User-Agent）」命令，
  鉴权统一走 accessToken。
- 未配置凭据的提示由「未设置 Cookie」改为「未找到登录凭据」，401 提示由「Cookie 已失效」改为「登录已过期」，
  并在悬浮提示中附带具体原因（例如钥匙串被拒）。

### 说明

- 解密本地登录态必须访问系统钥匙串（macOS），这是 macOS 的安全模型、无法绕过；
  通过「持久化缓存 + 失败即停」把访问频率降到约 60 天一次。首次弹窗点「始终允许」即可。
- 自动读取支持 macOS（钥匙串）与 Windows（DPAPI）；Linux 的 safeStorage 走 keyring，暂未适配，请手动输入 `accessToken`。
- 扩展**不调用 refreshToken**：CodeBuddy 自己会刷新并写回最新 token，扩展每次重读即可，
  避免两边互相轮换把登录态挤掉。

## [0.8.3]

### 新增

- 领取积分后若接口未返回数量，自动从旅行记录接口取本趟旅行的 `reward_credit` 回填，
  提示显示真实到账积分（如「已领取 8 积分」）。`status` 接口的 `reward_credit` 实测恒为 0，不可用于展示。

### 修复

- 修复领取成功却完全没有通知：`claim` 响应的 `credit` 缺失或为 0 时被误判为「无可领取」而静默。
  现在只要服务端确认领取成功就提示；数量拿不到时提示不带数量，不再静默。
- 修复「一日一次」领取守卫导致当天第二趟旅行的积分不被领取（如跨天旅行 + 当天新旅行，
  一天内本应领取两次）：改为「旅行标识变化」或「旅行刚结束」任一命中即领取。
- 领取失败仍会在下轮刷新重试，但失败警告一日最多弹一次，避免每 30 分钟刷新反复打扰。

## [0.8.2]

### 修复

- 修复出发时长仍误报 0 小时：0.8.1 的回查逻辑要求 `depart` 响应的时长字段为 `null` /
  `undefined` 才触发，而该字段实际返回的是占位值 `0`（`??` 不会跳过 0），
  导致始终没走到回查 `status` 的分支。现在 `depart` 成功后一律以 `status` 接口
  登记的 `duration_hours` 为准（与网页展示一致），仅当 `status` 取不到时才退回
  `depart` 响应中的正数字段。

## [0.8.1]

### 修复

- 修复派喵喵弹窗误报「travel time 0 hours」：`depart` 接口的成功响应并不总带
  `duration_hours` / `duration` 字段，旧逻辑直接兜底成 0，与网页展示的真实时长
  （如 2 小时）不符。现在解析不到时长时会回查 `status` 接口，优先取
  `duration_hours`，否则由 `arrive_at` 与 `depart_at` 的时间差推算，与网页口径一致。

## [0.8.0]

### 新增

- **双语界面（英文 / 简体中文）**：界面语言跟随 VS Code 显示语言。
  清单文案走 `package.nls.json` / `package.nls.zh-cn.json`，运行时文案走 `vscode.l10n.t()`
  与 `l10n/bundle.l10n.zh-cn.json`；英文为内置默认语言，无需额外文件。
- 英文文档：`README.en.md` 与 `CHANGELOG.en.md`。

### 变更

- 精简英文悬浮框文案（状态标签、表头、汇总行等），宽度与中文版持平，避免表格被撑宽后列内换行。

### 修复

- 悬浮框里「总量」的跳转链接原先硬编码 `.cn`，现改为跟随 `apiBase` 配置。

## [0.7.0]

### 新增

- 喵喵旅行补上通知提醒：自动流程本次真正**领到积分**或**派出喵喵成功**时，
  弹出与签到一致的信息提示（一次刷新合并为一条汇总提示）。
- 手动点击悬浮框「领积分」「去旅行」现在总是有反馈：
  领取成功 / 无可领取 / 失败都会提示（此前 `0 积分` 与失败分支完全静默）。

### 修复

- 喵喵领积分、出发失败原先只写进悬浮框标签，不弹任何提示，容易被忽略。

### 文档

- 修正 README「自动签到」一节自相矛盾的表述：早已签到才静默，首次领取成功是会提示的。

## [0.5.0]

### 新增

- **User-Agent 可配置**：新增 `codebuddyUsage.userAgent` 配置项。
  服务端签发会话时会绑定完整 UA，后续请求 UA 不一致即返回 401，
  且相邻 Chrome 版本互不通用。留空则使用内置默认值 `Chrome/153`。
- 设置凭证时连续弹出两个输入框（Cookie → User-Agent），标题标注 `(1/2)` `(2/2)`，
  任一步按 `Esc` 整体取消，不会写入不配对的半个凭证。
- 保存后回显实际生效的 UA 版本，便于确认是否真的写入。

### 变更

- 命令 `设置登录 Cookie` 更名为 `设置登录凭证（Cookie + User-Agent）`。
- README 新增「关于 User-Agent」章节，说明 UA 与会话绑定的实测结论。

### 修复

- 修正「粘贴的 User-Agent 又变回默认值」的问题：
  原 Webview 表单设置 `retainContextWhenHidden: false`，面板被隐藏
  （切到浏览器复制）时 JS 上下文被销毁，切回后重建导致输入被重置。
  现改为原生输入框，不存在该生命周期问题。

## [0.4.0]

### 新增

- 喵喵旅行：自动领取积分并派出喵喵，悬浮框展示倒计时与手动操作链接。
- 悬浮框底部展示当日签到状态标签。

## [0.3.0]

### 新增

- 自动每日签到领取积分。
