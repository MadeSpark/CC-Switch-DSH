# DSH round 2 交付报告（`4.0.14-dsh.3`）

## 本轮需求

本轮在 `4.0.14-dsh.2` 之上把四项 DSH 功能全部落到可运行的成品（版本 `4.0.14-dsh.3`），并保留个人分支与上游来源声明：

1. 统计 DSH 的 token 消耗（此前的 CCS 只是“模型列表管理器”，API 没走中转）。
2. DSH 设置区加开关：CCS 运行期间走本机中转，**用户主动退出 CCS 时把各 provider 的 `baseURL` 还原成原始直连地址**。
3. 模型预设支持“一键添加”：把刚调好的模型/参数直接存成预设，并可设为默认参数。
4. 支持 DSH 的推理等级（reasoning effort）设置，与 `dsh-desktop-ui-reasoning-effort` 插件的档位一致。

本轮不只是文档：源码、locale、Cargo/package 版本号与文档一起更新。

## 关键设计

- **不把 DSH 塞进 `PROXY_APPS`**：新增独立的 `/dsh/<providerId>/*` 字节级透传（`src-tauri/src/proxy/dsh_relay.rs`），响应体以流（`Body::from_stream`）转发且**不改写 JSON**，保证 DSH 侧仍能读到 `usage.inputTokens` / `cacheReadTokens`。
- **统计与中转解耦**：token 统计的主数据源是 DSH 会话日志导入器（`session.v4.jsonl.zstd`，含 cacheRead，口径与 DSH 自己一致），中转只是“让 CCS 也能看到实时请求”。任一路径缺失都不影响另一条。
- **还原语义**：退出时仅当 `dshRestoreOnExit && dsh_relay::is_attached()` 才还原，且只在“当前值仍等于记录的转发地址”时才写回，避免覆盖用户在 DSH 里的手工修改。崩溃/强杀留下的 `attached:true` 由启动自愈处理。

## 逐条实现

### 1. DSH token 消耗统计

- 导入器：`src-tauri/src/services/session_usage_dsh.rs`（`sync_dsh_usage` / `read_records` / `parse_usage_record` / `insert_record`），多帧 zstd 解码、`assistant/message` 与 `compaction/summary` 记录、`(size,mtime)` 文件级跳过 + `request_id = dsh:{session_id}:{record_id}` 去重、单次上限 512 个文件。
- 汇入统一统计：`src-tauri/src/services/session_usage.rs` 的全量同步入口调用导入器；`app_type = "dsh"`、`data_source = "dsh_session"`、provider 占位符 `_dsh_session` → 显示名 `DeepSeek Harness (Session)`（`src-tauri/src/services/usage_stats.rs`）。
- 用量页按应用筛选新增 DSH 品牌图标：`src/types/usage.ts`、`src/components/usage/appBrand.ts`、`src/components/usage/UsageDashboard.tsx`。
- 文档：`docs/DSH-TOKEN-USAGE.md`。

### 2. DSH 中转与退出还原

- 命令：`src-tauri/src/commands/dsh_relay.rs`（`dsh_relay_status` / `dsh_set_relay` / `dsh_set_restore_on_exit`），已在 `src-tauri/src/lib.rs` 注册。
- 服务：`src-tauri/src/services/dsh_relay.rs`（`attach` / `detach` / `restore_original` / `heal_on_startup` / 快照读写），侧车状态 `~/.cc-switch/dsh_relay_state.json`。
- 透传：`src-tauri/src/proxy/dsh_relay.rs` + `src-tauri/src/proxy/server.rs` 的两条 `/dsh/*` 路由（在 `DefaultBodyLimit` 之前注册）。
- 退出链路复用既有 `cleanup_before_exit`：`detach_all(...)` 之后调用 `restore_dsh_relay_on_exit()`，托盘退出、`app.exit(0)` 走同一条路。
- 设置：`dshRelayEnabled`（默认 false）/ `dshRestoreOnExit`（默认 true），前端 `src/lib/api/dsh.ts`、`src/lib/query/dsh.ts`、`src/components/settings/sections/DshSection.tsx`，侧栏“設定 → DSH 中轉”（`4.0.14-dsh.4` 起入口迁到应用页，见本节补充）。
- 文案：`dshRelay.*` 30 个键 × 5 语言（中/繁/英/日/土）。
- 文档：`docs/DSH-RELAY.md`。
- **补充（`4.0.14-dsh.4`）**：中转入口已从设置页迁到应用页——侧栏选 DeepSeek Harness 后，页头是「直连」和「路由」两个页签，中转开关、退出还原开关与地址映射都在「路由」页签里；设置页不再有「DSH 中转」分组，旧的 `section: "dsh"` 会落到设置页的「本地路由」。命令、默认值（`dshRelayEnabled=false`、`dshRestoreOnExit=true`）和侧车文件均未变，上面的 `dsh.3` 实测数据对应的是迁移前的界面。
- **补充（`4.0.14-dsh.5`）**：连接模式行改成 Claude Code 同款分段控件（圆角 `bg-subtle` 分组 + 滑块 + `?` 说明 + 生效状态行 + 右侧中转快捷开关），不再用下划线页签；「路由」这一侧本身就是中转设置，所以没有额外齿轮。详见 §6。

### 3. 一键模型预设与默认参数

- 表单：`src/components/providers/forms/DeepSeekHarnessFormFields.tsx` 的“保存为预设”（整个模型目录一次成预设）、“设为通用参数”（reasoning effort / max output tokens 之类通用项）、“套用推荐预设”。
- 行级扩展写入 `extraParams.dsh`：`src/components/providers/forms/helpers/deepseekHarnessFormUtils.ts` 的 `buildDshPresetExtras`。
- 预设存储复用既有 `AppSettings.modelPresets`（`get_model_presets` / `save_model_presets` 整体读写）。
- 文档：`docs/DSH-MODEL-PRESETS.md`。

