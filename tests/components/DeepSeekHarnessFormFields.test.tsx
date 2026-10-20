import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps, PropsWithChildren } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";
import { DeepSeekHarnessFormFields } from "@/components/providers/forms/DeepSeekHarnessFormFields";
import { Form } from "@/components/ui/form";
import { fetchModelsForConfig } from "@/lib/api/model-fetch";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/lib/api/model-fetch", () => ({
  fetchModelsForConfig: vi.fn(),
  showFetchModelsError: vi.fn(),
}));

type DshFieldsProps = ComponentProps<typeof DeepSeekHarnessFormFields>;

const FormShell = ({ children }: PropsWithChildren) => {
  const form = useForm();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <Form {...form}>{children}</Form>
    </QueryClientProvider>
  );
};

const renderFields = (overrides: Partial<DshFieldsProps> = {}) => {
  const props: DshFieldsProps = {
    isOfficial: false,
    displayName: "Custom DSH",
    onDisplayNameChange: vi.fn(),
    maxTokens: "",
    onMaxTokensChange: vi.fn(),
    apiKey: "sk-test",
    onApiKeyChange: vi.fn(),
    apiKeyEnv: "CUSTOM_DSH_API_KEY",
    onApiKeyEnvChange: vi.fn(),
    baseUrl: "https://api.example.com/v1",
    onBaseUrlChange: vi.fn(),
    api: "openai-completions",
    onApiChange: vi.fn(),
    models: [{ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" }],
    onModelsChange: vi.fn(),
    defaultModel: "deepseek-v4-pro",
    onDefaultModelChange: vi.fn(),
    category: "custom",
    shouldShowApiKeyLink: false,
    websiteUrl: "",
    ...overrides,
  };

  return {
    props,
    ...render(
      <FormShell>
        <DeepSeekHarnessFormFields {...props} />
      </FormShell>,
    ),
  };
};

describe("DeepSeekHarnessFormFields", () => {
  it("updates display name and generation options", () => {
    const onDisplayNameChange = vi.fn();
    const onMaxTokensChange = vi.fn();
    renderFields({
      onDisplayNameChange,
      onMaxTokensChange,
    });

    fireEvent.change(screen.getByLabelText("deepseekHarness.displayName"), {
      target: { value: "Company Gateway" },
    });
    fireEvent.change(screen.getByLabelText("deepseekHarness.maxTokens"), {
      target: { value: "64000" },
    });

    expect(onDisplayNameChange).toHaveBeenCalledWith("Company Gateway");
    expect(onMaxTokensChange).toHaveBeenCalledWith("64000");
    // 供应商级思考强度输入已删除：它改成了模型级「思考强度」列。
    expect(
      screen.queryByLabelText("deepseekHarness.reasoningEffort"),
    ).not.toBeInTheDocument();
  });

  it("shows credential ref and API format for custom providers", () => {
    renderFields();

    expect(screen.getByLabelText("Credential Ref")).toHaveValue(
      "CUSTOM_DSH_API_KEY",
    );
    expect(screen.getByText("API Format")).toBeInTheDocument();
    expect(screen.getByText("Model Catalog")).toBeInTheDocument();
    expect(screen.getByLabelText("Default Model")).toHaveValue(
      "deepseek-v4-pro",
    );
  });

  it("keeps every model control on a single grid row", () => {
    renderFields();

    const row = screen
      .getByPlaceholderText("Model ID")
      .closest('[class*="md:grid-cols-"]');
    expect(row).not.toBeNull();
    // 显示名 / 模型 ID / 上下文 / 推理等级 / 删除，一行五格，不再拆第二行。
    expect(row?.childElementCount).toBe(5);
    expect(row).toContainElement(screen.getByLabelText("Context Window"));
    expect(row).toContainElement(screen.getByLabelText("Reasoning"));
  });

  it("official route drops the reasoning column and keeps four cells", () => {
    renderFields({ isOfficial: true, category: "official" });

    const row = screen
      .getByPlaceholderText("Model ID")
      .closest('[class*="md:grid-cols-"]');
    expect(row).not.toBeNull();
    // 官方 llm-deepseek 的 models schema 没有 reasoningEfforts。
    expect(row?.childElementCount).toBe(4);
    expect(screen.queryByLabelText("Reasoning")).not.toBeInTheDocument();
  });

  it("hides credential ref and API format for official providers", () => {
    renderFields({
      isOfficial: true,
      category: "official",
      apiKeyEnv: "DEEPSEEK_API_KEY",
    });

    expect(screen.queryByLabelText("Credential Ref")).not.toBeInTheDocument();
    expect(screen.queryByText("API Format")).not.toBeInTheDocument();
    expect(screen.getByText("Model Catalog")).toBeInTheDocument();
    // The official DeepSeek route has no OAuth login and requires an API key,
    // so the input stays editable even in the "official" category.
    expect(screen.getByLabelText("API Key")).toBeEnabled();
  });

  it("updates a model name", () => {
    const onModelsChange = vi.fn();
    renderFields({ onModelsChange });

    fireEvent.change(screen.getByDisplayValue("DeepSeek V4 Pro"), {
      target: { value: "V4 Pro" },
    });

    expect(onModelsChange).toHaveBeenCalledWith([
      { id: "deepseek-v4-pro", name: "V4 Pro" },
    ]);
  });

  it("updates the optional context window", () => {
    const onModelsChange = vi.fn();
    renderFields({ onModelsChange });

    fireEvent.change(screen.getByLabelText("Context Window"), {
      target: { value: "128000" },
    });

    expect(onModelsChange).toHaveBeenCalledWith([
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", contextWindow: 128000 },
    ]);
  });

  it("adds a model row with a stable row key", () => {
    const onModelsChange = vi.fn();
    renderFields({ models: [], onModelsChange });

    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(onModelsChange).toHaveBeenCalledWith([
      { id: "", name: undefined, rowKey: expect.any(String) },
    ]);
  });

  it("removes a model row", () => {
    const onModelsChange = vi.fn();
    renderFields({ onModelsChange });

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    expect(onModelsChange).toHaveBeenCalledWith([]);
  });

  it("uppercases the credential ref", () => {
    const onApiKeyEnvChange = vi.fn();
    renderFields({ onApiKeyEnvChange });

    fireEvent.change(screen.getByLabelText("Credential Ref"), {
      target: { value: "my_key" },
    });

    expect(onApiKeyEnvChange).toHaveBeenCalledWith("MY_KEY");
  });

  it("updates the default model", () => {
    const onDefaultModelChange = vi.fn();
    renderFields({ onDefaultModelChange });

    fireEvent.change(screen.getByLabelText("Default Model"), {
      target: { value: "glm-5" },
    });

    expect(onDefaultModelChange).toHaveBeenCalledWith("glm-5");
  });

  it("disables the default model for background providers with a hint", () => {
    renderFields({ isDefaultModelApplicable: false });

    expect(screen.getByLabelText("Default Model")).toBeDisabled();
    expect(
      screen.getByText(
        "This provider is not the route DSH currently uses; default-model changes would not apply.",
      ),
    ).toBeInTheDocument();
  });

  it("fetches models, opens the picker, and writes selected rows", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(fetchModelsForConfig).mockResolvedValue([
      { id: "gpt-4o", ownedBy: "openai" },
    ]);
    const onModelsChange = vi.fn();
    renderFields({ onModelsChange });

    fireEvent.click(
      screen.getByRole("button", { name: "providerForm.fetchModels" }),
    );

    await waitFor(() =>
      expect(fetchModelsForConfig).toHaveBeenCalledWith(
        "https://api.example.com/v1",
        "sk-test",
      ),
    );

    const checkbox = await screen.findByRole("checkbox", { name: "gpt-4o" });
    fireEvent.click(checkbox);
    fireEvent.click(
      screen.getByRole("button", { name: "providerForm.modelPicker.apply" }),
    );

    const nextModels = onModelsChange.mock.calls.at(-1)?.[0];
    expect(nextModels).toEqual([
      expect.objectContaining({ id: "deepseek-v4-pro" }),
      expect.objectContaining({ id: "gpt-4o", name: "gpt-4o" }),
    ]);
  });

  it("opens the fetched-model picker when the catalog is empty", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValue([
      { id: "gpt-4o", ownedBy: "openai" },
    ]);
    renderFields({ models: [] });

    fireEvent.click(
      screen.getByRole("button", { name: "providerForm.fetchModels" }),
    );

    await waitFor(() => expect(fetchModelsForConfig).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByRole("checkbox", { name: "gpt-4o" }),
    ).toBeInTheDocument();
  });
});
