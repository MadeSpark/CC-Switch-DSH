# 完全自用说明 / Personal-Use Notice

> 本仓库是 **MadeSpark 个人自用** 的 CC Switch 修改版，**不是**官方发行版，也**不面向公众分发**。
> This repository is a **personal-use-only** fork maintained by MadeSpark. It is **not** an official release and is **not intended for public distribution**.

## 代码来源 / Provenance

本仓库的代码来自上游开源项目，并按个人需要做了本地修改：

| 来源     | 说明                                                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 上游项目 | [farion1231/cc-switch](https://github.com/farion1231/cc-switch) — 原作者 Jason Young（MIT License，见 [LICENSE](LICENSE)）                 |
| 代码基线 | 上游 `main` 分支，对应上游提交 `73f37c4`（版本 `v4.0.14`），本地快照提交 `a84d6ee`                                                         |
| 功能来源 | 上游 PR 编号 **#7356**（DeepSeek Harness 原生集成，PR 作者 [yang227](https://github.com/yang227)），已合并进本仓库：本地合并提交 `70735d0` |
| 本仓库   | [MadeSpark/CC-Switch-DSH](https://github.com/MadeSpark/CC-Switch-DSH) — 仅存放个人修改版                                                   |

也就是说：**核心功能与绝大部分代码版权归上游作者所有**，本仓库只在其之上叠加了少量个人适配与改动，并保留了原始 MIT 许可证与版权声明。

## 与上游的差异 / Local changes

在“上游 `v4.0.14` + PR #7356（DSH 原生集成）”的基础上，本仓库追加了以下个人改动：

1. **DeepSeek Harness 供应商名称可编辑**：修复新增/编辑 DSH 供应商时显示名称总被重置为 `Custom DSH` 的问题；`settingsConfig.displayName` 与供应商名称保持同步（官方线路保持 `DeepSeek` 语义）。
2. **“取得模型列表”真正可用**：拉取成功后弹出模型选择对话框（搜索、勾选、元数据带入上下文窗口），不再只提示“取得 N 个模型”。
3. **彻底移除应用自身更新检测**：不再检查/下载/提示 CC Switch 自身的新版本，也没有联网更新接口；版本号仅作展示。CLI 工具（Claude Code、Codex 等）的升级检查等功能保持原样。
4. **新增“模型预设”功能**：可在设置里为模型 id（支持 `*` 通配）预设上下文窗口、最大输出 tokens、思考等级、温度、额外参数；给某个程序新增模型且模型 id 命中预设时，弹窗询问是否套用（不套用则完全保留手填值）；另提供一份“通用参数”给没有命中任何预设的模型兜底选用（可在设置里开关是否询问）。
5. **构建与运行环境的本地适配**：离线 Rust 工具链、本地 cargo 缓存与 pnpm shim；DSH 相关 Rust/前端集成细节（详见 [docs/architecture/dsh-native.md](docs/architecture/dsh-native.md)）。
6. **DSH token 消耗统计**：导入 `~/.dsh/sessions/**/session.v4.jsonl.zstd` 会话日志，将 assistant 用量写入统一统计，并通过记录 ID 与文件游标去重。
7. **DSH 中转与退出还原**：支持将 DSH provider 的 `baseURL` 指向 CC Switch 本机中转路由，并在用户主动退出 CCS 时恢复原始 API 地址。
8. **DSH 模型预设改为内联编辑**：DSH 里不再提供保存/套用模型预设的入口，也不能把生成参数另存成通用参数；模型参数直接按 OpenCode 那种方式在模型行里改（模型 ID、显示名称、上下文窗口、推理等级）。全局的「设置 → 模型预设」页面、以及 Codex / Claude Code 各自的预设功能都还在。
9. **DSH 模型级推理等级**：模型行里点开「推理等级」下拉，多选英文档位（`off/minimal/low/medium/high/xhigh/max`），也能套用模型族推荐预设或一键清空，配置写入 `providers.<id>.models[].reasoningEfforts`。
10. **用量页 Token 计数单位**：用量页「顯示」里可选国际缩写（`1K` / `1M` / `1.61B`）或中文单位（`1千` / `100万` / `16.1亿`），选择存进 `settings.json` 的 `usageDisplay.tokenUnit`；指标卡、统计表、请求日志、图表轴、侧栏「今日」与会话详情统一跟随，悬停仍显示精确整数。
11. **DSH 连接模式行与供应商列表动作**：DeepSeek Harness 应用页顶部是 Claude Code 同款分段控件（`直連` / `路由` + `?` 说明 + 生效状态行），不再用下划线页签；两个 pill **只切换正在查看的视图、点击不写任何配置**，切换中转改由列表上方的提示条按钮完成（「開始路由」/「回到直連」，只有它才 attach / detach 并弹 toast），页头右侧那个重复的快捷开关已删除；「路由」视图与「直连」渲染同一份供应商列表（页头的「新增供應商」与搜索在两边都可用），已被接管的卡片显示绿色「路由中」徽标与绿色底色；「路由設定」收进模式行右端的齿轮 sheet（退出还原开关 + 是否接管 / 本机中转地址 / 各 provider 地址映射 + 刷新），中转开关不在 sheet 里；状态读不到时提示条按钮 disabled、sheet 状态区显示不可用，不会盲目写配置。DSH 供应商列表去掉「設為預設」，与 OpenCode 一致只保留「加入 / 移除」，当前生效的供应商仍作只读标记。
12. **DSH 中转还原的写入可靠性（`4.0.14-dsh.7`）**：修掉「切回直連 / 退出 CCS 之后 DSH 还走本机中转」的回归。改写 `cordis.patch.yml` 时按退避重试 8 次、仍失败则原地重写，替换掉会在 `ReplaceFileW`（`os error 1175`）上直接放弃的旧路径；读配置同样退避重试 6 次。还原判定不再比字符串，只看当前值是不是 loopback `/dsh/` 地址；原始地址按「侧车台账 → 数据库 → `.ccswitch.bak` → `~/.dsh/recovery/`」四级兜底；写完回读核对最多 3 轮；成功后账本保留为「原始地址台账」，退出钩子与启动自检都以文件事实为准。仍有残留时界面给「N 个 provider 的地址还没换回原始直连地址」的警告，不再谎报成功。
13. **DSH 三处状态显示修复（`4.0.14-dsh.8`）**：①「直連 / 路由」改为由中转实际状态推导的**页内视图**（`useDshModeView`），切去别的应用标签再切回 DSH 不会退回「直連」并弹出「你在查看「直連」，DeepSeek Harness 目前是路由」的自相矛盾提示；手动切换只在本次会话内生效，中转状态一变即作废，旧版本存下的 `dshRelay` 页签自动迁移成供应商页。②侧栏的 DSH 行补上与 Claude Code 同款的 `路由` 标签：接上中转即显示（选中行按既有设计不显示标签），不再恒为「直連」。③用量统计里 DSH 行的供应商不再一律显示「工作階段日誌」：导入会话用量时优先落真实 `provider_id`（会在 `app_type='deepseek-harness'` 的 providers 里核对存在性，否则回落 `_dsh_session`），同步事务内用 `provider_type` 幂等回填历史明细行，读侧的 providers 连接只对 `app_type='dsh'` 折叠成 `deepseek-harness`（CASE 等值连接，不放大行数）；已归档进 `usage_daily_rollups` 的历史行因无 `provider_type` 列无法反推，仍显示 `DeepSeek Harness (Session)`。

## 使用限制 / Usage restrictions

- **仅供本人（MadeSpark）自用、学习与研究**，请勿将其作为官方版本分发、转售或用于商业分发。
- **不提供任何担保**（MIT 许可证的“AS IS”条款同样适用），使用本仓库代码或自行构建的产物造成的任何问题由使用者自行承担。
- **不提供技术支持**：本仓库不保证响应 issue / PR，也不保证与本仓库之外的上游版本保持同步。如需稳定与官方支持，请使用上游 [farion1231/cc-switch](https://github.com/farion1231/cc-switch) 的正式发行版。
- 上游的官方文档、官网（[ccswitch.io](https://ccswitch.io)）、社区与下载渠道均与本仓库无关；本仓库不冒充官方，也不代表上游作者的任何意见。
- 许可证：沿用上游 **MIT License**，原版权声明（Copyright (c) 2025 Jason Young）保留在 [LICENSE](LICENSE) 中，不得移除。

## 构建说明 / Build notes

本机离线构建（仅本地使用，不产出安装包）：

```bash
# 前端类型检查 / 单元测试
pnpm typecheck
pnpm test:unit

# 本地可执行文件（tauri build --no-bundle；Windows 离线环境不打包 NSIS 安装器）
# 具体命令见仓库内脚本与 docs/architecture/dsh-native.md
```

构建产物仅供本机使用，未签名、未公证，请勿对外分发。

---

如你是从上游项目误入本仓库：请直接前往 [farion1231/cc-switch](https://github.com/farion1231/cc-switch) 获取官方版本与官方支持。