### 4. 模型级 reasoning effort

- 七档：`DSH_REASONING_LEVELS` = `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`。
- 模型族推荐表 `dshReasoningPresetFor`（GPT、OpenAI o 系列、Claude、Grok、GLM、MiMo），档位与 `dsh-desktop-ui-reasoning-effort` 插件 `lib/client.js` 的 `presetFor` 对齐；`dshReasoningWireFor` 负责 `off` → `"none"` 等 wire 值映射。
- 交互：`handleToggleReasoningLevel` / `handleApplyReasoningPreset` / `handleClearReasoningEfforts`，模型行内的等级胶囊控件。
- **补充（`4.0.14-dsh.4`）**：上面 §3 的「保存为预设 / 设为通用参数 / 套用推荐预设」三个入口已按需求整体移除（对齐 OpenCode 的纯内联字段），`buildDshPresetExtras` / `pickDshPresetExtras` / `DshPresetExtras` 与 `dshPreset.*` 文案一并删除；全局「设置 → 模型预设」与 Codex / Claude 侧不受影响，`docs/DSH-MODEL-PRESETS.md` 已改写为「现状 + 历史」。§4 的行内胶囊控件换成 Codex 同款下拉面板（触发器 + 七行 `role="checkbox"`），档位名直接用英文原文不再翻译，折叠文案见 `formatDshReasoningLevelsLabel`。`dshRelay.*` 从 30 个键减到 28 个（复用做设置页标题的 `title` / `sectionTitle` 随入口迁移删除）。

### 5. 用量页 Token 计数单位（`4.0.14-dsh.4`）

- 需求：用量统计页给 token 增加「计数单位」选择——国际缩写（`1K` / `1M` / `1.61B`）或中文单位（`1千` / `100万` / `16.1亿`）。
- 设置：`AppSettings.usage_display.token_unit`（Rust `UsageDisplaySettings.token_unit`，`Option<String>` + `skip_serializing_if`，老 `settings.json` 缺字段即 `intl`）；前端 `UsageDisplaySettings.tokenUnit`，`resolveTokenUnit` 把认不出的值兜成 `intl`。
- 界面：用量页「顯示」页签里，币种下方新增 `Select`（`aria-label` = `usage.display.tokenUnit`）+ 一行 hint；切换即时生效并写回设置，保存失败回滚。
- 格式化：`src/components/usage/format.ts` 收敛成一条 `formatTokenValue` —— 单位表 `K/M/B`（1e3/1e6/1e9）与 `千/万/亿`（1e3/1e4/1e8，繁中用 `億/萬`）、最多 3 位有效数字、尾零去掉、`999.95K→1M`、`9999千→1万` 双向进位；`formatTokensCompact(value, locale?, unit)` 与 `formatTokensShort(value, lang, unit)` 共用它。中文按需求实现为 千/万/亿，1000 以下直接写数字（不引入「百」）。
- 统一出口：新增 `src/hooks/useTokenFormat.ts`（读 `useSettingsQuery()`，与 `useMoneyFormat` 同构）；`UsageHero`、`ModelStatsTable`、`ProviderStatsTable`、`RequestLogTable`、`UsageHeatmap`、`UsageTooltipCard`、`UsageTrendChart`（Y 轴刻度）、侧栏「今日」、会话详情头部的 token 汇总全部改走它，避免「Hero 显示 6亿、Y 轴显示 600M」的旧不一致。
- 副作用（有意为之）：缩写门槛从 1 万下调到 1 千（`5000` → `5K` / `5千`），因为需求示例 `1K` 就是千级；精确整数仍在 `title` 里。默认单位是 `intl`，老用户外观只在这类四位数上变化。
- 文案：`usage.display.tokenUnit` / `tokenUnitIntl` / `tokenUnitZh` / `tokenUnitHint` × 4 语言（en/zh/zh-TW/ja）。土耳其语整块 `usage.display` 上游就缺（连币种都没有），维持回退英文，不凭空翻译。

### 6. 连接模式行与列表动作（`4.0.14-dsh.5`）

- 分段控件：新增 `src/components/providers/DshModeBar.tsx`，复用 Codex / Claude 的模式条 `src/components/providers/mode/ModeTabs.tsx`；`ModeTabs` 只加了三个可选 prop（`help` / `toggle` / `scope`）与 `data-mode` 标记，不传时输出与原来逐字节一致。
- 语义分离（沿用 `SwitchModePanel` 的既有约定）：滑块高亮表示“正在看哪个模式”，**实际生效的模式**用状态行文字表达——`attached` 为真时状态行是「路由生效中 → \<provider\>」，否则是直连的「\<供应商\> · \<模型\>」；只有 `view === active` 时才显示状态行，避免在直连页上写“路由生效中”自相矛盾。
- 右侧开关就是 `dsh_set_relay` 的快捷入口（`Waypoints` 图标 + `Switch`，`aria-checked` 直接映射 `relayEnabled`，无法读到状态时 disabled），成功/失败沿用 `dshRelay.relayEnabled` / `relayDisabled` / `relayFailed` 三条 toast；「路由」页签里的开关行仍然保留，因为它带完整解释和退出还原说明。
- 文案：`dshRelay.help.{title,direct,route}` + `dshRelay.modeStatus.routeValue` × 5 语言；`mode.status.*` / `mode.names.*` 复用已有的。
- 列表动作：DSH 是加法式（additive）应用，和 OpenCode 一致——卡片上只有「加入 / 移除」，这轮删掉 `presentation.ts` 里推入的 `setDshDefault` 按钮（含按模型展开的子菜单）、`AdditiveInput.dshModels` 与 `ProviderList` 里那份解析函数，`App.tsx` 的 `handleSetDshDefaultModel` 与其 `onSetAsDefault` 分支一并删除。当前生效的供应商仍是只读标记（`providerCard.status.current` + 模型 chip + `currentCannotRemove` 禁止移除）；供应商表单里的「預設模型」字段（`#dsh-default-model`）和新增弹窗的预设选择器属于配置字段，不是列表动作，保留。

