import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "i18next";
import { toast } from "sonner";
import {
  ProviderForm,
  type ProviderFormValues,
} from "@/components/providers/forms/ProviderForm";
import { createTestQueryClient } from "../utils/testQueryClient";

// 测试环境的 i18n 资源是空的（tests/setupTests.ts），`t()` 会原样返回 key，
// 拦不住「模型名没拼进提示」这种错误。这里只补本用例要断言的几个键。
const ZH_RESOURCES = {
  deepseekHarness: {
    reasoningInvalid: "无法保存：模型「{{model}}」的推理等级无效（{{reason}}）。",
    reasoningEffortRemoved:
      "已移除旧版供应商级「思考等级」（reasoningEffort）：DSH 原生 pi-ai 路由没有这个字段，思考档位请在模型行里按模型声明。",
    unnamedModel: "未命名模型",
  },
  dshReasoning: {
    needsLevel: "至少添加一个 Off 以外的档位；不需要思考请关闭推理等级。",
    valueRequired: "档位「{{level}}」的 API 参数值不能为空。",
    unknownLevel: "档位「{{level}}」不是 DSH 支持的推理等级。",
  },
};

beforeAll(() => {
  i18n.addResourceBundle("zh", "translation", ZH_RESOURCES, true, true);
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/api/model-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/model-fetch")>();
  return {
    ...actual,
    fetchModelsForConfig: vi.fn().mockResolvedValue([]),
    showFetchModelsError: vi.fn(),
  };
});

vi.mock("@/lib/query/dsh", () => ({
  useDshCurrentState: () => ({
    data: {
      providerIds: [],
      currentProviderId: null,
      currentModel: null,
    },
    isLoading: false,
  }),
  invalidateDshProviderCaches: vi.fn(),
  dshKeys: { all: ["dsh"], currentState: ["dsh", "currentState"] },
}));

// CodeMirror is heavyweight in jsdom; expose it as a plain textarea instead.
vi.mock("@/components/JsonEditor", () => ({
  default: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
  }) => (
    <textarea
      aria-label="dsh-settings-config"
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

const BASE_CONFIG = {
  displayName: "Company Gateway",
  api: "openai-completions",
  baseURL: "https://gateway.example/v1",
  apiKeyEnv: "COMPANY_API_KEY",
  apiKey: "secret",
  maxTokens: 32000,
};

type InitialData = Parameters<typeof ProviderForm>[0]["initialData"];

function renderEditForm(
  onSubmit: (values: ProviderFormValues) => void,
  settingsConfig: Record<string, unknown>,
) {
  const initialData: InitialData = {
    name: "Company Gateway",
    category: "custom",
    settingsConfig,
    meta: { providerType: "dsh_pi_ai", dshCurrentModel: "glm-5.3" },
  };
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ProviderForm
        appId="deepseek-harness"
        providerId="company-gateway"
        submitLabel="Save"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        initialData={initialData}
      />
    </QueryClientProvider>,
  );
}

function clickSave() {
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
}

function renderOfficialEditForm(
  onSubmit: (values: ProviderFormValues) => void,
  settingsConfig: Record<string, unknown>,
) {
  const initialData: InitialData = {
    name: "DeepSeek",
    category: "official",
    settingsConfig,
    meta: { providerType: "dsh_deepseek" },
  };
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ProviderForm
        appId="deepseek-harness"
        providerId="deepseek-official"
        submitLabel="Save"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        initialData={initialData}
      />
    </QueryClientProvider>,
  );
}

