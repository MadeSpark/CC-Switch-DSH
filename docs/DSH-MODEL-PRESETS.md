# DSH 模型字段与推理等级

> **现状（`4.0.14-dsh.4` 起）**：DSH 不再提供保存/套用模型预设的入口，也不能再把生成参数存成通用参数——按需求对齐 OpenCode 的纯内联字段，DSH 的模型参数一律在模型行里原地编辑。全局「设置 → 模型预设」页面、以及 Codex / Claude Code 各自的预设保存与套用是另一套入口，不受影响。本文前半部分讲当前的模型字段与推理等级控件；`dsh.1`–`dsh.3` 期间存在过的预设能力见「历史版本」一节。

## 现状：模型行内联编辑

打开 DSH provider 的编辑页，模型都在「模型目录」（Model Catalog）里逐行维护：

1. 点「获取模型列表」从 DSH 的模型目录读取可选模型并应用，或点「添加」手填一行。
2. 每行直接编辑模型 ID、显示名称和上下文窗口；行内的「推理等级」按下一节的规则多选。
3. 已取到模型列表时，模型 ID 输入框右侧还有下拉，可以就地换 id，其他列不受影响。
4. 保存 provider 时整张模型表写回 DSH 配置；表单不认识的行级字段原样透传，不会因为这里没编辑而丢失。

生成参数区仍保留 provider 级的「思考等级」（`reasoningEffort`）和「最大输出 Tokens」（`maxTokens`），留空则不写对应字段。这两个字段和模型行的 `reasoningEfforts` 相互独立：前者是这张 provider 卡的默认发送参数，后者按模型逐档决定发什么。

## 推理等级控件

每个模型行都有「推理等级」标签和一个紧凑的下拉触发器（`aria-label` 为「推理等级」）：

- 没设置过任何档位时，触发器显示「未设置」；设置过则显示折叠后的档位说明。
- 点开是一个七行的多选面板（每行 `role="checkbox"`），从上到下依次是 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。档位名保持英文原文，不做翻译。
- 每行右侧的灰字是该档真正会落盘的发送值：`off` 显示「不发送」（对应 `null`），其余显示档位名本身；没有勾选的行显示 `—`。
- 点一下切换该档，面板不会自动关闭，可以连续勾选；数据仍在保存 provider 时统一写回。
- 最后一个非 `off` 档不能取消：该行置灰，点它只提示「至少要保留一个等级」。

触发器文案由 `formatDshReasoningLevelsLabel` 生成：已选档位按从弱到强排好后，连续三档及以上折叠成 `low → max`，不足三档逐个列出；中间断档照实拼接，例如同时勾了 low、high、xhigh、max 时显示 `low, high → max`。如果档位不在标准顺序里（网关自定义等级），按传入顺序用 `, ` 原样拼接，避免暗示中间档也被选中。

模型 ID 能识别模型族时，行内会显示「推荐预设 · {{family}}」入口或「{{family}} 预设」状态；识别的模型族仍是 GPT、OpenAI o、Claude、Grok、GLM 和 MiMo。Claude 的推荐预设走 Anthropic 通道时可能同时开启自适应思考（写入 `compat.forceAdaptiveThinking`，行内显示「已开启自适应思考」）；换模型或换通道后这个开关会被一并清掉。未识别的模型仍可手动逐档设置。

`reasoningEfforts` 被显式写成 `false` 时，行内显示「已强制关闭思考」（触发器仍显示「未设置」）；这与整个字段省略的「未设置」不是一回事。「清除推理等级」一次清掉该行所有档位（也包括这个显式 `false`），并移除 `compat.forceAdaptiveThinking`。

## 落盘格式

配置落盘在 `~/.dsh/profiles/<profile>/cordis.patch.yml`（实测为 `profiles/desktop/cordis.patch.yml`）里 `llm-pi-ai` 这一项的 `config.providers` 下，即：

```text
providers.<providerId>.models[].reasoningEfforts
```

字段值是一张等级到 wire 值的映射，wire 值可以是字符串或 `null`；特殊值 `false` 表示强制关闭思考。推荐表会把 `off` 映射为 `none` 或 `null` 等协议值，具体以模型族和当前推荐表为准；没有推荐值时，除 `off` 外的等级默认发送同名值。

