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
8. **DSH 模型预设改为内联编辑**：DSH 模型目录里不再提供 `dsh.1`–`dsh.3` 的目录级「保存为预设 / 套用提示」入口，也不能把生成参数另存成通用参数；模型参数直接按 OpenCode 那种方式在模型行里改（模型 ID、显示名称、上下文窗口、推理等级；官方路由的推理等级列隐藏）。全局的「设置 → 模型预设」页面（含「从已配置供应商导入」）、DSH 表单里的「一键匹配预设」，以及 Codex / Claude Code 各自的预设功能都还在。
9. **DSH 模型级推理等级（`4.0.14-dsh.14` 起为 DSH 原生对接）**：手写 pi-ai 路由的模型行里「推理等级」直接按 DSH 44.7 原生 `reasoningEfforts` 语义编辑——开关关闭＝不声明该字段（继承 DSH 按模型目录能力的自动判断），打开＝自动播种 `off`/`low`/`medium`/`high`（`off` 写 `null`，其余写档位名），档位固定七档 `off/minimal/low/medium/high/xhigh/max`，参数值按档位声明、`off` 行的输入框禁用；配置写入 `providers.<id>.models[].reasoningEfforts`，值可以是字符串或 `null`，特殊值 `false` 表示该模型不提供思考参数；保存 provider 前按原生格式硬校验，空对象、只有 `off`、非 `off` 档值为空、未知档位都会被拦下。官方 `llm-deepseek` 路由的模型行 schema 没有 `reasoningEfforts`，表单不渲染这一列，已有值原样透传、不参与该校验。
10. **用量页 Token 计数单位**：用量页「顯示」里可选国际缩写（`1K` / `1M` / `1.61B`）或中文单位（`1千` / `100万` / `16.1亿`），选择存进 `settings.json` 的 `usageDisplay.tokenUnit`；指标卡、统计表、请求日志、图表轴、侧栏「今日」与会话详情统一跟随，悬停仍显示精确整数。
11. **DSH 连接模式行与供应商列表动作**：DeepSeek Harness 应用页顶部是 Claude Code 同款分段控件（`直連` / `路由` + `?` 说明 + 生效状态行），不再用下划线页签；两个 pill **只切换正在查看的视图、点击不写任何配置**，切换中转改由列表上方的提示条按钮完成（「開始路由」/「回到直連」，只有它才 attach / detach 并弹 toast），页头右侧那个重复的快捷开关已删除；「路由」视图与「直连」渲染同一份供应商列表（页头的「新增供應商」与搜索在两边都可用），已被接管的卡片显示绿色「路由中」徽标与绿色底色；「路由設定」收进模式行右端的齿轮 sheet（退出还原开关 + 是否接管 / 本机中转地址 / 各 provider 地址映射 + 刷新），中转开关不在 sheet 里；状态读不到时提示条按钮 disabled、sheet 状态区显示不可用，不会盲目写配置。DSH 供应商列表去掉「設為預設」，与 OpenCode 一致只保留「加入 / 移除」，当前生效的供应商仍作只读标记。
12. **DSH 中转还原的写入可靠性（`4.0.14-dsh.7`）**：修掉「切回直連 / 退出 CCS 之后 DSH 还走本机中转」的回归。改写 `cordis.patch.yml` 时按退避重试 8 次、仍失败则原地重写，替换掉会在 `ReplaceFileW`（`os error 1175`）上直接放弃的旧路径；读配置同样退避重试 6 次。还原判定不再比字符串，只看当前值是不是 loopback `/dsh/` 地址；原始地址按「侧车台账 → 数据库 → `.ccswitch.bak` → `~/.dsh/recovery/`」四级兜底；写完回读核对最多 3 轮；成功后账本保留为「原始地址台账」，退出钩子与启动自检都以文件事实为准。仍有残留时界面给「N 个 provider 的地址还没换回原始直连地址」的警告，不再谎报成功。
13. **DSH 三处状态显示修复（`4.0.14-dsh.8`）**：①「直連 / 路由」改为由中转实际状态推导的**页内视图**（`useDshModeView`），切去别的应用标签再切回 DSH 不会退回「直連」并弹出「你在查看「直連」，DeepSeek Harness 目前是路由」的自相矛盾提示；手动切换只在本次会话内生效，中转状态一变即作废，旧版本存下的 `dshRelay` 页签自动迁移成供应商页。②侧栏的 DSH 行补上与 Claude Code 同款的 `路由` 标签：接上中转即显示（选中行按既有设计不显示标签），不再恒为「直連」。③用量统计里 DSH 行的供应商不再一律显示「工作階段日誌」：导入会话用量时优先落真实 `provider_id`（会在 `app_type='deepseek-harness'` 的 providers 里核对存在性，否则回落 `_dsh_session`），同步事务内用 `provider_type` 幂等回填历史明细行，读侧的 providers 连接只对 `app_type='dsh'` 折叠成 `deepseek-harness`（CASE 等值连接，不放大行数）；已归档进 `usage_daily_rollups` 的历史行因无 `provider_type` 列无法反推，仍显示 `DeepSeek Harness (Session)`。
14. **用量趋势图按模型细分与 DSH 模型行压缩（`4.0.14-dsh.9` / `4.0.14-dsh.10`）**：①「用量统计 → 使用趋势」的 Tokens 悬停卡片显示完整整数明细：输入（命中缓存）、输入（未命中缓存）、缓存写入（有数据时）、输出；筛选「全部模型」时再加一段「模型」，按总 token 降序列出各模型（超过 10 个时其余合并为「其他 N 个模型」），不显示模型费用。②后端在 `DailyStats` 上附带按模型的 token 汇总，历史明细已归档的日期从 `usage_daily_rollups` 联合取数，切换日期或小时仍能给出模型数据。③柱状图的 Tokens 指标改为**一根柱按模型占比堆叠**，不再按 token 类型分段；曲线面积图保留原来的总 token 构成（命中 / 未命中 / 写入 / 输出堆叠面积），并在其上叠加每个模型的 token 消耗曲线，颜色与 tooltip、图例共用同一套按总量排序的调色盘。筛选单个模型时隐藏模型图例，柱为单色、面积图保留 token 构成。④DSH 供应商的模型配置从两行改为一行紧凑网格（模型 ID、显示名、上下文窗口、推理等级、删除），推理等级面板同时补齐「使用预设 / 清除 / 已关闭」状态（这些预设 / 清除状态以及插件侧语义已由 `4.0.14-dsh.14` 的原生对接取代，见第 17 条）。
15. **从已配置 DSH 模型批量导入预设与批量匹配（`4.0.14-dsh.12`）**：模型预设页新增「从已配置供应商导入」，选择 DSH 供应商后直接列出它的全部模型，表格与 DSH 模型配置页一致（显示名称、模型 ID、上下文窗口、推理等级），每行可勾选并支持表头全选 / 清空，一次批量生成预设。每个模型导入它当前配置的全部模型参数，预设名取显示名称、匹配 ID 取模型 ID；已有相同匹配 ID 的模型标记「已有预设」并禁用，仅有 ID 的模型标记「无可导入参数」并禁用，不会静默覆盖。导入保留原有预设与通用参数；供应商凭据、地址等连接信息不进入预设。DSH 供应商表单新增「一键匹配预设」：弹窗左侧列出模型 ID，右侧按精确优先 / 通配规则选择匹配预设，未命中显示「未匹配」，可手动改选其他模型预设或通用预设。确认只更新当前表单草稿中选中的行，保持模型 ID、显示名称与未覆盖参数；取消不改动，供应商保存后才落盘。导入表格里的「推理等级」是模型当前 `reasoningEfforts` 的原值快照，只读展示；导入会把它作为普通模型字段写进预设，一键匹配套用时再把整张表恢复到目标模型行。套用后仍以模型行上的原生开关为准，可以继续编辑；缺少该快照的旧预设不会改动目标行的推理等级，旧插件写在模型行上的单字符串 `reasoningEffort` 与旧目录预设的 `extraParams.dsh` 命名空间会被导入/套用跳过。
16. **设置里新增「模型定价」入口（`4.0.14-dsh.13`）**：内置的模型价格表（用量成本的估算依据）原来只藏在「用量统计 → 定價」子页签里，很难找到。现在设置的目录里加入独立分区「模型定价」，直接复用同一份 `PricingConfigPanel`：可查看/编辑单价、新增与删除、按 models.dev 批量导入，以及配置计费默认值与 models.dev 自动同步；标签、单位（USD / 每百万 tokens）与写入路径完全不变，只多一个入口。价格表是独立数据，设置本身没加载完或读取失败时这个分区仍可正常使用；「用量统计 → 定價」入口保留。注意：从 models.dev 同步所选模型时，同名的手工价格仍会被覆盖（原行为，未改动），界面上已明确提示。
17. **DSH 推理等级改回 DSH 原生 `reasoningEfforts`（`4.0.14-dsh.14`）**：推理等级不再由 `dsh-desktop-ui-reasoning-effort` 插件的推荐预设 / 自适应思考 / 强制关闭推导，改成与 DSH 44.7 自带编辑器一致的原生语义：每行一个开关，关闭＝删除 `reasoningEfforts` 字段（继承），打开＝播种 `off`/`low`/`medium`/`high`，档位固定七档，`false` 保留「该模型不提供思考参数」的含义，配置里已存在的未知档位原样保留、可改回七档。手写 pi-ai 路由保存前按原生格式硬校验，空对象、缺非 `off` 档、非 `off` 档参数值为空、未知档位都会被 toast 拦下并指明模型（无 ID 时显示「未命名模型」）；官方路由不渲染该列，也不走这套校验。**同时移除供应商级的「思考等级」（`reasoningEffort`）输入**：对手写 pi-ai 路由，该字段不是原生 profile 字段（原生是 `profile.reasoning`），保存时会把配置里遗留的同名键删掉（发现该键时弹一次 toast 说明），不迁移成 `profile.reasoning`；官方 `llm-deepseek` 路由的原生 schema 确实声明了 provider 级 `reasoningEffort`（`off|low|high|max`），只是 DSH 自带设置页没有对应控件，CCS 同样不提供输入，但保存时原样保留、不删除也不改名。设置 JSON 占位符里的 `reasoningEffort` 展开项对自定义路由移除。旧的推荐预设、自适应思考、强制关闭、清除等级入口与对应 helper，以及那份插件镜像契约测试全部删除；模型预设的导入 / 一键匹配功能保留，导入会把模型当前的原生档位 `reasoningEfforts` 作为字段快照写进预设，套用时整表恢复到目标模型行（套用后仍由原生开关编辑，缺少快照的旧预设不改动档位）。
18. **用量趋势新增时间粒度切换（`4.0.14-dsh.15` / `4.0.14-dsh.16`）**：「用量统计」的时间范围后面新增「时间粒度」下拉，可选 10 分钟 / 30 分钟 / 1 小时 / 12 小时 / 1 天（12 小时档于 `4.0.14-dsh.16` 加入）。切换范围会自动回到默认粒度：当天 30 分钟、近 24 小时 1 小时、近 7 天 12 小时、近 14 天和近 30 天 1 天；手动选的粒度会保留到下次切换范围。选「全部」时仍显示热力图，不显示粒度控件。后端趋势查询按 `bucketSeconds` 分桶并校验 600/1800/3600/43200/86400，子日粒度（含 12 小时）按明细日志统计，日粒度继续合并 `usage_daily_rollups`；子日粒度不能覆盖已被归档删除的明细，查询超过约 30 天保留期的自定义区间时可能少计，日常预设范围不受影响。
19. **自定义应用聚合路由（`4.0.14-dsh.17` / `4.0.14-dsh.18`）**：新增「自定义应用」后端能力，每个应用独立生成 `ccs_` 前缀的本地 API Key 并可重置，地址由前端按当前代理端口拼接。应用只支持路由模式，不单独维护供应商；`GET /custom/<app_id>/v1/models` 聚合 providers 表中已配置且兼容 OpenAI Chat 的固定应用供应商模型（Codex 需 `wire_api=chat`，DSH 需 `openai-completions`，Grok 需 `api_backend=chat`，其他应用需显式 OpenAI Chat 协议；Claude/Gemini/Responses 不列出），对外 id 为 `<上游模型>-<providerId>`，`POST /custom/<app_id>/v1/chat/completions` 按外部 id 精确选择 provider并复用 OpenAI Chat Completions 转发/SSE/usage 解析，用量记录到 `app_type=custom-<uuid>`。认证支持 `Authorization: Bearer` 与 `X-API-Key`；未列出的 `/custom` 路径与协议返回 404，固定应用既有路由保持原样。

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
