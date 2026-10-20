# DSH 模型字段与推理等级

> **现状（`4.0.14-dsh.14` 起）**：DSH 的推理等级改为 **原生按模型 `reasoningEfforts`** 对接——控件语义、校验和落盘格式都对齐 DSH 44.7 自带的模型编辑器，`dsh-desktop-ui-reasoning-effort` 插件那套「推荐预设 / 自适应思考 / 已强制关闭思考」不再参与。DSH 模型目录不再有旧版「保存为预设 / 套用提示」入口；全局「设置 → 模型预设」里的「从已配置供应商导入」和 DSH 表单里的「一键匹配预设」仍可用，它们会带上并恢复模型字段快照（含 `reasoningEfforts`），但档位本身始终由模型行上的原生开关编辑。历史实现见文末「历史版本」一节。

## 现状：模型行内联编辑

打开 DSH provider 的编辑页，模型都在「模型目录」（Model Catalog）里逐行维护：

1. 点「获取模型列表」从 DSH 的模型目录读取可选模型并应用，或点「添加」手填一行。
2. 每行直接编辑模型 ID、显示名称、上下文窗口和推理等级；行内推理等级按下一节的原生规则编辑。
3. 已取到模型列表时，模型 ID 输入框右侧还有下拉，可以就地换 id，其他列不受影响。
4. 保存 provider 时整张模型表写回 DSH 配置；表单不认识的行级字段原样透传，不会因为这里没编辑而丢失。

provider 级生成参数只剩「最大输出 tokens」（`maxTokens`），留空则不写。上一版 provider 级「思考等级」（`reasoningEffort`）输入框在本版移除，但两条原生路由的处理不同：

- 手写 pi-ai 路由：原生 provider 只声明模型级 `reasoningEfforts` 与 `profile.reasoning`，没有 `reasoningEffort`。因此保存时会剥离配置里遗留的 `reasoningEffort`（发现该键时弹一次 toast 说明），且不迁移成 `profile.reasoning`（避免改变用户没要求的行为）。
- 官方 `llm-deepseek` 路由：原生 schema 确实有 provider 级 `reasoningEffort`（`off|low|high|max`），但 DSH 自带设置页没有对应控件；CCS 同样不渲染输入框，保存时原样保留该值，不删除、不改名。

## 推理等级：DSH 原生语义

每个模型行上的「推理等级」是一个开关加一张档位表：

