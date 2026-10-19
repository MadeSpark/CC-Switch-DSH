# DSH round 3 交付报告（`4.0.14-dsh.8`）

本轮只修状态显示，不动中转协议、不动 DSH 配置格式：三处 bug 都来自「界面把 DSH 的状态记错了地方」，
修法是把状态来源收回到各自唯一的事实源（中转状态 / relay 侧车 / 用量表里的真实 provider id）。

## 本轮问题（用户原话）

1. 「当我给dsh切到路由时，打开别的agent标签页然后再切回来，结果默认显示“直連”而不是当前选择的模式，上面还写着“你在查看「直連」，DeepSeek Harness 目前是路由。”」
2. 「正常情况切到路由后，对应agent后面应该出现“路由”的标签」
3. 「另外，我明明已经切到路由了，为什么还显示“工作階段日誌”」（`deepseek-v4.1-flash` 行，供應商列显示「工作階段日誌」、速度/首字 `—`、成本「未定價」）

## 根因

### 1. 视图状态被塞进了全局页签状态

`直連 / 路由` 本来是 DSH 应用页内部的视图，但实现把它编码成了全局 `currentView = "dshRelay"`。而
`selectApp` 选任何应用都会把 `currentView` 置成 `"providers"`，应用页归属校验也会把不属于当前应用的
页签重置。于是「切去 Claude Code 再切回 DSH」一定回到 `providers`（直連视图），可是 relay 侧车里的
`attached` 仍是 `true`，`DshRelayNotice` 就按「你在查看直連，但实际是路由」弹提示 —— 两个状态各自都
“对”，只是视图状态记错了地方。

**修法**：新增 `src/hooks/useDshModeView.ts`，视图由 `useDshRelayStatus()` 的 `attached` 推导；用户点
pill 只写一个**会话内覆盖值**，`attached` 一变就丢弃覆盖值。全局 `currentView` 不再保存 DSH 视图，旧版本
存下的 `"dshRelay"` 在初始化时迁移成 `"providers"`。

### 2. 侧栏标签只认代理栈里的应用

`useSidebarStatus().appStatus()` 只对 `MODE_APP_IDS`（Claude Code / Codex / …）读代理栈的 route/stack
状态，其他应用一律返回 `direct`。DSH 不在这套代理栈里（见 `docs/DSH-RELAY.md`「为什么不做成
PROXY_APPS 成员」），它的接管状态在 relay 侧车，所以侧栏永远拿不到 `route`，DSH 行也就永远没有标签。

**修法**：`useSidebarStatus` 单独订阅 `useDshRelayStatus()`，`attached === true` 时给 DSH 返回
`mode: "route"`；标签沿用 Claude Code 同一个 `modeTag` 渲染。选中行不显示标签是既有设计（Claude Code
也一样），所以「切到别的应用」时才看得到 DSH 行的 `路由`。

### 3. 会话导入把所有行都记在占位供应商上

导入器固定写 `provider_id = "_dsh_session"`，读侧 `providers_join` 又要求
`p.app_type = l.app_type`；DSH 明细行的 `app_type` 是 `dsh`，而 providers 表里 DSH 供应商的
`app_type` 是 `deepseek-harness`，两边永远连不上，`provider_name_coalesce` 就落到占位名
`DeepSeek Harness (Session)`（中文界面在供應商列显示为「工作階段日誌」）。这跟「切没切路由」无关：
**DSH 的用量行全部来自会话日志导入**，中转本身是字节透传，不写用量行。

数据侧有两个已存在的事实可以直接用，不需要重解析日志：

- 明细表的 `provider_type` 列的注释语义是「供应商类型 / 标识」，DSH 导入时已经写入了真实 provider
  key（例如 `tx`、`yapi-gpt-default`）；
- `providers` 表里 DSH 供应商的 `id` 就是 DSH 配置里的 provider key（`app_type='deepseek-harness'`）。

**修法**（写侧 + 回填 + 读侧，三处一起）：

1. **写侧**：`session_usage_dsh.rs` 在插入前用 `resolve_provider_id()` 查
   `providers(id, app_type='deepseek-harness')` 是否存在，存在就落真实 id，否则回落 `_dsh_session`；
   结果按 provider key 在本次同步内缓存，避免逐行查库。
2. **回填**：同一次同步事务里跑 `backfill_provider_ids()`，把历史上 `provider_id='_dsh_session'`
   且 `provider_type` 能在 providers 表里查到的明细行原地改成真实 id，条件幂等，重复跑不产生变化。
3. **读侧**：`usage_stats.rs` 的 `providers_join` 只对 `app_type='dsh'` 折叠成 `deepseek-harness`，
   写成 `CASE` 等值连接而不是 `OR`，保持等值语义、不放大行数。

