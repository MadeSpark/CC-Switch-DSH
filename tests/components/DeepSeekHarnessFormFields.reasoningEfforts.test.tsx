/**
 * DSH 表单的「推理等级（reasoningEfforts）」+ 「模型预设」联动用例。
 *
 * 期望值全部按 DSH 插件 `dsh-desktop-ui-reasoning-effort@0.1.2` 的
 * `presetFor()` 输出手抄，不反过来用实现算期望：实现改错了这里必须红。
 * 逐键镜像校验（60+ 模型 id）在 `dshReasoningPresetMirror.test.ts`。
 */
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import type { PropsWithChildren } from "react";
import { useForm } from "react-hook-form";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DeepSeekHarnessFormFields } from "@/components/providers/forms/DeepSeekHarnessFormFields";
import {
  buildDshPresetExtras,
  DSH_REASONING_LEVELS,
} from "@/components/providers/forms/helpers/deepseekHarnessFormUtils";
import type {
  DshModel,
  DshPresetExtras,
  DshReasoningEfforts,
} from "@/components/providers/forms/helpers/deepseekHarnessFormUtils";
import { Form } from "@/components/ui/form";
import type { ModelPreset } from "@/lib/modelPresets";

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

// 预设列表直接注入：这里只验证表单怎么消费预设，数据链路归 useModelPresets 自己的用例。
// `isLoading` 做成可变的，用来验证「预设未加载完不允许保存」。
const presetStore = vi.hoisted(() => ({
  presets: [] as ModelPreset[],
  generic: {} as Record<string, unknown>,
  isLoading: false,
  save: vi.fn(),
}));

vi.mock("@/hooks/useModelPresets", () => ({
  modelPresetQueryKey: ["model-presets"],
  useModelPresets: () => ({
    data: { presets: presetStore.presets, generic: presetStore.generic },
    presets: presetStore.presets,
    generic: presetStore.generic,
    isLoading: presetStore.isLoading,
    isError: false,
    isSaving: false,
    save: presetStore.save,
    refetch: vi.fn(),
  }),
}));

const FormShell = ({ children }: PropsWithChildren) => {
  const form = useForm();

  return <Form {...form}>{children}</Form>;
};

// 测试环境 i18n 资源为空：带 defaultValue 的 t() 返回 defaultValue，
// 不带 defaultValue 的 t() 原样返回 key（见 tests/setupTests.ts）。
const SAVE_AS_PRESET = "Save as preset";
const SAVE_AS_DEFAULTS = "Save as defaults";
const CLEAR = "Clear reasoning levels";
const ADAPTIVE = "Adaptive thinking on";
const FORCED_OFF = "Reasoning disabled (false)";
const APPLY_PRESET = "modelPresets.prompt.applyPreset";
const APPLY_GENERIC = "modelPresets.prompt.applyGeneric";
const SKIP = "modelPresets.prompt.skip";

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

function modelIdInputs() {
  return screen.getAllByPlaceholderText("Model ID");
}

/**
 * 某个行内的等级胶囊：从该行的 Model ID 输入框往上找最近一个含胶囊的容器，
 * 这样多行时不会串到别的行去。
 */
function levelChips(rowIndex = 0): HTMLElement[] {
  const input = modelIdInputs()[rowIndex];
  if (!input) throw new Error(`model row ${rowIndex} does not exist`);
  let node: HTMLElement | null = input.parentElement;
  while (node && node.querySelectorAll("button[aria-pressed]").length === 0) {
    node = node.parentElement;
  }
  if (!node || node === document.body) {
    throw new Error(`reasoning chips for row ${rowIndex} do not exist`);
  }
  return Array.from(node.querySelectorAll<HTMLElement>("button[aria-pressed]"));
}

function chip(
  level: (typeof DSH_REASONING_LEVELS)[number],
  rowIndex = 0,
): HTMLElement {
  const index = DSH_REASONING_LEVELS.indexOf(level);
  const found = levelChips(rowIndex)[index];
  if (!found) throw new Error(`chip ${level} does not exist`);
  return found;
}

function reasoningEffortInput() {
  return screen.getByLabelText("deepseekHarness.reasoningEffort");
}

function maxTokensInput() {
  return screen.getByLabelText("deepseekHarness.maxTokens");
}