- **开关关闭 = 不声明**：保存时该字段整体删除，DSH 按模型目录的能力自动判断要不要思考；开关下方固定提示「未声明推理等级时，DSH 按模型目录的能力自动判断。」
- **开关打开 = 声明**：自动播种 `off`、`low`、`medium`、`high` 四档，`off` 的参数值是 `null`，其余取档位名本身；表格出现「档位 / API 参数值」两列。
- 档位固定七档：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`，档位名保留英文原文，对照 DSH 自己的编辑器。
- 「添加档位」取当前最高档位之上第一个还没用过的档位；七档全用上后按钮禁用。
- 每行都可以删，包括最后一个非 `off` 档；删成空对象时保存会被拦下，并提示「至少添加一个 Off 以外的档位；不需要思考请关闭推理等级。」
- `off` 行的参数值输入框禁用，占位「关闭思考」；已经存过的值（例如 `none`）照常显示。其他档位把参数值清空或失焦后回落到默认值：`off` 是 `null`，其余是档位名本身。
- 配置里已经存在的未知档位（网关自定义等级）保留在第一行，可以改成七档之一，不会被自动删除或改写。
- `reasoningEfforts: false` 表示这个模型不提供思考参数：开关关闭时只读保留并显示「已禁用」；打开开关会把它覆盖成普通对象，此时不再能退回 `false`。
- 触发器摘要按状态显示：「已禁用」（显式 `false`）、「未设置」（字段缺省）、「待配置」（对象为空或格式非法），其余折叠档位——连续三档及以上折叠成 `low → max`，不足三档逐个列出，断档照实拼接（例如 `low, high → max`）。档位不合法时触发器转错误色，但仍可点开改。
- 行数只受七档限制；编辑器允许编辑期出现 `{}`，但保存前会硬校验。

保存 provider 前会按原生格式校验每个模型行：空对象、只有 `off`、非 `off` 档的参数值为空、未知档位等都会被拦下，弹 toast 指出是哪个模型（没有模型 ID 时显示「未命名模型」）以及具体原因，不会把非法值写进配置。

## 落盘格式

配置落盘在 `~/.dsh/profiles/<profile>/cordis.patch.yml`（实测为 `profiles/desktop/cordis.patch.yml`）里 `llm-pi-ai` 这一项的 `config.providers` 下，即：

```text
providers.<providerId>.models[].reasoningEfforts
```

只有三种合法形状：

- 字段省略：继承，交给 DSH 自动判断。
- `false`：这个模型不提供思考参数。
- 非空对象：档位到 API 参数值的映射，值可以是字符串或 `null`；`null` 只允许出现在 `off` 上。

关闭开关只会删除该字段，不会写 `{}` 或 `null`；档位参数值清空后回落到默认值，不会留下空字符串。界面文案来自 `src/i18n/locales/zh.json` 的 `dshReasoning` 块，英文、日文、土耳其文和繁体中文对应 locale 保持同一套 key 与语义。

### 官方 `llm-deepseek` 路由

官方路由（`dsh_deepseek` / `deepseek-official`）走的是 `llm-deepseek` 包，模型行 schema 只有 `id`、`name`、`description`、`contextWindow`、`maxTokens`、图像/系统提示/工具更新、`inputModalities` 等字段，没有 `reasoningEfforts`；DSH 自带设置页也不提供模型级推理编辑。CCS 对官方路由隐藏整列，已有 `models[].reasoningEfforts`（例如旧插件写下的）只原样透传，不展示、不校验、不改写。provider 级 `reasoningEffort` 同理保留，不暴露编辑入口。

## 模型预设：导入与一键匹配

模型预设功能仍然可用，但不再生成推荐档位：

- 「设置 → 模型预设」里的「从已配置供应商导入」可以选中一个 DSH 供应商，列出它当前配置的全部模型（显示名称、模型 ID、上下文窗口、推理等级），逐行勾选后一次批量生成预设；已有相同匹配 ID 的模型标记「已有预设」并跳过，只有 ID 的模型标记「无可导入参数」，不会静默覆盖已有预设。供应商凭据、地址等连接信息不进入预设。
- 导入时会带上模型行里已有的原生 `reasoningEfforts` 快照（原值深拷贝，不排序、不修复、不丢失未知档位）；旧插件写在模型行上的单字符串 `reasoningEffort` 和旧目录预设的 `extraParams.dsh` 命名空间都会被跳过。
- DSH 供应商表单里的「一键匹配预设」按精确优先 / 通配规则把预设套到当前草稿里的模型行，确认只改表单草稿，保存 provider 后才落盘。

这里的「推理等级」是模型当前 `reasoningEfforts` 的快照，会作为普通模型参数随预设导入和套用：套用时整表替换目标模型行的 `reasoningEfforts`，不会合并或生成推荐值；没有快照的旧预设不会改动目标行的推理等级。套用后仍以模型行上的原生开关为准，可以继续编辑；非法快照不会被套用逻辑修复，而是在保存 provider 时按原生规则拦下。旧预设顶层的 `reasoningEffort` 与 `extraParams.reasoningEffort` 不是 DSH 模型行字段，套用时忽略。

## 历史版本（`dsh.1`–`dsh.13`）

`dsh.1`–`dsh.3` 期间 DSH 模型目录另有一套预设入口，`dsh.4` 起按钮和调用路径都已移除，本仓库不再提供以下操作，仅作历史留档：

- **「保存为预设」**：把目录里每个模型（含推理等级）一次写入全局 `AppSettings.modelPresets`；已有同名预设会更新，没有则新建。模型 ID 比较不区分大小写，预设名称优先用模型行的显示名称。保存内容含模型的 `contextWindow`、provider 级 `reasoningEffort`、provider 级最大输出 tokens，行级参数放在 `extraParams.dsh` 命名空间里，避免影响其他应用共用的预设。
- **套用提示**：之后在 DSH 模型目录新增同名模型时会出现套用提示，可恢复上下文窗口、最大输出 tokens、provider 级 reasoning effort，以及该模型行的 `reasoningEfforts`、`input` 和 `compat`。DSH 表单没有 temperature 的专用位置，预设含 temperature 时提示跳过。
- **「设为通用参数」**（`saveDefaults`）与**套用通用参数的入口**（`applyGeneric`）：前者把 provider 级 Reasoning Effort 和 Max Output Tokens 存成兜底通用参数（两者都为空时提示不保存），后者把通用参数套到默认模型（没有默认模型时套到第一行）。

`dsh.4`–`dsh.13` 期间推理等级由 `dsh-desktop-ui-reasoning-effort` 插件镜像驱动：行内先是等级胶囊、后来换成下拉多选面板，另配「推荐预设」（按模型族写入推荐 wire 值，Claude 走 Anthropic 通道时还会写 `compat.forceAdaptiveThinking`）、「已开启自适应思考」、「已强制关闭思考」和「清除推理等级」。`dsh.14` 起这些入口、推荐表和对应 helper 全部删除，改为上面的原生语义。

这些入口移除后，历史数据（`AppSettings.modelPresets` 里的 DSH 条目及其 `extraParams.dsh`、模型行上的 `reasoningEffort`）如果还留在旧配置里，DSH 的导入和套用都会跳过这些非原生字段，也不会主动清理；全局模型预设对其他应用照旧生效。

## 常见检查

- 新增/编辑模型后保持开关关闭并保存，确认配置里该模型行没有 `reasoningEfforts`（不是 `{}`、也不是 `null`）。
- 打开开关，确认播种 `off`、`low`、`medium`、`high` 四行，`off` 的值是 `null`、其余是档位名。
- 把某行参数值清空再失焦，确认回到默认值；把 `off` 行改回其他档位，确认输入框解禁。
- 删掉所有非 `off` 档再保存，确认被 toast 拦下并给出档位提示。
- 显式 `false` 的模型行确认开关关闭时只读保留，保存后配置仍是 `false`。
- 保存后重新打开 provider，确认模型行的上下文窗口、推理等级和「最大输出 tokens」仍在；手写 pi-ai 路由的配置里没有遗留的 provider 级 `reasoningEffort`，官方路由原有的 `reasoningEffort` 则保持不变。

## 已知限制与待验证事项

- 档位和参数值完全按用户声明写入，不再有内置推荐表：不同上游真正接受的 wire 值需要自己对着上游文档填（旧版的模型族推荐表已移除）。
- 手写 pi-ai 路由的原生语义不提供 provider 级默认推理等级，也没有「清除推理等级」这种一键重置入口——要退回继承就关掉开关；官方路由的 provider 级 `reasoningEffort` 是另一套字段，CCS 只透传。
- 未知档位只做保留和可改回七档的处理，不会被静默改写或删除。
- 模型行上的 `input`、`compat` 等字段仍只原样透传，`compat.forceAdaptiveThinking` 也不再由本表单写入或删除。
- 全局模型预设（`AppSettings.modelPresets`）跨应用共用；DSH 可以导入和套用其中的模型字段（含原生 `reasoningEfforts` 快照），但没有 DSH 专属的目录级预设入口。旧插件的模型级 `reasoningEffort` 和 `extraParams.dsh` 只存在于旧数据里，DSH 导入/套用时跳过。

## 实测结果（`4.0.14-dsh.3`，历史）

以下为 `dsh.3` 时的实机记录，其中“保存为预设”和“等级胶囊”控件在 `dsh.4` 起已不存在、`dshReasoningPresetMirror.test.ts` 也在 `dsh.14` 删除，数值仅作历史留档：

- 部署版 GUI 冒烟：在一个已调好参数的 WorkBuddy 线路上点一次“保存为预设”，模型预设数量由 `0` 变成 `7`（该线路 7 个模型一次入库：`deepseek-v4.1-flash`、`glm-5.3-flash`、`hy4-preview`、`kimi-k3-1`、`minimax-m3`、`space-bunny`、`step-5-preview`），随后清回测试前状态。
- 推理等级冒烟：模型行共渲染 50 个等级胶囊（7 档 × 7 行，部分行族受限），点击“高”后该按钮 `aria-pressed` 由 `false` 变 `true`，落盘与插件 `reasoningEfforts` 语义一致。（当时的胶囊控件，`dsh.4` 起换成下拉多选面板，`dsh.14` 起换成原生开关加档位表。）
- 前端单测：`DeepSeekHarnessFormFields.reasoningEfforts.test.tsx` 与 `dshReasoningPresetMirror.test.ts` 全绿，`tsc --noEmit` 0 错误。