## 验证方式与结果

全部在一台机器上用离线工具链实测（Rust `1.95.0-x86_64-pc-windows-msvc`、`CARGO_NET_OFFLINE=true`；前端 `tsc --noEmit` + `vitest`），并驱动程序真实 GUI 跑端到端脚本。

两个端到端脚本 `ccswitch-dsh-round-smoke.cjs`、`ccswitch-dsh-exit-smoke.cjs` 因为内含本机绝对路径，放在仓库外的工作区根目录，运行产物（`*-result.json`、截图）也在那里。


### 1. 会话日志导入器

- `cargo test session_usage_dsh`：5 passed / 1 ignored（ignored 为需要真实语料的用例）。
- 真实语料（`~/.dsh/sessions` 全量 88 个文件、11,820 条记录、0 错误、12.355 s）：
  - `request_count = 11,820`、`SUM(total_cost_usd) = 192.565240616`
  - `SUM(input_tokens) = 105,630,281`、`SUM(output_tokens) = 16,100,843`、`SUM(cache_read_tokens) = 866,750,547`、`SUM(cache_creation_tokens) = 0`
  - `suspected_duplicates = 0`；抽查三条原始记录与入库行，均满足 `inputTokens + outputTokens + cacheReadTokens = totalTokens`。

### 2. 端到端 GUI 冒烟（`ccswitch-dsh-round-smoke.cjs`，8/8 通过）

在部署版 `D:\Tools\CCSwitch\cc-switch.exe`（`4.0.14-dsh.4`）上通过 CDP 驱动真实界面，`SMOKE PASSED` / exit 0，用时 29.7 s，`locale` 探测为 `zh-TW`：

| 步骤 | 结果 | 实测要点 |
| --- | --- | --- |
| `r2.relay-status` | PASS | 状态命令返回 `relayEnabled=false` / `restoreOnExit=true` / `attached=false`，6 个 provider 全直连 |
| `r2.relay-tab` | PASS | DSH 应用页两个页签 `#dsh-page-providers` / `#dsh-page-dshRelay` 可切换，`uiSwitches=2`，侧栏旧「DSH 中轉」设置组已消失，降级提示未出现（`dsh.5` 起改成 `[data-scope="dsh-mode"] [data-mode="direct"\|"route"]`，见 §6） |
| `r2.restore-toggle` | PASS | `restoreOnExit` 翻转 `true → false` 后读回一致（随后复原） |
| `r2.attach-detach` | PASS | 开→5 个有 `baseURL` 的 provider 改写为 `http://127.0.0.1:15721/dsh/<id>`（`deepseek-official` 无 baseURL，不参与）；关→`cordis.patch.yml` 与开之前**逐字节一致** |
| `r4.reasoning-popover` | PASS | 目标 provider `spacetimeai`（5 个模型行）：弹层 7 档顺序 `off,minimal,low,medium,high,xhigh,max`，收起态为区间折叠 `off, low → max`，勾选后变 `off → max` 并复现；`aria-expanded` 正确；provider 级 `#dsh-reasoning-effort` / `#dsh-max-tokens` 各 1 个 |
| `r3.preset-entries-removed` | PASS | 5 个模型行、15 个标签检查完毕，保存/套用预设的入口确实不存在 |
| `r1.token-usage` | PASS | 同步 `imported=88 / skipped=88 / filesScanned=169 / errors=0`；`dataSource = dsh_session`、`13,370` 请求、`$193.414118`、`realTotalTokens=1,075,496,484`（cacheRead `945,587,155`、命中率 `0.8939`）；应用筛选条出现 Harness 图标，过滤后列表仍显示 DSH 行 |
| `r5.token-unit` | PASS | 「顯示」里出现两个 combobox（幣別 + `Token 單位`，`aria-label="Token 單位"`）；选项 `國際縮寫` / `中文單位`；同一数值 `442,242,014` 实测渲染 中文 **`4.42億`** ↔ 国际 **`442M`**，两者 `title` 恒为精确整数 `442,242,014`；`settings.usageDisplay.tokenUnit` 写入 `zh` / `intl` 并读回一致，跑完删除字段回到默认 |

### 3. 退出还原端到端（`ccswitch-dsh-exit-smoke.cjs`，4/4 通过）

因为“还原后的状态”只在进程不在时存在，分四段跑，每段都在真实进程上做：

| 阶段 | 结果 | 实测要点 |
| --- | --- | --- |
| `attach-exit` | PASS | 开中转（5 个 provider 改写）→ 走 `plugin:process|exit` 真退出（进程 2 s 内消失）→ `cordis.patch.yml` 与备份**逐字节一致**（13,300 B，无 `/dsh/` 残留）、侧车 `attached:false` |
| `verify-restart` | PASS | 重启后无需任何点击：开关为开即自动重新挂载 5 个 provider；再次退出后同样逐字节还原、侧车 `attached:false` |
| `check-after-exit` | PASS | 退出后复核：patch 里 0 条中转地址 |
| `restore-switch` | PASS | 把开关恢复成测试前的值（`relayEnabled=false`、`restoreOnExit=true`），detach 成功，再次退出后 patch 仍与备份逐字节一致 |

