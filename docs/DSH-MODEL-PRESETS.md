# DSH 模型预设与推理等级

DSH 模型设置区提供两类保存操作：把当前模型目录保存到 `AppSettings.modelPresets`，以及把当前生成参数保存为通用参数。模型行还可以单独配置 reasoning effort，并按模型族套用推荐等级。

## 一键保存模型预设

1. 打开 DSH provider 的编辑页，进入“Model Catalog”（中文界面为“模型目录”）。
2. 为模型行填写 Model ID、Display Name 和 Context Window；必要时先用“取得模型列表”选取模型。
3. 在每个模型行下方的“推理等级”区域，点击需要启用的等级胶囊。当前等级从弱到强为：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。中文文案分别是“关闭、最小、低、中、高、极高、最大”。
4. 点击模型目录右侧的 **“保存为预设”**。该按钮的提示文案是“把目录里的每个模型（含推理等级）保存成模型预设，之后添加同名模型时会询问是否套用”。
5. 保存成功后，已有同名模型预设会更新；没有同名预设的模型会新建一条。模型 ID 比较不区分大小写，预设名称优先使用模型行的 Display Name。

保存内容包括模型的 `contextWindow`、provider 级 `reasoningEffort`、provider 级最大输出 tokens，以及 DSH 行级参数。行级参数放在 `extraParams.dsh` 命名空间中，以避免影响其他应用共用的模型预设。

以后在 DSH 模型目录中新增同名模型时，若命中模型预设，会出现套用提示。套用时可以恢复上下文窗口、最大输出 tokens、provider 级 reasoning effort，以及该模型行的 `reasoningEfforts`、`input` 和 `compat`。DSH 表单没有 temperature 的专用位置，若预设包含 temperature，会提示该参数被跳过。

## 保存为通用参数

1. 在模型目录上方的生成参数区填写 Reasoning Effort；需要限制输出时填写 Max Output Tokens。
2. 点击 **“设为通用参数”**。中文提示为“把上面的思考等级和最大 Tokens 存成通用参数”，旁边说明为“新增模型时会用到”。
3. 该操作只合并保存当前 Reasoning Effort 和 Max Output Tokens，不清空设置页中已经存在的其他通用预设字段。
4. 新增模型时，如果没有命中特定模型预设，可以在模型目录右侧使用通用参数操作，将通用参数套到默认模型（没有默认模型时套到第一行）。

如果 Reasoning Effort 和 Max Output Tokens 都为空，界面会提示“思考等级和最大 Tokens 都是空的，没有可保存的参数”，不会保存空预设。

## 配置模型级推理等级

每个模型行都有“推理等级”区域和七个等级按钮。点击按钮会切换该等级：第一次点击写入等级，第二次点击移除等级；全部移除后，整个 `reasoningEfforts` 字段会被省略，而不是保存空对象。点击“清除推理等级”会一次清除该模型行的所有等级。

模型 ID 能识别模型族时，界面会显示 **“推荐预设 · {{family}}”** 操作或 **“{{family}} 预设”** 状态。当前识别的模型族包括 GPT、OpenAI o、Claude、Grok、GLM 和 MiMo。Claude 的推荐预设还可能同时开启自适应思考。未识别的模型仍可手动逐档设置。

每个等级的按钮提示会显示实际 wire 值，例如“发送值：`low`”；如果该等级不发送 reasoning 参数，会显示“不发送思考参数”。推荐表会把 `off` 映射为 `none` 或 `null` 等协议值，具体以模型族和当前推荐表为准；没有推荐值时，除 `off` 外的等级默认发送同名值。

配置落盘在：

```text
providers.<providerId>.models[].reasoningEfforts
```

字段值是一张等级到 wire 值的映射，wire 值可以是字符串或 `null`；特殊值 `false` 表示强制关闭思考。该格式与 `dsh-desktop-ui-reasoning-effort` 插件保持兼容。界面使用的真实文案来自 `src/i18n/locales/zh.json`，英文、日文、土耳其文和繁体中文对应 locale 文件也保留相同的控件语义。

## 常见检查

- 保存后重新打开 provider，确认模型行的 Context Window、推理等级和生成参数仍在。
- 新增一个已保存过的模型 ID，确认出现套用提示；选择套用后检查对应行，而不是只检查 provider 级字段。
- 点击“清除推理等级”后检查 JSON，确认没有残留 `reasoningEfforts: {}` 或 `reasoningEfforts: null`。
- 如果某个模型族的推荐等级不符合上游实际支持范围，优先手动调整各等级，并把该模型的 wire 值作为待验证项记录下来。

## 已知限制与待验证事项

- 预设使用 `AppSettings.modelPresets`，不同应用共用预设存储；DSH 行级扩展位于 `extraParams.dsh`，其他应用是否完整保留未知扩展字段取决于其自身编辑器。
- 模型族识别基于模型 ID 规范化和前缀规则，未识别的供应商模型不会显示推荐按钮。
- “通用参数”当前保存的是 provider 级 Reasoning Effort 和 Max Output Tokens；行级 reasoning 等级仍需在模型行单独设置或通过“保存为预设”写入。
- 预设套用时，DSH 没有 temperature 专用控件，因此 temperature 会被提示跳过。

## 实测结果（`4.0.14-dsh.3`）

- 部署版 GUI 冒烟：在一个已调好参数的 WorkBuddy 线路上点一次“保存为预设”，模型预设数量由 `0` 变成 `7`（该线路 7 个模型一次入库：`deepseek-v4.1-flash`、`glm-5.3-flash`、`hy4-preview`、`kimi-k3-1`、`minimax-m3`、`space-bunny`、`step-5-preview`），随后清回测试前状态。
- 推理等级冒烟：模型行共渲染 50 个等级胶囊（7 档 × 7 行，部分行族受限），点击“高”后该按钮 `aria-pressed` 由 `false` 变 `true`，落盘与插件 `reasoningEfforts` 语义一致。
- 前端单测：`DeepSeekHarnessFormFields.reasoningEfforts.test.tsx` 与 `dshReasoningPresetMirror.test.ts` 全绿，`tsc --noEmit` 0 错误。

