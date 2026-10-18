import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ComponentProps, PropsWithChildren } from "react";
import { useForm } from "react-hook-form";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodexFormFields } from "@/components/providers/forms/CodexFormFields";
import { Form } from "@/components/ui/form";
import type { CodexCatalogModel } from "@/types";

// 预设数据直接用固定值喂给表单：这里测的是「表单怎么把预设写进模型列表」，
// 数据获取链路由设置页和 useModelPresets 自己的用例覆盖。
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

// 提交模型名后表单会顺手补元数据（依赖 QueryClient）；预设相关的断言不需要它。
vi.mock("@/hooks/useModelMetadataFill", () => ({
  useModelMetadataFill: () => () => {},
}));

type CodexFormFieldsProps = ComponentProps<typeof CodexFormFields>;

const FormShell = ({ children }: PropsWithChildren) => {
  const form = useForm();

  return <Form {...form}>{children}</Form>;
};

const APPLY_PRESET = "modelPresets.prompt.applyPreset";
const APPLY_GENERIC = "modelPresets.prompt.applyGeneric";
const SKIP = "modelPresets.prompt.skip";

function renderCodexForm(overrides: Partial<CodexFormFieldsProps> = {}) {
  const onCatalogModelsChange = vi.fn();
  const baseProps: CodexFormFieldsProps = {
    codexApiKey: "sk-test",
    onApiKeyChange: vi.fn(),
    category: "third_party",
    shouldShowApiKeyLink: false,
    websiteUrl: "",
    codexBaseUrl: "https://api.example.com",
    onBaseUrlChange: vi.fn(),
    isFullUrl: false,
    onFullUrlChange: vi.fn(),
    isEndpointModalOpen: false,
    onEndpointModalToggle: vi.fn(),
    autoSelect: false,
    onAutoSelectChange: vi.fn(),
    codexModel: "",
    onModelChange: vi.fn(),
    apiFormat: "openai_responses",
    onApiFormatChange: vi.fn(),
    anthropicAuthField: "ANTHROPIC_AUTH_TOKEN",
    onAnthropicAuthFieldChange: vi.fn(),
    impersonateClaudeCode: false,
    onImpersonateClaudeCodeChange: vi.fn(),
    maxOutputTokens: "",
    onMaxOutputTokensChange: vi.fn(),
    promptCacheRouting: "auto",
    onPromptCacheRoutingChange: vi.fn(),
    speedTestEndpoints: [],
    customUserAgent: "",
    onCustomUserAgentChange: vi.fn(),
    localProxyHeadersOverride: "",
    onLocalProxyHeadersOverrideChange: vi.fn(),
    localProxyBodyOverride: "",
    onLocalProxyBodyOverrideChange: vi.fn(),
    shouldShowSpeedTest: false,
    catalogModels: [{ model: "gpt-a" }],
    onCatalogModelsChange,
    ...overrides,
  };

  render(
    <FormShell>
      <CodexFormFields {...baseProps} />
    </FormShell>,
  );

  return { onCatalogModelsChange };
}

/** 「实际请求模型」那一行的输入框（默认值见 codexConfig.catalogColumnModel）。 */
function modelInput() {
  return screen.getByLabelText("实际请求模型");
}

/** 上下文窗口那一行的输入框。 */
function contextWindowInput() {
  return screen.getByLabelText("上下文窗口");
}

/** 手动输入模型名后按回车提交（和用户操作一致，不跟着每次按键问）。 */
function commitModel(value: string) {
  fireEvent.change(modelInput(), { target: { value } });
  fireEvent.keyDown(modelInput(), { key: "Enter" });
}

function lastCatalogRows(
  onCatalogModelsChange: ReturnType<typeof vi.fn>,
): CodexCatalogModel[] {
  const calls = onCatalogModelsChange.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0] as CodexCatalogModel[];
}

describe("CodexFormFields 模型预设", () => {
  beforeEach(() => {
    presetStore.presets = [
      {
        id: "preset-deepseek",
        name: "DeepSeek 通用",
        modelId: "deepseek-v4-*",
        contextWindow: 128000,
        reasoningEffort: "high",
        maxOutputTokens: 8192,
        temperature: 0.3,
      },
    ];
    presetStore.generic = {};
  });

  it("提交命中的模型 id 后弹询问框，套用后写入能表达的参数", async () => {
    const { onCatalogModelsChange } = renderCodexForm();

    commitModel("deepseek-v4-pro");

    const dialog = await screen.findByRole("dialog");
    // 弹窗里列出预设参数，让人看清要套什么。
    expect(within(dialog).getByText(/128000/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: APPLY_PRESET }));

    await waitFor(() => {
      expect(contextWindowInput()).toHaveValue(128000);
    });

    const rows = lastCatalogRows(onCatalogModelsChange);
    expect(rows[0]).toMatchObject({
      model: "deepseek-v4-pro",
      contextWindow: "128000",
      defaultReasoningLevel: "high",
      reasoningLevels: ["high"],
    });

    // 温度这类目录行表达不了的参数不硬塞，弹窗关掉即可。
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("跳过时一行都不改", async () => {
    const { onCatalogModelsChange } = renderCodexForm();

    commitModel("deepseek-v4-pro");

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: SKIP }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    expect(contextWindowInput()).toHaveValue(null);
    const rows = lastCatalogRows(onCatalogModelsChange);
    expect(rows[0].model).toBe("deepseek-v4-pro");
    // 目录行的空字段会被规范成 ""，跳过时也不能被写成预设里的值。
    expect(rows[0].contextWindow ?? "").toBe("");
    expect(rows[0].defaultReasoningLevel).toBeUndefined();
    expect(rows[0].reasoningLevels).toBeUndefined();
  });

  it("同一个模型 id 只问一次", async () => {
    renderCodexForm();

    commitModel("deepseek-v4-pro");
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: SKIP,
      }),
    );
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    // 再次失焦 / 回车不再重复打扰。
    fireEvent.blur(modelInput());
    fireEvent.keyDown(modelInput(), { key: "Enter" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(contextWindowInput()).toHaveValue(null);
  });

  it("通用的「套用通用参数」按钮直接写进默认行", async () => {
    presetStore.presets = [];
    presetStore.generic = { contextWindow: 64000, temperature: 0.2 };
    const { onCatalogModelsChange } = renderCodexForm();

    fireEvent.click(screen.getByRole("button", { name: APPLY_GENERIC }));

    await waitFor(() => {
      expect(contextWindowInput()).toHaveValue(64000);
    });
    const rows = lastCatalogRows(onCatalogModelsChange);
    expect(rows[0]).toMatchObject({ model: "gpt-a", contextWindow: "64000" });
    expect(rows[0].defaultReasoningLevel).toBeUndefined();
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
    renderCodexForm();

    commitModel("gpt-a");

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(contextWindowInput()).toHaveValue(null);
  });
});