### 4. 前端静态检查与单测

- `tsc --noEmit`：0 错误；`prettier --check`：本轮改动的源码与测试无差异（仓库里的 md 文件上游就没过 prettier，未强行格式化）。
- 本轮新增/更新的测试：`tests/hooks/useTokenFormat.test.tsx`（新）、`tests/components/usageFormat.test.ts`、`UsageDisplaySection.test.tsx`、`UsageTrendChart.test.ts`、`SidebarToday.test.tsx`，以及 DSH 侧的 `DeepSeekHarnessFormFields.reasoningEfforts.test.tsx`、`DshRelayPanel.test.tsx`（新）、`DshSurface.test.ts`、`DshUsageAppType.test.ts`、`dshReasoningPresetMirror.test.ts`，全部通过。
- 全量 `vitest run`：`Test Files 240 passed / 4 failed (244)`、`Tests 3,216 passed / 11 failed (3,227)`；11 个失败全部落在既有并行负载敏感组（`tests/integration/App.test.tsx`、`AppsPage.test.tsx`、`PiProviderForm.test.tsx`、`IconPicker.test.tsx`），单独重跑 4 个套件 `133 passed` 全绿，与本轮改动无关。

### 5. 构建与部署

- 离线构建：`pnpm tauri build --no-bundle` 成功（前端 `✓ built in 25.49s`，`Finished release profile in 7m 55s`）。
- 产物：`D:\Tools\CCSwitch\cc-switch.exe`，`4.0.14-dsh.4`，43,122,176 B，SHA256 `A2685390BC5CCB255819B4B9CFD9876BBC0526D8BEEA6E641D02E2FC7A628C8E`；dsh.3 留在 `cc-switch-4.0.14-dsh.3.exe.bak`（SHA256 `9E153CED…A779A1`）。
- 「關於」页与侧栏页脚实测均为 `v4.0.14-dsh.4`。

### 6. 验证后现场状态

- `~/.dsh/profiles/desktop/cordis.patch.yml` 已恢复为测试前内容（0 处 `/dsh/` 地址，SHA256 `3F27C3BA…DBC4`）。
- 侧车 `~/.cc-switch/dsh_relay_state.json` = `{"attached":false,"baseUrl":null,"providers":[]}`。
- `dshRelayEnabled=false`、`dshRestoreOnExit=true`、`usageDisplay.tokenUnit` 已删除（回到默认 `intl`）；CCS 以新版本在运行。
- 截图（`D:\DevelopmentFolder\默认工作区\ccs\ccswitch-dsh-round-shots\`）：`01`–`04` 中转页与接管/还原、`05` 推理等级弹层、`06`–`07` 用量看板与 DSH 过滤、`08` Token 单位下拉、`09` 關於页版本。

## 本轮（4.0.14-dsh.5）验证与结果

本轮只交付 §6（页头连接模式行 + 列表动作收口），下面全部在部署版 `4.0.14-dsh.5` 上实测。

### 1. 前端静态检查与单测

- `tsc --noEmit`：0 错误（退出码 0，无输出）。
- `prettier --check`：本轮改动/新增的 7 个 `src`、`tests` 文件（4 个已跟踪 + `DshModeBar.tsx`、`DshModeBar.test.tsx`、重写的 `DshProviderPresentation.test.ts`）与 5 份 locale JSON 全部无差异；仓库里的 md 上游就没过 prettier，未强行格式化。
- 新增 `tests/components/DshModeBar.test.tsx`（9 个用例）：`[data-scope="dsh-mode"]` 的分段结构与两个 `[data-mode]` 胶囊的 `aria-pressed`、点击段位切换视图、生效模式判定（`attached=true` 时路由段亮起，与当前看哪一页无关）、状态行只在看生效模式时出现、直连行文案（显示名 / 缺当前 provider 时回退 id 并省略值 / 多家时用数量标签）、快捷开关映射 `relayEnabled` 与状态读不到时的禁用态、成功与失败两条 toast（失败时保留上一个开关值）。
- 重写 `tests/components/DshProviderPresentation.test.ts`：DSH 卡片动作只剩 `["remove"]`，当前生效的那家仍被 `currentCannotRemove` 挡住不能移除；断言不再出现 `setDshDefault`（另加 `startsWith` 前缀扫描兜底），`setDefault` 一次都没被调用。
- `vitest run`（本轮相关 8 个文件：`DshModeBar` / `DshRelayPanel` / `SwitchModePanel` / `DshSurface` / `DshProviderPresentation` / `providerPresentation` / `ProviderList` / `DeepSeekHarnessFormFields`）：**8 个测试文件、106 个用例全绿**。
- `dshRelay.help.{title,direct,route}` 这三条文案没有单测断言（`ModeTabs` 只把 `help` 透传下去），实际内容由 §5 的截图 `03` 和脚本抓到的 DOM 文案覆盖。

### 2. 端到端 GUI 冒烟（`ccswitch-dsh-round-smoke.cjs`，8/8 通过）

在部署版 `D:\Tools\CCSwitch\cc-switch.exe`（`4.0.14-dsh.5`）上通过 CDP 驱动真实界面，`SMOKE PASSED` / exit 0，`03:37:57 → 03:38:25`（28.8 s），`locale` 探测为 `zh-TW`：

| 步骤 | 结果 | 实测要点 |
| --- | --- | --- |
| `r2.relay-status` | PASS | 状态命令返回 `relayEnabled=false` / `restoreOnExit=true` / `attached=false`，6 个 provider 全直连（其中 5 个有 `baseURL`，可被改写） |
| `r2.relay-tab` | PASS | 页头换成 Claude Code 同款分段控件：`[data-scope="dsh-mode"]` 下两个 `[data-mode="direct"\|"route"]` 胶囊 + 右侧「使用 CC Switch 中轉 DSH 請求」`[role="switch"]`；旧的 `#dsh-page-providers` / `#dsh-page-dshRelay` 下划线页签已不存在，侧栏「DSH 中轉」设置组也已消失 |
| `r2.restore-toggle` | PASS | `restoreOnExit` 翻转 `true → false` 后读回一致（随后复原） |
| `r2.attach-detach` | PASS | 开→5 个有 `baseURL` 的 provider 改写为 `http://127.0.0.1:15721/dsh/<id>`（`deepseek-official` 无 baseURL，不参与）；关→`cordis.patch.yml` 与开之前**逐字节一致** |
| `r4.reasoning-popover` | PASS | 目标 provider `spacetimeai`（5 个模型行）：弹层 7 档顺序 `off,minimal,low,medium,high,xhigh,max`，收起态为区间折叠，勾选后写回并可读回 |
| `r3.preset-entries-removed` | PASS | 5 个模型行、15 个标签检查完毕，保存/套用预设的入口确实不存在；DSH 列表里 `providerCard.action.setDefault`（「設為預設」）实测 0 个按钮 |
| `r1.token-usage` | PASS | 同步 `imported=2 / skipped=91 / filesScanned=169 / errors=0`；`dataSource = dsh_session`、`13,705` 请求、`$194.029165`、`realTotalTokens=1,097,190,179`（cacheRead 命中率 `0.8944`）；应用筛选条出现 Harness 图标，过滤后列表仍显示 DSH 行 |
| `r5.token-unit` | PASS | 「顯示」里的 `Token 單位` 下拉在 `國際縮寫` / `中文單位` 间切换；同一数值实测 中文 **`4.64億`** ↔ 国际 **`464M`**，两者 `title` 恒为精确整数 `463,935,709`；跑完把单位改回原值 |