## 逐条实现

### 1. 页内视图（`src/hooks/useDshModeView.ts` + `src/App.tsx`）

| 场景                      | 修前                     | 修后                                           |
| ------------------------- | ------------------------ | ---------------------------------------------- |
| 接管中从别的应用切回 DSH  | 直連视图 + 矛盾提示      | 路由视图，无提示                               |
| 接管中点「直連」pill      | 只改全局页签，切走即丢   | 本次会话内保持直連视图，显示「回到直連」提示条 |
| 直連中点「路由」pill      | 同上                     | 显示「開始路由」提示条，点按钮才写配置         |
| 中转状态变化（接管/断开） | 视图与状态可能长期不一致 | 覆盖值立即作废，回到推导值                     |

只写覆盖值、不写配置：pill 点击不触发 attach/detach，真正写文件仍然只有提示条按钮和「路由設定」sheet。

### 2. 侧栏标签（`src/hooks/useSidebarStatus.ts`）

- `app === "deepseek-harness"` → `mode = dshAttached ? "route" : "direct"`；
- 保留「模式不是直連但本机代理服务没跑」的告警口径（`status.alert`），DSH 的告警文案仍由 `modeTag`
  的通用逻辑决定；
- memo 依赖补 `dshAttached`，避免标签滞后一拍。

### 3. 供应商归属（`src-tauri/src/services/session_usage_dsh.rs` + `usage_stats.rs`）

- 常量：`PROVIDER_PLACEHOLDER = "_dsh_session"`、`PROVIDER_APP_TYPE = "deepseek-harness"`。
- `resolve_provider_id()`：`SELECT EXISTS(SELECT 1 FROM providers WHERE id = ?1 AND app_type = ?2)`；
  只对本次同步内出现过的 key 查一次。
- `backfill_provider_ids()`：

  ```sql
  UPDATE proxy_request_logs SET provider_id = provider_type
   WHERE data_source = 'dsh_session' AND provider_id = '_dsh_session'
     AND provider_type IS NOT NULL AND provider_type <> '_dsh_session'
     AND EXISTS (SELECT 1 FROM providers p
                  WHERE p.id = proxy_request_logs.provider_type
                    AND p.app_type = 'deepseek-harness')
  ```

- 读侧 join：`AND CASE WHEN l.app_type = 'dsh' THEN 'deepseek-harness' ELSE l.app_type END = p.app_type`。
- 未注册过的 provider（供应商已删除、日志来自旧配置）继续回落 `_dsh_session` → 「DeepSeek Harness
  (Session)」，这是有意保留的兜底，不伪造供应商。

## 测试

### 前端

- 新增 `tests/hooks/useDshModeView.test.tsx`（3 例）：默认跟随 relay；手动选择在 rerender 后保持；
  relay 状态翻转后覆盖值被丢弃。
- 新增 `tests/components/shell/SidebarDshMode.test.tsx`（5 例）：DSH 接管时标签为 `路由`、未接管为无
  标签、选中行不渲染标签、其他应用不受影响、告警口径不变。
- 定向回归：`vitest` 4 个文件 **23 passed**（`useDshModeView` 3、`DshRelayNotice` 4、`DshModeBar`
  11、`SidebarDshMode` 5）。
- `pnpm typecheck` 0 错误；`prettier --check` 干净。

### 后端

- `session_usage_dsh`：8 passed / 1 ignored，新增 4 例：真实 provider id 落库、provider 属于别的 app
  时回落占位符、回填幂等且只作用于 `dsh_session` 行、空根目录不报错。
- `usage_stats`：48 passed，新增 2 例：`app_type='dsh'` 行能读到 `deepseek-harness` 供应商名；查不到
  供应商时保持占位显示。
- `cargo check` 0；`cargo fmt --check` 干净；`cargo test` 定向三组 **52 / 20 / 1 passed**；
  clippy 仅剩既有的 `deepseek_harness_patch.rs:93 redundant_closure`（非本轮引入）。

### 全量

`vitest` 全量 249 个文件 / 3269 例：**3266 passed**，3 例 jsdom 超时（`5000ms`×2、`10000ms`），
全部是机器负载下的超时（AppsPage 的复制命令用例、App.test.tsx 的两个流程用例），单独重跑均通过，
不是本轮回归。

## 实机验证（CDP，`ccswitch-dsh8-bugs.cjs`）

部署版 GUI 上按用户路径完整走一遍（`http://tauri.localhost/`，WebView2 CDP 9366）：

