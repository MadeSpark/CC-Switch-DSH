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
- 设置：`dshRelayEnabled`（默认 false）/ `dshRestoreOnExit`（默认 true），前端 `src/lib/api/dsh.ts`、`src/lib/query/dsh.ts`、`src/components/settings/sections/DshSection.tsx`，侧栏“設定 → DSH 中轉”。
- 文案：`dshRelay.*` 30 个键 × 5 语言（中/繁/英/日/土）。
- 文档：`docs/DSH-RELAY.md`。

### 3. 一键模型预设与默认参数

- 表单：`src/components/providers/forms/DeepSeekHarnessFormFields.tsx` 的“保存为预设”（整个模型目录一次成预设）、“设为通用参数”（reasoning effort / max output tokens 之类通用项）、“套用推荐预设”。
- 行级扩展写入 `extraParams.dsh`：`src/components/providers/forms/helpers/deepseekHarnessFormUtils.ts` 的 `buildDshPresetExtras`。
- 预设存储复用既有 `AppSettings.modelPresets`（`get_model_presets` / `save_model_presets` 整体读写）。
- 文档：`docs/DSH-MODEL-PRESETS.md`。

### 4. 模型级 reasoning effort

- 七档：`DSH_REASONING_LEVELS` = `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`。
- 模型族推荐表 `dshReasoningPresetFor`（GPT、OpenAI o 系列、Claude、Grok、GLM、MiMo），档位与 `dsh-desktop-ui-reasoning-effort` 插件 `lib/client.js` 的 `presetFor` 对齐；`dshReasoningWireFor` 负责 `off` → `"none"` 等 wire 值映射。
- 交互：`handleToggleReasoningLevel` / `handleApplyReasoningPreset` / `handleClearReasoningEfforts`，模型行内的等级胶囊控件。

## 验证方式与结果

全部在一台机器上用离线工具链实测（Rust `1.95.0-x86_64-pc-windows-msvc`、`CARGO_NET_OFFLINE=true`；前端 `tsc --noEmit` + `vitest`），并驱动程序真实 GUI 跑端到端脚本。

两个端到端脚本 `ccswitch-dsh-round-smoke.cjs`、`ccswitch-dsh-exit-smoke.cjs` 因为内含本机绝对路径，放在仓库外的工作区根目录，运行产物（`*-result.json`、截图）也在那里。


### 1. 会话日志导入器

- `cargo test session_usage_dsh`：5 passed / 1 ignored（ignored 为需要真实语料的用例）。
- 真实语料（`~/.dsh/sessions` 全量 88 个文件、11,820 条记录、0 错误、12.355 s）：
  - `request_count = 11,820`、`SUM(total_cost_usd) = 192.565240616`
  - `SUM(input_tokens) = 105,630,281`、`SUM(output_tokens) = 16,100,843`、`SUM(cache_read_tokens) = 866,750,547`、`SUM(cache_creation_tokens) = 0`
  - `suspected_duplicates = 0`；抽查三条原始记录与入库行，均满足 `inputTokens + outputTokens + cacheReadTokens = totalTokens`。

### 2. 端到端 GUI 冒烟（`ccswitch-dsh-round-smoke.cjs`，7/7 通过）

在部署版 `D:\Tools\CCSwitch\cc-switch.exe`（`4.0.14-dsh.3`）上通过 CDP 驱动真实界面，`SMOKE_EXIT=0`：

| 步骤 | 结果 | 实测要点 |
| --- | --- | --- |
| `r2.relay-status` | PASS | 状态命令返回 `relayEnabled=false` / `restoreOnExit=true` / `attached=false`，provider 列表结构完整 |
| `r2.settings-section` | PASS | 侧栏“DSH 中轉”可进入，locale 探测为 `zh-TW`，降级提示未出现 |
| `r2.restore-toggle` | PASS | 两个开关可切换并持久化（`restoreOnExit` 翻转后读回一致，最终复原） |
| `r2.attach-detach` | PASS | 开→6 个 provider 全部改写为 `http://127.0.0.1:15721/dsh/<id>`；关→`cordis.patch.yml` 与开之前**逐字节一致** |
| `r4.reasoning-levels` | PASS | 每行 7 个等级胶囊（共 50 个），点击后 `aria-pressed` 由 `false` → `true` |
| `r3.save-as-preset` | PASS | 预设数 `0 → 7`（WorkBuddy 线路 7 个模型一键入库），随后复原 |
| `r1.token-usage` | PASS | 应用筛选条出现 DeepSeek Harness 图标；同步 `imported=3 / skipped=87`，`dataSource = dsh_session / 11,996 请求 / $192.769171`，汇总含 `cacheReadTokens`、`cacheHitRate=0.8918`，切到 DSH 过滤后列表仍显示 DSH 行 |

### 3. 退出还原端到端（`ccswitch-dsh-exit-smoke.cjs`，3/3 通过）

因为“还原后的状态”只在进程不在时存在，分三段跑，每段都在真实进程上做：