结论：`SMOKE PASSED`、`SMOKE_EXIT=0`，结果 JSON `ok: true`、`errors: []`。唯一一条 `WARN` 是 `dshRelay.sectionTitle` 已随旧页签下线，脚本里的侧栏检查退化成空操作，不影响任何断言。

### 3. 退出还原端到端（`ccswitch-dsh-exit-smoke.cjs`，4/4 通过）

因为「还原后的状态」只在进程不在时存在，分四段跑，每段都在真实进程上做（`03:41:01 → 03:42:39`）：

| 阶段 | 结果 | 实测要点 |
| --- | --- | --- |
| `attach-exit` | PASS | 开中转（5 个 provider 改写）→ 走 `plugin:process\|exit` 真退出（进程 2 s 内消失）→ `cordis.patch.yml` 与备份**逐字节一致**（13,299 B，0 条 `/dsh/` 残留）、侧车 `attached:false` |
| `verify-restart` | PASS | 重启后无需任何点击即自动重新挂载 5 个 provider；再次退出后同样逐字节还原、侧车 `attached:false` |
| `check-after-exit` | PASS | 退出后复核：patch 里 0 条中转地址，且与备份逐字节一致 |
| `restore-switch` | PASS | 把开关恢复成测试前的值（`relayEnabled=false`、`restoreOnExit=true`），detach 成功，再次退出后 patch 仍与备份一致 |

### 4. 构建与部署

- 离线构建 `pnpm tauri build --no-bundle` 成功（前端 `✓ built in 12.23s`，`Finished release profile in 4m 41s`）。
- 产物 `D:\Tools\CCSwitch\cc-switch.exe`：`4.0.14-dsh.5`，43,122,688 B，SHA256 `6BAFFE867286314C82C72ED7BE7828D5D7B73E2B64C00BDE504A2796FD1AE83F`；dsh.4 留在 `cc-switch-4.0.14-dsh.4.exe.bak`（43,122,176 B）。
- 「關於」页与侧栏页脚实测均为 `v4.0.14-dsh.5`。

### 5. 截图

新增 `D:\DevelopmentFolder\默认工作区\ccs\ccswitch-dsh5-shots\`（`ccswitch-dsh5-shots.cjs` 驱动，结果 `ok: true`，7 张；`05-card-actions.png` 为补拍）：

- `01-direct-mode.png`：直連态，状态行「直連生效中 · 直接連線 WorkBuddy · deepseek-v4.1-flash」，右侧开关 `aria-checked=false`。
- `02-route-mode.png`：切到「路由」，胶囊随视图移动。
- `03-help-tip.png`：`?` 弹出「直連與路由的差別」两行说明（`dshRelay.help.title` / `direct` / `route`）。
- `04-route-panel.png`：路由页的中轉面板与 Provider 位址表。
- `05-direct-list.png`：与 `01` 同帧（保留整页对照）。`05-card-actions.png`：卡片动作区特写（第一张卡片 `DeepSeek`，808×62 CSS），动作只有 − / 铅笔 / ⋯——没有「設為預設」，与 §2 `r3` 的 DOM 断言一致。
- `06-about-version.png`：「關於」页 `版本 v4.0.14-dsh.5`。

### 6. 验证后现场状态

- `~/.dsh/profiles/desktop/cordis.patch.yml` 与测试前备份**逐字节一致**：13,299 B，SHA256 `2057362B…2AA44DE0`，0 条 `/dsh/` 地址。
- 侧车 `~/.cc-switch/dsh_relay_state.json` = `{"attached":false,"baseUrl":null,"providers":[]}`。
- `dshRelayEnabled=false`、`dshRestoreOnExit=true`；CCS 以 `4.0.14-dsh.5` 在运行，没有留下中转进程。

## 本轮（4.0.14-dsh.7）验证与结果

本轮两件事：先把 DSH 应用页的连接模式改成 Claude Code 模式行同款（`dsh.6`），然后修掉用户实测到的
「切回直连 / 退出 CCS 之后 API 地址还是中转端口」的回归（`dsh.7`）。除特别标注外，下面都在部署版
`4.0.14-dsh.7` 上实测。

### 1. 现象与真实根因

用户原话：**「我无论切回直连还是选择退出，dsh 的 api 配置依旧是走的 ccs 路由（中转），现在是我手动
修改了 dsh 配置才能够和你对话的」**。也就是说开关点了、界面也说成功了，`cordis.patch.yml` 里的
`baseURL` 却还是一串 `http://127.0.0.1:15721/dsh/<id>`。