| 步骤                              | 结果                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------- |
| 直連 → 点「路由」pill             | 仅切视图，出现「開始路由」提示条，未写配置                                       |
| 点「開始路由」                    | `attached=true`，5 家 provider `relayed`，状态行「路由生效中 → 5 家供應商」      |
| 切到 Claude Code                  | 侧栏 DSH 行显示 `DeepSeek Harness 路由`（与 Claude Code 同款标签）               |
| 切回 DSH                          | 「路由」pill 仍为 `aria-pressed=true`，页面无「目前是」矛盾提示                  |
| 触发 `sync_session_usage`         | 导入 21 条、跳过 96 条、扫描 174 个文件、0 错误                                  |
| `get_request_logs{appType:"dsh"}` | 最近 20 条供應商全部为 `WorkBuddy`（`providerId=tx`），无 `工作階段日誌`         |
| 用量页請求日誌                    | 19:06 起的 DSH 行顯示 `DSH / WorkBuddy / deepseek-v4.1-flash`                    |
| 收尾                              | 点「回到直連」，`attached=false`、`relayed=0`，patch 恢复 13,300 B、0 处 `/dsh/` |

截图（`D:\DevelopmentFolder\默认工作区\ccswitch-dsh8-shots\`）：
`01-initial-direct.png`、`02-route-view-cta.png`、`03-attached-route-view.png`、
`04-claude-sidebar-dsh-route-pill.png`、`05-back-to-dsh-stays-route.png`、`06-usage-page.png`、
`07-final-direct.png`。

数据库核对（`~/.cc-switch/cc-switch.db`）：

- 用户报的 18:21:13–18:21:31 那批 `deepseek-v4.1-flash` 行，`provider_id` 全部已是 `tx`；
- 明细行分布：`tx` 12,429、`yapi-gpt-default` 2,044、`yapi-default-claude` 246、`spacetimeai` 5；
- 仍是 `_dsh_session` 的 590 行，`provider_type` 是 `xiaobai` / `xianyu` / `deepseek-account` —— 这些
  provider 已不在 DSH 供应商表里，按设计回落占位显示。

## 构建与部署

- 版本号四处同步为 `4.0.14-dsh.8`：`package.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、
  `src-tauri/tauri.conf.json`。
- 离线 release 构建：`pnpm tauri build --no-bundle`，**3m 38s** 完成；前端 `index-DHVtq390.js`
  5,870.00 kB（gzip 1,714.41 kB）。
- 部署：旧 exe 备份为 `D:\Tools\CCSwitch\cc-switch-4.0.14-dsh.7.exe.bak`，新 exe 覆盖
  `D:\Tools\CCSwitch\cc-switch.exe`。
  - 大小 43,036,672 B，`ProductVersion = 4.0.14-dsh.8`；
  - SHA256 `AED400FA0ADEE5C4B43182C5A93D76E70ADDDE5560BA8E2719AB83652EBB6F2F`。
- 重启后 PID 16652，CDP `http://127.0.0.1:9366/json/version` 正常（Edg/155.0.4283.62）。

## 已知限制

- `usage_daily_rollups` 没有 `provider_type` 列，已经归档（`rollup_and_prune` 之后）的历史日期无法反推
  真实供应商，仍显示 `DeepSeek Harness (Session)`；本次修复只覆盖明细行与之后的导入。截至今日本机
  DSH 还没有 rollup 行，所以界面上暂时看不到这种残留在表里，但口径要如实说明。
- 供应商被删除后，历史明细按真实 id 显示原始 key（例如 `tx`），与 Claude Code 等应用的行为一致。
- 中转是字节级透传，不解析响应体，所以**速度 / 首字耗时仍为 `—`**；`deepseek-v4.1-flash` 的「未定價」
  是模型价格表没有该模型，与本轮无关。按请求记录 DSH 的 usage/timing 需要解析 SSE 并写日志，属于更大
  的后续项。
- `get_provider_stats` 按 `(provider_id, app_type)` 分组，`(tx, 'dsh')` 与 `(tx, 'deepseek-harness')`
  在接口层是两组，界面会折叠显示；这是既有结构，未在本轮改动。
- 侧栏标签在选中行隐藏（与 Claude Code 一致），所以「切回 DSH 后看不到自己的标签」是设计，不是回归。
- 用量页顶部「工作階段日誌 · 剛剛同步」是数据来源徽标，本来就该出现；本轮修的是供應商列。

## 回滚

1. 关掉 DSH 中转（应用页「直連」→「回到直連」），确认 `cordis.patch.yml` 已无 `/dsh/` 地址。
2. 关闭用量页自动同步，用备份恢复 `~/.cc-switch/cc-switch.db` 与 `settings.json`。
3. 换回 `cc-switch-4.0.14-dsh.7.exe.bak`（或更早的备份），重新打开 DSH 检查供应商与 API 地址。
4. 旧版会把 DSH 视图存回 `currentView = "dshRelay"`；`dsh.8` 启动时会把该值迁移成供应商页，不需要
   手工清 localStorage。