| 阶段 | 结果 | 实测要点 |
| --- | --- | --- |
| `attach-exit` | PASS | 开中转（6 个 provider 改写）→ 走与托盘退出相同的 `plugin:process|exit` → 进程退出 → `cordis.patch.yml` 与备份**逐字节一致**（13,930 B，无 `/dsh/` 残留）、侧车 `attached:false` |
| `verify-restart` | PASS | 重启后无需任何点击：开关为开即自动重新挂载 6 个 provider；再次退出后同样逐字节还原、侧车 `attached:false` |
| `restore-switch` | PASS | 把开关与 `restoreOnExit` 恢复成测试前的值（`relayEnabled=false`、`restoreOnExit=true`），退出后 patch 仍与备份逐字节一致 |

### 4. 前端静态检查与单测

- `tsc --noEmit`：0 错误；`prettier --check`：无差异。
- 本轮新增/更新的测试：`tests/components/AppGlyph.decorativeSvgTitle.test.tsx`、`DeepSeekHarnessFormFields.reasoningEfforts.test.tsx`、`DshSection.test.tsx`、`DshUsageAppType.test.ts`、`dshReasoningPresetMirror.test.ts`，全部通过。
- 全量 `vitest run`：`Test Files 241 passed / 4 failed (245)`、`Tests 3,221 passed / 7 failed (3,228)`；7 个失败全部落在既有并行负载敏感组（`AppsPage.test.tsx`、`IconPicker.test.tsx`、`PiProviderForm.test.tsx`、`tests/integration/App.test.tsx`），单独运行均通过，与本轮改动无关。

### 5. 构建与部署

- 离线构建：`pnpm tauri build --no-bundle` 成功（前端 `✓ built in 12.06s`，`Finished release profile in 4m 45s`）。
- 产物：`D:\Tools\CCSwitch\cc-switch.exe`，`4.0.14-dsh.3`，43,118,592 B，SHA256 `9E153CEDF3109BD56F5426FF3C14C7C33489826AC802B3C6EAD77B5484A779A1`；旧版留在 `cc-switch-4.0.14-dsh.{1,2}.exe.bak`。

### 6. 验证后现场状态

- `~/.dsh/profiles/desktop/cordis.patch.yml` 已恢复为测试前内容（0 处 `/dsh/` 地址）。
- 侧车 `~/.cc-switch/dsh_relay_state.json` = `{"attached":false,"baseUrl":null,"providers":[]}`。
- `dshRelayEnabled=false`、`dshRestoreOnExit=true`、模型预设清回测试前状态；CCS 进程已退出。

## 已知限制

- token 统计依赖会话日志文件可读且格式不变：DSH 升级若改动 record type、usage 字段名、zstd 组织或目录结构，需要同步维护解析器；无 usage 记录的失败重试不会进统计。
- 价格表未匹配的模型会写入 token 但费用为 0；模型别名与实际计费模型的映射仍需按实际账单校准。
- 中转 UI 的已知边界：开中转会自动拉起本地代理；若把“退出还原”关掉再退出，DSH 会指向一个已关闭的端口，直到下次启动 CCS；`api: google-generativeai` 的 provider 不做鉴权注入；开启开关但没有任何可改写的 provider 时，自愈会把 `dshRelayEnabled` 写回 false。
- 端口占用、多开 CCS、用户在 DSH 里手工改 provider 等场景仍需结合实际环境排查。
- DSH 表单没有 temperature 专用控件，预设里的 temperature 会被跳过（见 `docs/DSH-MODEL-PRESETS.md`）。
- 只产出 exe，没有打 NSIS 安装包；Apps 页仍没有 DSH 这一行；DSH 的 MCP 上游本就不支持。

## 升级/回滚步骤

### 升级

1. 备份 CC Switch 数据库（`~/.cc-switch/cc-switch.db`）、设置文件和 DSH provider 配置（`~/.dsh/profiles/desktop/cordis.patch.yml`）。
2. 确认工作区仍基于上游 `main@73f37c4`（v4.0.14）与 PR #7356，保留个人来源声明（`PERSONAL-NOTICE.md` / `README.md`）。
3. 覆盖 `D:\Tools\CCSwitch\cc-switch.exe`，启动后在“設定 → DSH 中轉”确认开关状态与 provider 映射。
4. 用量页“資料 → 数据来源”确认自动同步开启，执行一次历史日志同步并核对 `DeepSeek Harness (Session)`。
5. 需要中转时再打开开关：先确认直连地址已记录，再验证“退出 CCS 即还原”。
6. 逐个验证模型预设与推理等级，然后开始正常使用。

### 回滚

1. 关闭 DSH 中转开关（此时会把地址还原成直连）；确认所有 DSH provider 的 `baseURL` 已是原始地址。
2. 关闭用量页的自动同步；已导入的历史统计行是否删除按备份决定，不要直接删表。
3. 恢复备份的数据库、设置与 `cordis.patch.yml`。
4. 换回旧版 exe（`cc-switch-4.0.14-dsh.2.exe.bak` 等），重新打开 DSH 检查 provider、模型和 API 地址。
5. 预设存在共享的 `AppSettings.modelPresets` 中；完全回滚需一并恢复该设置备份。