日志（`~/.cc-switch/logs/cc-switch.log`）把过程钉死在三处：

| 时刻 | 日志 | 当时真实发生的事 |
| --- | --- | --- |
| 13:27:20 | `原子替换失败 … 无法删除要替换的文件 (os error 1175)`，紧接着 `4 家 地址已不是中转地址，跳过恢复` | 写入被文件占用打断；随后的比对把「没写成」当成「已经是直连」 |
| 13:28:56 | `已恢复 1 个 DSH 供应商的原始地址`，账本被清空 | 报告成功，实际那一家仍指在中转端口上 |
| 13:37:01 | 重启后 `供应商 x 没有可用的原始地址，跳过接管` → `已接管 1 个` | 账本已空，重新接管只认得出 1 家，其余原始地址再也查不回来 |
| 13:38:15 | 退出清理：`「退出后自动切回原始地址」是关着的，按用户设置跳过` | 三元组叠加后 DSH 停在 `127.0.0.1:15721`，端口随进程一起消失，DSH 直接连不上 |

根因不是「忘了还原」，而是三条链式缺陷叠加，任何一条单独存在都不至于把地址永久丢在死端口上：

1. **原子替换被 Windows 文件占用打断。** CCS 用 `ReplaceFileW` 替换 `cordis.patch.yml`，而 DSH 的
   chokidar 监听（`awaitWriteFinish` 轮询）以及杀软/索引器会在这个窗口里短暂持有句柄，替换返回
   `ERROR_UNABLE_TO_REMOVE_REPLACED (1175)`。`src-tauri/src/config.rs` 的重试循环 `for _ in 0..3`
   只在 `NotFound` 时继续，**1175 直接 break 出去**并向上报错——一次瞬时占用就等于这次恢复彻底失败。
2. **还原判定比字符串，不看事实。** 旧逻辑把「文件里的地址 ≠ 账本里记的那个中转地址」当成「已经是
   直连」，于是端口变了、用户手改过、或者写入失败留下的残留，都会被误判成已还原，进而打印 `已恢复`
   并**清空账本**。
3. **账本清空之后没有回头路。** 原始地址只记在账本里；清空后 `attach` 认不出中转地址的来历，`detach`
   也没东西可换回，用户只能手改 YAML。

### 2. 修法

都落在 `src-tauri/src/deepseek_harness_patch.rs` 与 `src-tauri/src/services/dsh_relay.rs`：

| 层 | 改动 |
| --- | --- |
| 写入 | `ReplaceFileW` 失败按 20/40/…/160 ms 退避**重试 8 次**；仍失败就**原地重写**（`OpenOptions` + `truncate` + `write_all` + `sync_all`），彻底绕开「删不掉要替换的文件」这条路径；每次写前留 `.ccswitch.bak` 备份 |
| 读取 | 读配置同样退避重试 6 次（40…240 ms）：一次读失败不再让「切回直连」直接报错，把「文件正被占用」和「真的读不了」分开 |
| 判定 | 恢复只认事实：**任何 loopback 主机 + `/dsh/` 前缀的地址**都要换回，与账本里的端口、字符串无关 |
| 原始地址来源 | 账本 → CCS 数据库 → `.ccswitch.bak` → `~/.dsh/recovery/`，四级兜底，账本丢了也能救回来 |
| 校验 | 写完**回读文件**核对，最多 3 轮；只有文件里真的不是中转地址才算还原 |
| 账本 | 成功后不再清空：条目降级成「原始地址台账」（`attached=false`、`relayed=false`），下次还能照着恢复；没换回来的留在账本里并保持 `attached=true` |
| 退出 / 启动 | 退出钩子与启动自检都以**文件事实**判断（`is_attached()` = 账本 `attached` **或** 文件里还有中转地址），不再只看账本；启动时 `heal_on_startup` 顺手修掉历史遗留的死端口地址 |
| 界面 | 切回直连后仍有残留时给出明确警告（`dshRelay.restoreIncomplete`，带剩余家数），不再假装成功；每次开关中转都让 provider 缓存失效，卡片不会还挂着旧地址 |

「写入可靠性」优先于「缩短占用窗口」：DSH 约 100 ms 就会热加载这份配置、provider 的 `baseURL` 是
volatile 的，只要写进去了就立刻生效，所以真正要解决的是**写不进去时别把自己骗过去**。

### 3. 界面收口（dsh.6）

