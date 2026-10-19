/**
 * DSH 表单的「推理等级（reasoningEfforts）」用例。
 *
 * 期望值全部按 DSH 插件 `dsh-desktop-ui-reasoning-effort@0.1.2` 的
 * `presetFor()` 输出手抄，不反过来用实现算期望：实现改错了这里必须红。
 * 逐键镜像校验（60+ 模型 id）在 `dshReasoningPresetMirror.test.ts`。
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import type { PropsWithChildren } from "react";
import { useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";
import { DeepSeekHarnessFormFields } from "@/components/providers/forms/DeepSeekHarnessFormFields";
import {
  DSH_REASONING_LEVELS,
  formatDshReasoningLevelsLabel,
} from "@/components/providers/forms/helpers/deepseekHarnessFormUtils";
import type {
  DshModel,
  DshReasoningEfforts,
} from "@/components/providers/forms/helpers/deepseekHarnessFormUtils";
import { Form } from "@/components/ui/form";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("@/lib/api/model-fetch", () => ({
  fetchModelsForConfig: vi.fn().mockResolvedValue([]),
  showFetchModelsError: vi.fn(),
}));

const FormShell = ({ children }: PropsWithChildren) => {
  const form = useForm();

  return <Form {...form}>{children}</Form>;
};

// 测试环境 i18n 资源为空：带 defaultValue 的 t() 返回 defaultValue，
// 不带 defaultValue 的 t() 原样返回 key（见 tests/setupTests.ts）。
const CLEAR = "Clear reasoning levels";
const ADAPTIVE = "Adaptive thinking on";
const FORCED_OFF = "Reasoning disabled (false)";

const usePresetLabel = (family: string) => `Use ${family} preset`;
const recommendedLabel = (family: string) => `${family} preset`;

interface HarnessProps {
  initialModels?: DshModel[];
  api?: string;
  initialReasoningEffort?: string;
  initialMaxTokens?: string;
}

/**
 * DSH 的思考等级 / 最大 tokens 是 provider 级字段，上下文窗口与 reasoningEfforts
 * 是行级字段，所以用受控外壳观察套用预设后到底写到了哪里。
 */
function Harness({
  initialModels = [{ id: "gpt-6.1-sol", name: "Sol", rowKey: "r1" }],
  api = "openai-completions",
  initialReasoningEffort = "",
  initialMaxTokens = "",
}: HarnessProps) {
  const [models, setModels] = useState<DshModel[]>(initialModels);
  const [reasoningEffort, setReasoningEffort] = useState(
    initialReasoningEffort,
  );
  const [maxTokens, setMaxTokens] = useState(initialMaxTokens);
  const [defaultModel, setDefaultModel] = useState(initialModels[0]?.id ?? "");

  return (
    <>
      <output data-testid="models">{JSON.stringify(models)}</output>
      <output data-testid="first-row-keys">
        {JSON.stringify(models[0] ? Object.keys(models[0]) : [])}
      </output>
      <FormShell>
        <DeepSeekHarnessFormFields
          isOfficial={false}
          displayName="Custom DSH"
          onDisplayNameChange={vi.fn()}
          reasoningEffort={reasoningEffort}
          onReasoningEffortChange={setReasoningEffort}
          maxTokens={maxTokens}
          onMaxTokensChange={setMaxTokens}
          apiKey="sk-test"
          onApiKeyChange={vi.fn()}
          apiKeyEnv="CUSTOM_DSH_API_KEY"
          onApiKeyEnvChange={vi.fn()}
          baseUrl="https://api.example.com/v1"
          onBaseUrlChange={vi.fn()}
          api={api}
          onApiChange={vi.fn()}
          models={models}
          onModelsChange={setModels}
          defaultModel={defaultModel}
          onDefaultModelChange={setDefaultModel}
          category="custom"
          shouldShowApiKeyLink={false}
          websiteUrl=""
        />
      </FormShell>
    </>
  );
}

function renderHarness(props: HarnessProps = {}) {
  render(<Harness {...props} />);
}

function currentModels(): DshModel[] {
  return JSON.parse(
    screen.getByTestId("models").textContent ?? "[]",
  ) as DshModel[];
}

function currentModel(index = 0): DshModel {
  const models = currentModels();
  const model = models[index];
  if (!model) throw new Error(`model row ${index} does not exist`);
  return model;
}

/** 推理等级触发器的可访问名（面板里等级名用英文原文）。 */
const REASONING_TRIGGER = "Reasoning";

