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
import type { DshModel } from "@/components/providers/forms/helpers/deepseekHarnessFormUtils";
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

// 预设数据用固定值喂给表单：这里只验证「表单怎么把预设写进行级 / provider 级字段」，
// 数据获取链路由设置页与 useModelPresets 自己的用例覆盖。
const presetStore = vi.hoisted(() => ({
  presets: [] as Array<Record<string, unknown>>,
  generic: {} as Record<string, unknown>,
}));

vi.mock("@/hooks/useModelPresets", () => ({
  modelPresetQueryKey: ["model-presets"],
  useModelPresets: () => ({
    data: { presets: presetStore.presets, generic: presetStore.generic },
    presets: presetStore.presets,
    generic: presetStore.generic,
    isLoading: false,
    isError: false,
    isSaving: false,
    save: vi.fn(),
    refetch: vi.fn(),
  }),
}));

const FormShell = ({ children }: PropsWithChildren) => {
  const form = useForm();

  return <Form {...form}>{children}</Form>;
};

const APPLY_PRESET = "modelPresets.prompt.applyPreset";
const APPLY_GENERIC = "modelPresets.prompt.applyGeneric";
const SKIP = "modelPresets.prompt.skip";

const INITIAL_MODELS: DshModel[] = [
  { id: "deepseek-v4-flash", name: "Flash", rowKey: "row-1" },
];

/**
 * DSH 的思考等级 / 最大 tokens 是 provider 级字段，上下文窗口是行级字段，
 * 所以用受控外壳观察套用后到底写到了哪里。
 */
function Harness() {
  const [models, setModels] = useState<DshModel[]>(INITIAL_MODELS);
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [defaultModel, setDefaultModel] = useState("deepseek-v4-flash");

  return (
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
        api="openai-completions"
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
  );
}

function renderHarness() {
  render(<Harness />);
}

/** 模型 ID 输入框（placeholder 见 deepseekHarness.modelId 的 defaultValue）。 */
function modelIdInputs() {
  return screen.getAllByPlaceholderText("Model ID");
}

/** 上下文窗口输入框，按行顺序。 */
function contextWindowInputs() {
  return screen.getAllByLabelText("Context Window");
}

function reasoningEffortInput() {
  return screen.getByLabelText("deepseekHarness.reasoningEffort");
}

function maxTokensInput() {
  return screen.getByLabelText("deepseekHarness.maxTokens");
}

/** 点“添加”造一行新的空模型，再填入模型 id 并回车提交。 */
function addAndCommitModel(modelId: string) {
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  const inputs = modelIdInputs();
  const input = inputs[inputs.length - 1];
  fireEvent.change(input, { target: { value: modelId } });
  fireEvent.keyDown(input, { key: "Enter" });
}

describe("DeepSeekHarnessFormFields 模型预设", () => {
  beforeEach(() => {
    presetStore.presets = [
      {
        id: "preset-deepseek",
        name: "DeepSeek 通用",
        modelId: "deepseek-v4-*",
        contextWindow: 128000,
        reasoningEffort: "high",
        maxOutputTokens: 64000,
        temperature: 0.3,
      },
    ];
    presetStore.generic = {};
  });

  it("新增模型命中预设后弹询问框，套用后写入行级和 provider 级字段", async () => {
    renderHarness();

    addAndCommitModel("deepseek-v4-pro");

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/128000/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: APPLY_PRESET }));

    await waitFor(() => {
      expect(contextWindowInputs()[1]).toHaveValue(128000);
    });
    // 思考等级 / 最大 tokens 落到 provider 级字段。
    expect(reasoningEffortInput()).toHaveValue("high");
    expect(maxTokensInput()).toHaveValue(64000);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("跳过时一行都不改", async () => {
    renderHarness();

    addAndCommitModel("deepseek-v4-pro");

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: SKIP }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    expect(contextWindowInputs()[1]).toHaveValue(null);
    expect(reasoningEffortInput()).toHaveValue("");
    expect(maxTokensInput()).toHaveValue(null);
  });

  it("同一个模型 id 只问一次", async () => {
    renderHarness();

    addAndCommitModel("deepseek-v4-pro");
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: SKIP,
      }),
    );
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    const inputs = modelIdInputs();
    const input = inputs[inputs.length - 1];
    fireEvent.blur(input);
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("通用的「套用通用参数」按钮直接写进默认模型行", async () => {
    presetStore.presets = [];
    presetStore.generic = { contextWindow: 64000, maxOutputTokens: 32000 };
    renderHarness();

    fireEvent.click(screen.getByRole("button", { name: APPLY_GENERIC }));

    await waitFor(() => {
      expect(contextWindowInputs()[0]).toHaveValue(64000);
    });
    expect(maxTokensInput()).toHaveValue(32000);
  });

  it("没命中预设时什么都不弹", async () => {
    presetStore.presets = [
      {
        id: "preset-other",
        name: "别的模型",
        modelId: "other-*",
        contextWindow: 64000,
      },
    ];
    renderHarness();

    addAndCommitModel("deepseek-v4-pro");

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(contextWindowInputs()[1]).toHaveValue(null);
  });
});