DSH 应用页不再单独做一套设置页：页头直接是 Claude Code 同款的分段行，`直連 | 路由`两段，右侧
`?` 弹出「直連與路由的差別」，`路由`段在生效时显示 `聚合` 徽标与「路由生效中 → <provider>」，
再右边是路由设置齿轮；provider 列表里被接管的卡片带「路由中」徽标（优先于「目前」）。切换动作用
列表上方的 `DshRelayNotice` CTA，路由设置（退出还原、地址映射）收进齿轮弹出的 `DshRelaySheet`。
旧的侧栏「DSH 中轉」设置组、页签、以及 DSH 列表里的「設為預設」入口都已删除。

### 4. 实测：用户遇到的两种操作

部署 `4.0.14-dsh.7` 后按用户的操作顺序走了一遍（CCS 启动时 `dshRelayEnabled=true`，5 个 provider 被自动接管）：

| 操作 | 结果 |
| --- | --- |
| 应用页切回「直連」 | `dsh_set_relay{enabled:false}` **105 ms** 返回；状态 `attached=false / relayEnabled=false / restoreOnExit=true`，5 家全部 `relayed=false`，原始地址逐个露出来（`https://yapi.click/v1`、`https://yapi.click`、`https://spacetimeai.cc/v1`、`http://192.168.31.53:8788`、`https://yapi.click`） |
| 退出 CCS | `attach-exit`、`verify-restart`、`check-after-exit` 三个阶段全过：`cordis.patch.yml` 与开启前备份**逐字节一致**，0 处 `/dsh/`，侧车 `attached=false` 且保留 5 条原始地址台账 |

收尾核对：

- `cordis.patch.yml` 13,300 B、0 条 `/dsh/` 地址，SHA256 `3F27C3BA9EF52F7FFEFE92956460D37641D7C9B6C8B94FB03727E86BDDF8ABC4`。
- 日志：`已恢复 5 个 DSH 供应商的原始地址`，没有 `kept failing` / `in-place` 之类的降级警告。
- 这一轮对话本身就是走直连的（patch 里 0 条中转地址），等于顺带验证了还原对 DSH 自己的流量立刻生效。
- 退出脚本的第四阶段 `restore-switch` 没有跑：它的作用是把设置恢复成测试前的值，而本次测试前的值
  （`relayEnabled=false`、`restoreOnExit=true`）已经手工恢复并核对过，不必再让它开关一次中转。

### 5. 争用对照：同一把独占锁，dsh.6 与 dsh.7

为了证明「不是运气好」，写了个脚本（`ccswitch-dsh-contention-smoke.cjs`）：接管 5 家之后，用
`FileShare.None` 独占打开 `cordis.patch.yml` 并保持 500 ms，模拟 DSH 监听 / 杀软 / 索引器抢句柄的那一瞬，
在这 500 ms 内调用「切回直連」：

| 版本 | 结果 | 文件里剩下 |
| --- | --- | --- |
| `dsh.6`（旧） | 9 ms 就失败：`读取 DeepSeek Harness 配置失败: … os error 32` | **5 条** `/dsh/` 地址（13,394 B），侧车仍 `attached=true`——正是用户看到的「切了还在走中转」 |
| `dsh.7` | 653 ms 后成功（8 次退避重试把 500 ms 的锁等了过去） | **0 条**，与开启前备份逐字节一致 |

dsh.6 这部分也解释得通：它只在「被打断的那一次」丢地址——不设争用、正常退出时它其实能还原（本次实测
退出后同样是 13,300 B、逐字节一致）。用户踩到的就是被 DSH 监听窗口打断的那一次。

### 6. GUI 冒烟、单测与构建

- 端到端 GUI 冒烟（`ccswitch-dsh-round-smoke.cjs`，8/8 通过，18:03:52–18:04:20）：`mode-row` 3871 ms、
  `route-view` 1949 ms、`attach-sheet` 3505 ms、`detach` 3621 ms、`reasoning-popover` 4429 ms（目标
  `spacetimeai`、5 个模型）、`preset-entries-removed` 2243 ms、`token-usage` 3944 ms、`token-unit` 4391 ms；
  开头读到 `app version 4.0.14-dsh.7`、`DSH patch layer C:\Users\MadeSpark\.dsh\profiles\desktop\cordis.patch.yml`、
  locale `zh-TW`，结尾 `SMOKE PASSED`。
- 前端：`tsc --noEmit` 0、`prettier --check` 0；vitest 相关 4 个文件全绿——`DshRelayNotice` 4、
  `DshRelaySheet` 9、`DshModeBar` 11、`ProviderList` 29。
- Rust：`deepseek_harness` 47 通过、`dsh_relay` 20 通过、`dsh_is_part_of_environment_checks` 1 通过；
  `cargo fmt --check` 与 `cargo check` 均 0。
- 构建：离线 `pnpm tauri build`，`release` profile 3 分 45 秒完成；产物 `cc-switch.exe` 43,145,216 B，
  SHA256 `C17C8C4D053EBECA995EB4DEED992BD74B93D2A926C3DE92AF5739036636C154`。部署前的旧版备份为
  `cc-switch-4.0.14-dsh.6.exe.bak`（43,122,688 B，SHA256 `490941179614FB451F3601FDCCAC6128250143CCC8E2193BB4BFF9039388AB03`）。

### 7. 截图

`ccswitch-dsh7-shots.cjs` 抓了 6 张（落在 `ccswitch-dsh7-shots/`）：