function levelTrigger(rowIndex = 0): HTMLElement {
  const triggers = screen.getAllByRole("button", { name: REASONING_TRIGGER });
  const trigger = triggers[rowIndex];
  if (!trigger) throw new Error(`reasoning trigger ${rowIndex} does not exist`);
  return trigger;
}

/** 打开某一行的等级面板；已打开就别再点（Radix 会把再点当成关闭）。 */
function openLevels(rowIndex = 0): void {
  const trigger = levelTrigger(rowIndex);
  if (trigger.getAttribute("data-state") === "open") return;
  fireEvent.click(trigger);
}

/** 面板里的等级行（Popover 走 Portal，只统计当前打开的那一面）。 */
function levelRows(): HTMLElement[] {
  return screen.getAllByRole("checkbox");
}

function chip(
  level: (typeof DSH_REASONING_LEVELS)[number],
  rowIndex = 0,
): HTMLElement {
  openLevels(rowIndex);
  // 等级名就是英文原文，所以这里顺带把「控件显示英文」这件事钉住。
  return screen.getByRole("checkbox", { name: level });
}

/** 面板里渲染出来的等级名，按顺序（应当就是弱 → 强）。 */
function renderedLevels(rowIndex = 0): string[] {
  openLevels(rowIndex);
  return levelRows().map((row) => row.dataset.level ?? "");
}

/**
 * 每个 case 的期望值 = 插件 `presetFor()` 的输出。
 * - `off: null`：插件 `off` 无 `=wire`，即「不发任何思考参数」。
 * - `off: "none"`：插件写作 `off=none`，真的发 `none`。
 * - `adaptive`：插件第三参传了 `true`（只有 Claude 的自适应档）。
 */