describe("DSH model-level reasoningEfforts hard validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("blocks saving when reasoningEfforts is an empty object", async () => {
    const onSubmit = vi.fn();
    renderEditForm(onSubmit, {
      ...BASE_CONFIG,
      models: [{ id: "glm-5.3", reasoningEfforts: {} }],
    });

    clickSave();

    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1));
    const message = vi.mocked(toast.error).mock.calls[0][0] as string;
    expect(message).toContain("glm-5.3");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps invalid raw values after editing another model column, so Save still blocks", async () => {
    const onSubmit = vi.fn();
    renderEditForm(onSubmit, {
      ...BASE_CONFIG,
      models: [
        { id: "glm-5.3", reasoningEfforts: { low: 3, high: "high" } },
      ],
    });

    // 改「上下文窗口」会触发整张模型表回写；坏值必须在回写中存活，
    // 否则会被静默修好、绕过「必须显式修复才能保存」的策略。
    fireEvent.change(screen.getByLabelText("Context Window"), {
      target: { value: "64000" },
    });
    clickSave();

    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1));
    const message = vi.mocked(toast.error).mock.calls[0][0] as string;
    expect(message).toContain("glm-5.3");
    expect(message).toContain("low");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("blocks saving when reasoningEfforts uses a level outside the native schema", async () => {
    const onSubmit = vi.fn();
    renderEditForm(onSubmit, {
      ...BASE_CONFIG,
      models: [{ id: "glm-5.3", reasoningEfforts: { venus: "venus" } }],
    });

    clickSave();

    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1));
    const message = vi.mocked(toast.error).mock.calls[0][0] as string;
    expect(message).toContain("glm-5.3");
    expect(message).toContain("venus");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("validates the JSON being saved instead of stale model-row state", async () => {
    const onSubmit = vi.fn();
    renderEditForm(onSubmit, {
      ...BASE_CONFIG,
      models: [{ id: "glm-5.3", reasoningEfforts: {} }],
    });

    // Fixing the JSON by hand does not sync `dshModels`; the hard validation
    // must look at the payload that is about to be written, not the old rows.
    fireEvent.change(screen.getByLabelText("dsh-settings-config"), {
      target: {
        value: JSON.stringify({
          ...BASE_CONFIG,
          models: [{ id: "glm-5.3", reasoningEfforts: { low: "low" } }],
        }),
      },
    });
    clickSave();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const values = onSubmit.mock.calls[0][0] as ProviderFormValues;
    expect(JSON.parse(values.settingsConfig).models).toEqual([
      { id: "glm-5.3", reasoningEfforts: { low: "low" } },
    ]);
  });

  it("submits valid reasoningEfforts unchanged", async () => {
    const onSubmit = vi.fn();
    renderEditForm(onSubmit, {
      ...BASE_CONFIG,
      models: [{ id: "glm-5.3", reasoningEfforts: { off: null, low: "low" } }],
    });

    clickSave();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const values = onSubmit.mock.calls[0][0] as ProviderFormValues;
    const settings = JSON.parse(values.settingsConfig);
    expect(settings.models).toEqual([
      { id: "glm-5.3", reasoningEfforts: { off: null, low: "low" } },
    ]);
  });

  it("drops the legacy provider-level reasoningEffort on save", async () => {
    const onSubmit = vi.fn();
    renderEditForm(onSubmit, {
      ...BASE_CONFIG,
      reasoningEffort: "high",
      models: [{ id: "glm-5.3" }],
    });

    clickSave();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const values = onSubmit.mock.calls[0][0] as ProviderFormValues;
    const settings = JSON.parse(values.settingsConfig);
    expect(settings).not.toHaveProperty("reasoningEffort");
    expect(settings.maxTokens).toBe(32000);
    expect(settings.models).toEqual([{ id: "glm-5.3" }]);
    expect(toast.info).toHaveBeenCalledWith(
      "已移除旧版供应商级「思考等级」（reasoningEffort）：DSH 原生 pi-ai 路由没有这个字段，思考档位请在模型行里按模型声明。",
    );
  });

  it("preserves the official route's native provider-level reasoningEffort", async () => {
    const onSubmit = vi.fn();
    renderOfficialEditForm(onSubmit, {
      profile: "desktop",
      displayName: "DeepSeek",
      reasoningEffort: "high",
      models: [{ id: "deepseek-v4-pro" }],
    });

    clickSave();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const values = onSubmit.mock.calls[0][0] as ProviderFormValues;
    const settings = JSON.parse(values.settingsConfig);
    expect(settings.reasoningEffort).toBe("high");
    expect(settings.models).toEqual([{ id: "deepseek-v4-pro" }]);
  });

  it("passes official-route reasoningEfforts through without native validation", async () => {
    const onSubmit = vi.fn();
    renderOfficialEditForm(onSubmit, {
      profile: "desktop",
      displayName: "DeepSeek",
      models: [{ id: "deepseek-v4-pro", reasoningEfforts: { venus: "venus" } }],
    });

    clickSave();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const values = onSubmit.mock.calls[0][0] as ProviderFormValues;
    const settings = JSON.parse(values.settingsConfig);
    // The official route's model schema does not declare this field, but CCS
    // must not block edits or rewrite legacy values it was never asked to own.
    expect(settings.models).toEqual([
      { id: "deepseek-v4-pro", reasoningEfforts: { venus: "venus" } },
    ]);
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });

  it("ignores invalid reasoningEfforts on a row without a model id", async () => {
    const onSubmit = vi.fn();
    renderEditForm(onSubmit, {
      ...BASE_CONFIG,
      models: [
        { id: "", reasoningEfforts: {} },
        { id: "glm-5.3", reasoningEfforts: { low: "low" } },
      ],
    });

    clickSave();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const values = onSubmit.mock.calls[0][0] as ProviderFormValues;
    const settings = JSON.parse(values.settingsConfig);
    // The blank row is pruned (empty id) instead of blocking the save.
    expect(settings.models).toEqual([
      { id: "glm-5.3", reasoningEfforts: { low: "low" } },
    ]);
  });
});