| 文件 | 内容 |
| --- | --- |
| `01-direct-mode.png` | 分段行 `直連 \| 路由`、`?`、状态行「直連生效中 · 直接連線 WorkBuddy · deepseek-v4.1-flash」、6 家列表，卡片上只有 −/✎/⋯ 三个动作（没有「設為預設」） |
| `02-route-mode.png` | 路由视图（未接管时提示条 + 「開始路由」） |
| `03-help-tip.png` | `?` 弹的「直連與路由的差別」說明卡 |
| `04-route-panel.png` | 齿轮打开的「路由設定」sheet（退出还原开关 + 地址映射 + 刷新） |
| `05-direct-list.png` | 直連视图的完整 provider 列表 |
| `06-about-version.png` | 關於页，版本 `v4.0.14-dsh.7` |

### 8. 验证后现场状态

- 交付提交：`760c635`（`personal-6reqs`），已推送到 `dsh/main`（[MadeSpark/CC-Switch-DSH](https://github.com/MadeSpark/CC-Switch-DSH)）。
- `cordis.patch.yml`：13,300 B、0 条 `/dsh/` 地址，SHA256 `3F27C3BA9EF52F7FFEFE92956460D37641D7C9B6C8B94FB03727E86BDDF8ABC4`。
- 侧车 `dsh_relay_state.json`：`attached=false`，5 条原始地址台账（`relayBaseUrl=null`、`relayed=false`）。
- `settings.json`：`dshRelayEnabled=false`（以后启动不再自动接管）、`dshRestoreOnExit=true`。
- `D:\Tools\CCSwitch\cc-switch.exe` = `4.0.14-dsh.7`（SHA256 `C17C…C154`）；`cc-switch-4.0.14-dsh.6.exe.bak`
  留着可回滚。CCS 以 dsh.7 在运行，没有残留的中转状态。

## 已知限制

- token 统计依赖会话日志文件可读且格式不变：DSH 升级若改动 record type、usage 字段名、zstd 组织或目录结构，需要同步维护解析器；无 usage 记录的失败重试不会进统计。
- 价格表未匹配的模型会写入 token 但费用为 0；模型别名与实际计费模型的映射仍需按实际账单校准。
- 中转 UI 的已知边界：开中转会自动拉起本地代理；若把“退出还原”关掉再退出，DSH 会指向一个已关闭的端口，直到下次启动 CCS 由启动自检修回来；`api: google-generativeai` 的 provider 不做鉴权注入；开启开关但没有任何可改写的 provider 时，自愈会把 `dshRelayEnabled` 写回 false。
- 改写 `cordis.patch.yml` 要跟 DSH 的监听、杀软、索引器抢文件句柄（Windows 上表现为 `os error 1175`）。dsh.7 用「退避重试 8 次 + 原地重写 + 回读 3 轮」把常见占用（实测 500 ms 的独占锁）挡在成功路径上；如果某个进程把文件锁超过约 1.5 s，这次切换仍可能失败——此时界面会明说还有几家没换回来（不再谎报成功），账本继续保留原始地址，下次启动或退出再重试。
- 端口占用、多开 CCS、用户在 DSH 里手工改 provider 等场景仍需结合实际环境排查。
- DSH 表单没有 temperature 专用控件，预设里的 temperature 会被跳过（见 `docs/DSH-MODEL-PRESETS.md`）。
- 只产出 exe，没有打 NSIS 安装包；Apps 页仍没有 DSH 这一行；DSH 的 MCP 上游本就不支持。
- token 计数单位：中文单位只实现 千 / 万 / 亿，1,000 以下直接写阿拉伯数字（需求里的「百」没有单独档位，`123` 仍是 `123`）；两套单位的缩写门槛都是 1,000，所以 `5,000` 现在显示 `5K` / `5千`（旧版 1 万以下写全数，`5,000`）——这是按需求示例 `1K` 做的取舍。趋势图 Y 轴与 tooltip 里的「请求数」和 token 共用同一个格式化函数，因此请求数也会变成 `1.2万` 这类写法。
- 土耳其语（`tr`）缺整个 `usage.display` 文案块（连币种、汇率、侧栏今日都没有），上游即如此，本轮未补，回退英文。

## 升级/回滚步骤

### 升级

1. 备份 CC Switch 数据库（`~/.cc-switch/cc-switch.db`）、设置文件和 DSH provider 配置（`~/.dsh/profiles/desktop/cordis.patch.yml`）。
2. 确认工作区仍基于上游 `main@73f37c4`（v4.0.14）与 PR #7356，保留个人来源声明（`PERSONAL-NOTICE.md` / `README.md`）。
3. 覆盖 `D:\Tools\CCSwitch\cc-switch.exe`，启动后进入 DeepSeek Harness 应用页的「路由」模式（`4.0.14-dsh.6` 起是页头的分段控件 `直連 \| 路由`；`dsh.4` 是下划线页签；更早在设置页），确认开关状态与 provider 映射。
4. 用量页“資料 → 数据来源”确认自动同步开启，执行一次历史日志同步并核对 `DeepSeek Harness (Session)`。
5. 需要中转时再打开开关：先确认直连地址已记录，再验证“退出 CCS 即还原”。
6. 逐个验证模型行内的推理等级；需要中文数位时，到用量页「顯示」把 Token 单位切到「中文单位」，再回来看指标卡与列表是否跟随。
7. 然后开始正常使用。

### 回滚

1. 关闭 DSH 中转开关（此时会把地址还原成直连）；确认所有 DSH provider 的 `baseURL` 已是原始地址。
2. 关闭用量页的自动同步；已导入的历史统计行是否删除按备份决定，不要直接删表。
3. 恢复备份的数据库、设置与 `cordis.patch.yml`。
4. 换回旧版 exe（`cc-switch-4.0.14-dsh.2.exe.bak` 等），重新打开 DSH 检查 provider、模型和 API 地址。
5. 预设存在共享的 `AppSettings.modelPresets` 中；完全回滚需一并恢复该设置备份。