const APPLY_CASES: Array<{
  modelId: string;
  family: string;
  api: string;
  efforts: DshReasoningEfforts;
  adaptive: boolean;
}> = [
  {
    modelId: "claude-haiku-4-5",
    family: "Claude",
    api: "anthropic-messages",
    efforts: { off: null, low: "low", medium: "medium", high: "high" },
    adaptive: false,
  },
  {
    modelId: "claude-sonnet-4-6",
    family: "Claude",
    api: "anthropic-messages",
    efforts: {
      off: null,
      low: "low",
      medium: "medium",
      high: "high",
      max: "max",
    },
    adaptive: true,
  },
  {
    modelId: "claude-opus-4-6",
    family: "Claude",
    api: "anthropic-messages",
    efforts: {
      off: null,
      low: "low",
      medium: "medium",
      high: "high",
      max: "max",
    },
    adaptive: true,
  },
  {
    modelId: "claude-opus-4-7",
    family: "Claude",
    api: "anthropic-messages",
    efforts: {
      off: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
    adaptive: true,
  },
  {
    // 别名 `claude-opus-4.7` 在 normalize 阶段折成 4-7。
    modelId: "claude-opus-4.7",
    family: "Claude",
    api: "anthropic-messages",
    efforts: {
      off: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
    adaptive: true,
  },
  {
    modelId: "claude-opus-5",
    family: "Claude",
    api: "anthropic-messages",
    efforts: {
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
    adaptive: true,
  },
  {
    modelId: "claude-fable-5",
    family: "Claude",
    api: "anthropic-messages",
    efforts: {
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
    adaptive: true,
  },
  {
    modelId: "claude-sonnet-4-5-20250929",
    family: "Claude",
    api: "anthropic-messages",
    efforts: { off: null, low: "low", medium: "medium", high: "high" },
    adaptive: false,
  },
  {
    modelId: "claude-3-7-sonnet",
    family: "Claude",
    api: "anthropic-messages",
    efforts: { off: null, low: "low", medium: "medium", high: "high" },
    adaptive: false,
  },
  {
    modelId: "gpt-5",
    family: "GPT",
    api: "openai-completions",
    efforts: { minimal: "minimal", low: "low", medium: "medium", high: "high" },
    adaptive: false,
  },
  {
    modelId: "gpt-5.1-pro",
    family: "GPT",
    api: "openai-completions",
    efforts: { high: "high" },
    adaptive: false,
  },
  {
    modelId: "gpt-5-codex-spark",
    family: "GPT",
    api: "openai-completions",
    efforts: { low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
    adaptive: false,
  },
  {
    modelId: "gpt-5.2-chat",
    family: "GPT",
    api: "openai-completions",
    efforts: { medium: "medium", xhigh: "xhigh" },
    adaptive: false,
  },
  {
    modelId: "gpt-6.1",
    family: "GPT",
    api: "openai-completions",
    efforts: {
      off: "none",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
    adaptive: false,
  },
  {
    modelId: "openai/gpt-6.1",
    family: "GPT",
    api: "openai-completions",
    efforts: {
      off: "none",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
    adaptive: false,
  },
  {
    modelId: "gpt-6-astra",
    family: "GPT",
    api: "openai-completions",
    efforts: {
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
    adaptive: false,
  },
  {
    modelId: "gpt-oss-120b",
    family: "GPT",
    api: "openai-completions",
    efforts: { low: "low", medium: "medium", high: "high" },
    adaptive: false,
  },
  {
    modelId: "o3",
    family: "OpenAI o",
    api: "openai-completions",
    efforts: { low: "low", medium: "medium", high: "high" },
    adaptive: false,
  },
  {
    modelId: "grok-4.1-fast",
    family: "Grok",
    api: "openai-completions",
    efforts: { low: "low", high: "high" },
    adaptive: false,
  },
  {
    modelId: "grok-4.3",
    family: "Grok",
    api: "openai-completions",
    efforts: { off: "none", low: "low", medium: "medium", high: "high" },
    adaptive: false,
  },
  {
    modelId: "grok-4.6",
    family: "Grok",
    api: "openai-completions",
    efforts: { low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
    adaptive: false,
  },
  {
    modelId: "glm-5.2",
    family: "GLM",
    api: "openai-completions",
    efforts: { off: "none", high: "high", max: "max" },
    adaptive: false,
  },
  {
    modelId: "glm-4.5",
    family: "GLM",
    api: "openai-completions",
    efforts: {
      off: null,
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
    },
    adaptive: false,
  },
  {
    modelId: "mimo-v2.5",
    family: "MiMo",
    api: "openai-completions",
    efforts: {
      off: null,
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
    },
    adaptive: false,
  },
  {
    modelId: "xiaomi-mimo-v2.5",
    family: "MiMo",
    api: "openai-completions",
    efforts: {
      off: null,
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
    },
    adaptive: false,
  },
];

describe("DeepSeekHarnessFormFields 推理等级推荐表", () => {
  it.each(APPLY_CASES)(
    "推荐预设 $modelId 与插件 presetFor 逐键一致",
    ({ modelId, family, api, efforts, adaptive }) => {
      renderHarness({
        initialModels: [{ id: modelId, name: "M", rowKey: "r1" }],
        api,
      });

      // 预设/自适应/清除都在推理面板底部，先展开再点。
      openLevels();
      fireEvent.click(
        screen.getByRole("button", { name: usePresetLabel(family) }),
      );

      const model = currentModel();
      expect(model.reasoningEfforts).toStrictEqual(efforts);
      expect(model.compat).toStrictEqual(
        adaptive ? { forceAdaptiveThinking: true } : undefined,
      );
      expect(screen.queryByText(ADAPTIVE) !== null).toBe(adaptive);
      // 每个等级都已点亮 → 推荐按钮换成静态标签。
      expect(
        screen.queryByRole("button", { name: usePresetLabel(family) }),
      ).toBeNull();
      expect(screen.getByText(recommendedLabel(family))).toBeInTheDocument();
    },
  );

  it.each([
    "my-gateway-model",
    "gpt-4o",
    "claude-haiku-4-0",
    "claude-3-5-sonnet",
    "mimo-v2.0",
    "gpt-5-chat",
  ])("不认识的模型 %s 没有推荐按钮，off 写 null", (modelId) => {
    renderHarness({
      initialModels: [{ id: modelId, name: "M", rowKey: "r1" }],
    });

    openLevels();
    expect(
      screen.queryByRole("button", { name: /^Use .+ preset$/ }),
    ).toBeNull();

    fireEvent.click(chip("off"));
    expect(currentModel().reasoningEfforts).toStrictEqual({ off: null });
    expect(currentModel().compat).toBeUndefined();
  });

  it("非 Anthropic 通道即使推荐表要求自适应也不写 compat", () => {
    renderHarness({
      initialModels: [{ id: "claude-opus-4-7", name: "M", rowKey: "r1" }],
      api: "openai-completions",
    });

    openLevels();
    fireEvent.click(
      screen.getByRole("button", { name: usePresetLabel("Claude") }),
    );

    expect(currentModel().reasoningEfforts).toStrictEqual({
      off: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    });
    expect(currentModel().compat).toBeUndefined();
    expect(screen.queryByText(ADAPTIVE)).toBeNull();
  });

  it("套用非自适应推荐表时清掉上一次留下的 forceAdaptiveThinking", () => {
    renderHarness({
      initialModels: [
        {
          id: "claude-haiku-4-5",
          name: "M",
          rowKey: "r1",
          compat: { forceAdaptiveThinking: true, other: 1 },
        },
      ],
      api: "anthropic-messages",
    });

    openLevels();
    fireEvent.click(
      screen.getByRole("button", { name: usePresetLabel("Claude") }),
    );

    expect(currentModel().compat).toStrictEqual({ other: 1 });
    expect(screen.queryByText(ADAPTIVE)).toBeNull();
  });
});

describe("DeepSeekHarnessFormFields 推理等级面板", () => {
  it("面板里是七行英文等级，顺序从弱到强", () => {
    renderHarness({
      initialModels: [{ id: "gpt-6.1", name: "M", rowKey: "r1" }],
    });

    // 没设置过等级时，触发器显示占位文案。
    expect(levelTrigger().textContent).toContain("Not set");
    expect(levelTrigger()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);

    openLevels();

    expect(levelTrigger()).toHaveAttribute("aria-expanded", "true");
    expect(renderedLevels()).toStrictEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    for (const level of DSH_REASONING_LEVELS) {
      expect(chip(level)).toHaveAttribute("aria-checked", "false");
    }
  });

  it("工具提示里的等级名也是英文原文，没有走 i18n", () => {
    renderHarness({
      initialModels: [{ id: "gpt-6.1", name: "M", rowKey: "r1" }],
    });

    openLevels();
    for (const level of DSH_REASONING_LEVELS) {
      // 空 i18n 下 t() 会回退成 key，所以这里出现英文原文就说明没查表。
      expect(chip(level).textContent).not.toContain("dshReasoning.level_");
      expect(chip(level).textContent).toContain(level);
    }
  });

  it("触发器文案把连续三段以上的等级折叠成 low → max", () => {
    renderHarness({
      initialModels: [
        {
          id: "gpt-6.1-sol",
          name: "M",
          rowKey: "r1",
          reasoningEfforts: {
            low: "low",
            medium: "medium",
            high: "high",
            xhigh: "xhigh",
            max: "max",
          },
        },
      ],
    });

    expect(levelTrigger().textContent).toContain("low → max");
    expect(levelTrigger().textContent).not.toContain("medium");

    openLevels();
    fireEvent.click(chip("medium"));
    expect(levelTrigger().textContent).toContain("low, high → max");
  });

  it("勾选等级后面板不关闭，触发器文案跟着更新", () => {
    renderHarness({
      initialModels: [{ id: "gpt-6.1", name: "M", rowKey: "r1" }],
    });

    openLevels();
    fireEvent.click(chip("low"));
    expect(chip("low")).toHaveAttribute("aria-checked", "true");
    expect(levelTrigger().textContent).toContain("low");

    fireEvent.click(chip("max"));
    expect(chip("max")).toHaveAttribute("aria-checked", "true");
    expect(levelTrigger().textContent).toContain("low, max");
    expect(screen.getAllByRole("checkbox")).toHaveLength(7);
  });

  it("off 在 off=none 的推荐表里写字符串 none", () => {
    renderHarness({
      initialModels: [{ id: "gpt-6.1", name: "M", rowKey: "r1" }],
    });

    fireEvent.click(chip("off"));
    fireEvent.click(chip("medium"));
    fireEvent.click(chip("high"));

    expect(currentModel().reasoningEfforts).toStrictEqual({
      off: "none",
      medium: "medium",
      high: "high",
    });
  });

  it("off 在 Claude 4.5+ 的推荐表里写 null（不发思考参数）", () => {
    renderHarness({
      initialModels: [{ id: "claude-sonnet-4-6", name: "M", rowKey: "r1" }],
      api: "anthropic-messages",
    });

    fireEvent.click(chip("off"));

    expect(currentModel().reasoningEfforts).toStrictEqual({ off: null });
  });

  it("键顺序按弱到强排列，与点击顺序无关", () => {
    renderHarness({
      initialModels: [{ id: "gpt-6.1-sol", name: "M", rowKey: "r1" }],
    });

    fireEvent.click(chip("max"));
    fireEvent.click(chip("low"));

    expect(Object.keys(currentModel().reasoningEfforts ?? {})).toStrictEqual([
      "low",
      "max",
    ]);
    expect(screen.getByTestId("first-row-keys").textContent).toContain(
      "reasoningEfforts",
    );
  });

  it("等级行的标题显示行里真正存的值，而不是推荐表的值", () => {
    renderHarness({
      initialModels: [
        {
          id: "gpt-6.1-sol",
          name: "M",
          rowKey: "r1",
          reasoningEfforts: { off: "low", medium: "medium" },
        },
      ],
    });

    // 推荐表里 gpt-6.1 的 off 是 "none"，但这一行存的是 "low"。
    expect(chip("off")).toHaveAttribute("title", "Sends: low");
    expect(chip("medium")).toHaveAttribute("title", "Sends: medium");
    expect(chip("high")).not.toHaveAttribute("title");
  });

  it("off 存 null 时标题说明「不发思考参数」", () => {
    renderHarness({
      initialModels: [
        {
          id: "gpt-6.1-sol",
          name: "M",
          rowKey: "r1",
          reasoningEfforts: { off: null },
        },
      ],
    });

    expect(chip("off")).toHaveAttribute(
      "title",
      "No reasoning parameter is sent",
    );
  });

  it("最后一个非 off 等级点不掉（与插件 nonOff === 1 的判断一致）", () => {
    renderHarness({
      initialModels: [
        {
          id: "gpt-6.1-sol",
          name: "M",
          rowKey: "r1",
          reasoningEfforts: { low: "low", high: "high" },
        },
      ],
    });

    fireEvent.click(chip("low"));
    expect(currentModel().reasoningEfforts).toStrictEqual({ high: "high" });

    expect(chip("high")).toHaveAttribute("aria-disabled", "true");
    expect(chip("high")).toHaveAttribute("aria-checked", "true");
    // 再点也改不动，但 off 还能勾。
    fireEvent.click(chip("high"));
    expect(currentModel().reasoningEfforts).toStrictEqual({ high: "high" });
    expect(chip("off")).not.toHaveAttribute("aria-disabled");

    fireEvent.click(chip("off"));
    expect(currentModel().reasoningEfforts).toStrictEqual({
      off: "none",
      high: "high",
    });
  });

  it("强制关闭（false）仍然显示文案，并能用清除按钮抹掉", () => {
    renderHarness({
      initialModels: [
        { id: "gpt-6.1-sol", name: "M", rowKey: "r1", reasoningEfforts: false },
      ],
    });

    // 行内只保留一个触发器，禁用状态也在面板底部说明。
    expect(levelTrigger().textContent).toContain("Disabled");
    openLevels();
    expect(screen.getByText(FORCED_OFF)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: CLEAR }));

    expect(currentModel()).toStrictEqual({
      id: "gpt-6.1-sol",
      name: "M",
      rowKey: "r1",
    });
  });

  it("清除按钮删掉整段字段并顺手清掉 forceAdaptiveThinking", () => {
    renderHarness({
      initialModels: [
        {
          id: "gpt-6.1-sol",
          name: "M",
          rowKey: "r1",
          reasoningEfforts: { low: "low" },
          compat: { forceAdaptiveThinking: true, venus: 1 },
        },
      ],
    });

    openLevels();
    fireEvent.click(screen.getByRole("button", { name: CLEAR }));

    const model = currentModel();
    expect("reasoningEfforts" in model).toBe(false);
    expect(model.compat).toStrictEqual({ venus: 1 });
  });
});

describe("formatDshReasoningLevelsLabel 折叠规则", () => {
  it.each([
    // 空表 / 未设置
    [[], ""],
    // 单段不足三级：原样罗列
    [["low"], "low"],
    [["low", "high"], "low, high"],
    [["low", "medium"], "low, medium"],
    // 连续三级才折叠
    [["low", "medium", "high"], "low → high"],
    [["off", "minimal", "low", "medium", "high", "xhigh", "max"], "off → max"],
    // 断档就不折叠：前一段罗列，后一段照旧折叠
    [["low", "high", "xhigh", "max"], "low, high → max"],
    [["off", "max"], "off, max"],
  ])("%j → %j", (levels, expected) => {
    expect(formatDshReasoningLevelsLabel(levels as string[])).toBe(expected);
  });

  it("顺序乱了就退化成逗号罗列（网关自定义等级不该被折叠）", () => {
    expect(formatDshReasoningLevelsLabel(["max", "low"])).toBe("max, low");
    expect(formatDshReasoningLevelsLabel(["low", "venus"])).toBe("low, venus");
    expect(formatDshReasoningLevelsLabel(["venus", "low"])).toBe("venus, low");
  });
});