function savedPayload(): {
  presets: ModelPreset[];
  generic: Record<string, unknown>;
} {
  const calls = presetStore.save.mock.calls;
  const last = calls[calls.length - 1];
  if (!last) throw new Error("save was not called");
  return last[0] as {
    presets: ModelPreset[];
    generic: Record<string, unknown>;
  };
}

/** 点「添加」造一行新的空模型，再填 id 用回车提交（提交会触发预设询问）。 */
function addAndCommitModel(modelId: string) {
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  const inputs = modelIdInputs();
  const input = inputs[inputs.length - 1];
  if (!input) throw new Error("model id input does not exist");
  fireEvent.change(input, { target: { value: modelId } });
  fireEvent.keyDown(input, { key: "Enter" });
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

beforeEach(() => {
  presetStore.presets = [];
  presetStore.generic = {};
  presetStore.isLoading = false;
  presetStore.save.mockReset();
  presetStore.save.mockResolvedValue(undefined);
});

describe("DeepSeekHarnessFormFields 推理等级推荐表", () => {
  it.each(APPLY_CASES)(
    "推荐预设 $modelId 与插件 presetFor 逐键一致",
    ({ modelId, family, api, efforts, adaptive }) => {
      renderHarness({
        initialModels: [{ id: modelId, name: "M", rowKey: "r1" }],
        api,
      });

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

    fireEvent.click(
      screen.getByRole("button", { name: usePresetLabel("Claude") }),
    );

    expect(currentModel().compat).toStrictEqual({ other: 1 });
    expect(screen.queryByText(ADAPTIVE)).toBeNull();
  });
});

describe("DeepSeekHarnessFormFields 推理等级胶囊", () => {
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

  it("胶囊标题显示行里真正存的值，而不是推荐表的值", () => {
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
      "No reasoning parameter is sent for this level.",
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

    expect(chip("high")).toBeDisabled();
    expect(chip("off")).not.toBeDisabled();
  });

  it("强制关闭（false）仍然显示文案，并能用清除按钮抹掉", () => {
    renderHarness({
      initialModels: [
        { id: "gpt-6.1-sol", name: "M", rowKey: "r1", reasoningEfforts: false },
      ],
    });

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

    fireEvent.click(screen.getByRole("button", { name: CLEAR }));

    const model = currentModel();
    expect("reasoningEfforts" in model).toBe(false);
    expect(model.compat).toStrictEqual({ venus: 1 });
  });
});

describe("DeepSeekHarnessFormFields 保存模型预设", () => {
  it("新模型保存成预设时把行级参数收进 extraParams.dsh", async () => {
    renderHarness({
      initialModels: [
        {
          id: "gpt-6.1-sol",
          name: "Sol",
          rowKey: "r1",
          contextWindow: 400000,
          reasoningEfforts: { low: "low", high: "high" },
        },
      ],
      initialReasoningEffort: "high",
      initialMaxTokens: "32000",
    });

    fireEvent.click(screen.getByRole("button", { name: SAVE_AS_PRESET }));

    await waitFor(() => expect(presetStore.save).toHaveBeenCalled());
    const { presets } = savedPayload();
    expect(presets).toHaveLength(1);
    expect(presets[0]).toMatchObject({
      name: "Sol",
      modelId: "gpt-6.1-sol",
      contextWindow: 400000,
      reasoningEffort: "high",
      maxOutputTokens: 32000,
      extraParams: {
        dsh: { reasoningEfforts: { low: "low", high: "high" } },
      },
    });
  });

  it("同 modelId 的预设是合并而不是整条覆盖", async () => {
    presetStore.presets = [
      {
        id: "preset-sol",
        name: "我自己的叫法",
        modelId: "gpt-6.1-sol",
        temperature: 0.3,
        contextWindow: 64000,
        extraParams: {
          dsh: { reasoningEfforts: { low: "low" } },
          venus: { a: 1 },
        },
      },
    ];
    renderHarness({
      initialModels: [
        {
          id: "gpt-6.1-sol",
          name: "Sol",
          rowKey: "r1",
          contextWindow: 200000,
          reasoningEfforts: { high: "high" },
        },
      ],
      initialReasoningEffort: "high",
    });

    fireEvent.click(screen.getByRole("button", { name: SAVE_AS_PRESET }));

    await waitFor(() => expect(presetStore.save).toHaveBeenCalled());
    const [preset] = savedPayload().presets;
    expect(preset).toStrictEqual({
      id: "preset-sol",
      // 用户改过的名字 / id / modelId 保留原样。
      name: "我自己的叫法",
      modelId: "gpt-6.1-sol",
      // 表单装不下的字段留在预设里。
      temperature: 0.3,
      // 表单能装的字段以当前行为准。
      contextWindow: 200000,
      reasoningEffort: "high",
      extraParams: {
        dsh: { reasoningEfforts: { high: "high" } },
        venus: { a: 1 },
      },
    });
  });

  it("当前行没有行级参数时删掉预设里的 dsh 命名空间（不留旧等级）", async () => {
    presetStore.presets = [
      {
        id: "preset-sol",
        name: "Sol",
        modelId: "gpt-6.1-sol",
        extraParams: {
          dsh: { reasoningEfforts: { low: "low" } },
          venus: { a: 1 },
        },
      },
    ];
    renderHarness({
      initialModels: [{ id: "gpt-6.1-sol", name: "Sol", rowKey: "r1" }],
    });

    fireEvent.click(screen.getByRole("button", { name: SAVE_AS_PRESET }));

    await waitFor(() => expect(presetStore.save).toHaveBeenCalled());
    expect(savedPayload().presets[0]).toStrictEqual({
      id: "preset-sol",
      name: "Sol",
      modelId: "gpt-6.1-sol",
      extraParams: { venus: { a: 1 } },
    });
  });

  it("只剩 dsh 命名空间且没东西可存时整条 extraParams 都删掉", async () => {
    presetStore.presets = [
      {
        id: "preset-sol",
        name: "Sol",
        modelId: "gpt-6.1-sol",
        extraParams: { dsh: { reasoningEfforts: { low: "low" } } },
      },
    ];
    renderHarness({
      initialModels: [{ id: "gpt-6.1-sol", name: "Sol", rowKey: "r1" }],
    });

    fireEvent.click(screen.getByRole("button", { name: SAVE_AS_PRESET }));

    await waitFor(() => expect(presetStore.save).toHaveBeenCalled());
    const preset = savedPayload().presets[0];
    expect(preset && "extraParams" in preset).toBe(false);
  });

  it("预设还没加载完时两个保存按钮都禁用，点了也不写盘", async () => {
    presetStore.isLoading = true;
    renderHarness({
      initialModels: [{ id: "gpt-6.1-sol", name: "Sol", rowKey: "r1" }],
      initialReasoningEffort: "high",
    });

    const savePreset = screen.getByRole("button", { name: SAVE_AS_PRESET });
    const saveDefaults = screen.getByRole("button", { name: SAVE_AS_DEFAULTS });
    expect(savePreset).toBeDisabled();
    expect(saveDefaults).toBeDisabled();

    fireEvent.click(savePreset);
    fireEvent.click(saveDefaults);
    // 直接调 handler 也走不进去：早退分支在副作用之前。
    await waitFor(() => expect(presetStore.save).not.toHaveBeenCalled());
  });

  it("保存通用参数时合并已有 generic，不动别的字段", async () => {
    presetStore.generic = { contextWindow: 128000 };
    renderHarness({
      initialModels: [{ id: "gpt-6.1-sol", name: "Sol", rowKey: "r1" }],
      initialReasoningEffort: "high",
      initialMaxTokens: "16000",
    });

    fireEvent.click(screen.getByRole("button", { name: SAVE_AS_DEFAULTS }));

    await waitFor(() => expect(presetStore.save).toHaveBeenCalled());
    expect(savedPayload().generic).toStrictEqual({
      contextWindow: 128000,
      reasoningEffort: "high",
      maxOutputTokens: 16000,
    });
  });
});

describe("DeepSeekHarnessFormFields 预设询问框", () => {
  it("新增模型命中预设后套用，行级 + provider 级字段都落到正确层级", async () => {
    presetStore.presets = [
      {
        id: "preset-sol",
        name: "Sol",
        modelId: "gpt-6.1-sol",
        contextWindow: 400000,
        reasoningEffort: "high",
        maxOutputTokens: 32000,
        extraParams: {
          dsh: { reasoningEfforts: { low: "low", medium: "medium" } },
        },
      },
    ];
    renderHarness({ initialModels: [] });

    addAndCommitModel("gpt-6.1-sol");

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: APPLY_PRESET }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(currentModel()).toMatchObject({
      id: "gpt-6.1-sol",
      contextWindow: 400000,
      reasoningEfforts: { low: "low", medium: "medium" },
    });
    expect(reasoningEffortInput()).toHaveValue("high");
    expect(maxTokensInput()).toHaveValue(32000);
  });

  it("行被删掉后点套用不崩：provider 级参数照落，行级参数跳过", async () => {
    presetStore.presets = [
      {
        id: "preset-sol",
        name: "Sol",
        modelId: "gpt-6.1-sol",
        reasoningEffort: "high",
        maxOutputTokens: 32000,
        extraParams: {
          dsh: { reasoningEfforts: { low: "low" } },
        },
      },
    ];
    renderHarness({ initialModels: [] });

    addAndCommitModel("gpt-6.1-sol");
    const dialog = await screen.findByRole("dialog");

    // 询问框开着时行内容被 aria-hidden，getByRole 找不到删除按钮，直接查 DOM。
    const remove = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove"]',
    );
    if (!remove) throw new Error("remove button does not exist");
    fireEvent.click(remove);
    expect(currentModels()).toStrictEqual([]);

    fireEvent.click(within(dialog).getByRole("button", { name: APPLY_PRESET }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // 没有复活出一行幽灵数据，provider 级参数仍然写进去了。
    expect(currentModels()).toStrictEqual([]);
    expect(reasoningEffortInput()).toHaveValue("high");
    expect(maxTokensInput()).toHaveValue(32000);
  });

  it("跳过时一行都不改", async () => {
    presetStore.presets = [
      {
        id: "preset-sol",
        name: "Sol",
        modelId: "gpt-6.1-sol",
        contextWindow: 400000,
        reasoningEffort: "high",
      },
    ];
    renderHarness({ initialModels: [] });

    addAndCommitModel("gpt-6.1-sol");
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: SKIP,
      }),
    );

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const model = currentModel();
    expect(model.id).toBe("gpt-6.1-sol");
    // 没有多写任何字段（跳过时只留下 id 和内部 rowKey，空 name 被剪掉）。
    expect(Object.keys(model).sort()).toStrictEqual(["id", "rowKey"]);
    expect(reasoningEffortInput()).toHaveValue("");
  });

  it("同一个模型 id 只问一次", async () => {
    presetStore.presets = [
      {
        id: "preset-sol",
        name: "Sol",
        modelId: "gpt-6.1-sol",
        contextWindow: 400000,
      },
    ];
    renderHarness({ initialModels: [{ id: "", name: "", rowKey: "r1" }] });

    addAndCommitModel("gpt-6.1-sol");
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: SKIP,
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const inputs = modelIdInputs();
    const input = inputs[inputs.length - 1];
    if (!input) throw new Error("model id input does not exist");
    fireEvent.blur(input);
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("通用的「套用通用参数」按钮直接写进默认模型行", async () => {
    presetStore.generic = { contextWindow: 64000, maxOutputTokens: 32000 };
    renderHarness({
      initialModels: [{ id: "gpt-6.1-sol", name: "Sol", rowKey: "r1" }],
    });

    fireEvent.click(screen.getByRole("button", { name: APPLY_GENERIC }));

    await waitFor(() => expect(currentModel().contextWindow).toBe(64000));
    expect(maxTokensInput()).toHaveValue(32000);
  });
});

describe("buildDshPresetExtras 深拷贝", () => {
  it("拷进预设的 input / compat 与模型行不共享引用", () => {
    const row: DshModel = {
      id: "gpt-6.1-sol",
      input: [{ type: "text" }],
      compat: { nested: { on: true } },
    };

    const extras = buildDshPresetExtras(row) as DshPresetExtras | undefined;
    expect(extras).not.toBeUndefined();
    expect(extras?.input).not.toBe(row.input);
    expect(extras?.compat).not.toBe(row.compat);
    expect(extras?.compat?.nested).not.toBe(row.compat?.nested);
    expect(extras?.input).toStrictEqual([{ type: "text" }]);
    expect(extras?.compat).toStrictEqual({ nested: { on: true } });
  });
});