全部取消后整个字段会被省略，而不是保存空对象 `{}`。该格式与 `dsh-desktop-ui-reasoning-effort` 插件保持兼容。界面使用的真实文案来自 `src/i18n/locales/zh.json`，英文、日文、土耳其文和繁体中文对应 locale 文件也保留相同的控件语义；七个等级名现在直接用英文原文，不再走 `dshReasoning.level_*` 翻译键。

## 历史版本（`dsh.1`–`dsh.3`）

`dsh.1`–`dsh.3` 期间 DSH 模型目录另有一套预设入口，`dsh.4` 起按钮和调用路径都已移除，本仓库不再提供以下操作，仅作历史留档：

- **「保存为预设」**：把目录里每个模型（含推理等级）一次写入全局 `AppSettings.modelPresets`；已有同名预设会更新，没有则新建。模型 ID 比较不区分大小写，预设名称优先用模型行的显示名称。保存内容含模型的 `contextWindow`、provider 级 `reasoningEffort`、provider 级最大输出 tokens，行级参数放在 `extraParams.dsh` 命名空间里，避免影响其他应用共用的预设。
- **套用提示**：之后在 DSH 模型目录新增同名模型时会出现套用提示，可恢复上下文窗口、最大输出 tokens、provider 级 reasoning effort，以及该模型行的 `reasoningEfforts`、`input` 和 `compat`。DSH 表单没有 temperature 的专用位置，预设含 temperature 时提示跳过。
- **「设为通用参数」**（`saveDefaults`）与**套用通用参数的入口**（`applyGeneric`）：前者把 provider 级 Reasoning Effort 和 Max Output Tokens 存成兜底通用参数（两者都为空时提示不保存），后者把通用参数套到默认模型（没有默认模型时套到第一行）。

这些入口移除后，历史数据（`AppSettings.modelPresets` 里的 DSH 条目及其 `extraParams.dsh`）如果还留在旧配置里，DSH 表单不再读取也不再写入，也不会主动清理；全局模型预设对其他应用照旧生效。

## 常见检查

- 保存后重新打开 provider，确认模型行的上下文窗口、推理等级和 provider 级生成参数仍在。
- 点开推理等级面板逐行核对：已勾选档位显示真实发送值、`off` 显示「不发送」、未勾选显示 `—`。
- 取消到只剩一个非 `off` 档时，确认该档取消不了并有提示；再点「清除推理等级」确认整行清空（「已开启自适应思考」提示同时消失）。
- 全部取消后检查 JSON，确认没有残留 `reasoningEfforts: {}` 或 `reasoningEfforts: null`；显式 `false` 必须保持 `false`。
- 如果某个模型族的推荐等级不符合上游实际支持范围，优先手动调整各档，并把该模型的 wire 值作为待验证项记录下来。

## 已知限制与待验证事项

- 模型族识别基于模型 ID 规范化和前缀规则，未识别的供应商模型不会显示推荐入口。
- 模型行的 `input`、`compat` 等字段一般只原样透传，表单不提供编辑控件；例外是 `compat.forceAdaptiveThinking`，它会随「推荐预设」和「清除推理等级」被写入或删除。
- 全局模型预设（`AppSettings.modelPresets`）仍是跨应用共用的，但 DSH 已不再参与保存/套用；历史 `extraParams.dsh` 只存在于旧数据中。
- 预设套用时跳过 temperature 的行为只属于 `dsh.1`–`dsh.3`。

## 实测结果（`4.0.14-dsh.3`，历史）

以下为 `dsh.3` 时的实机记录，其中“保存为预设”和“等级胶囊”控件在 `dsh.4` 已不存在，数值仅作历史留档：

- 部署版 GUI 冒烟：在一个已调好参数的 WorkBuddy 线路上点一次“保存为预设”，模型预设数量由 `0` 变成 `7`（该线路 7 个模型一次入库：`deepseek-v4.1-flash`、`glm-5.3-flash`、`hy4-preview`、`kimi-k3-1`、`minimax-m3`、`space-bunny`、`step-5-preview`），随后清回测试前状态。
- 推理等级冒烟：模型行共渲染 50 个等级胶囊（7 档 × 7 行，部分行族受限），点击“高”后该按钮 `aria-pressed` 由 `false` 变 `true`，落盘与插件 `reasoningEfforts` 语义一致。（当时的胶囊控件，`dsh.4` 起换成上一节的下拉多选面板。）
- 前端单测：`DeepSeekHarnessFormFields.reasoningEfforts.test.tsx` 与 `dshReasoningPresetMirror.test.ts` 全绿，`tsc --noEmit` 0 错误。
