import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DshModelPresetMatchDialog } from "@/components/model-presets/DshModelPresetMatchDialog";
import type { ModelPreset } from "@/lib/modelPresets";
import type { DshModel } from "@/components/providers/forms/helpers/deepseekHarnessFormUtils";
import { renderWithQueryClient } from "../utils/testQueryClient";

const { getMock, saveMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  saveMock: vi.fn(),
}));

vi.mock("@/lib/api/modelPresets", () => ({
  modelPresetsApi: { get: getMock, save: saveMock },
}));

const exactPreset: ModelPreset = {
  id: "p-pro",
  name: "DS Pro 预设",
  modelId: "deepseek-v4-pro",
  contextWindow: 128000,
  maxOutputTokens: 8192,
};

const wildcardPreset: ModelPreset = {
  id: "p-wild",
  name: "通配预设",
  modelId: "deepseek-*",
  temperature: 0.5,
};

const otherPreset: ModelPreset = {
  id: "p-other",
  name: "Other 预设",
  modelId: "gpt-*",
  temperature: 0.6,
};

function setupPresets(
  presets: ModelPreset[] = [exactPreset, wildcardPreset, otherPreset],
  generic: Record<string, unknown> = { temperature: 0.4 },
) {
  getMock.mockResolvedValue({ presets, generic });
}

function setupModels(models: DshModel[]) {
  const onApply = vi.fn();
  const onClose = vi.fn();
  renderWithQueryClient(
    <DshModelPresetMatchDialog
      models={models}
      onApply={onApply}
      onClose={onClose}
    />,
  );
  return { onApply, onClose };
}

const comboboxName = (modelId: string) => `为 ${modelId} 选择预设`;
const findCombobox = (modelId: string) =>
  screen.findByRole("combobox", { name: comboboxName(modelId) });
const getCombobox = (modelId: string) =>
  screen.getByRole("combobox", { name: comboboxName(modelId) });

const applyButton = () => screen.getByRole("button", { name: "应用所选预设" });

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  getMock.mockReset();
  saveMock.mockReset();
});

describe("DshModelPresetMatchDialog", () => {
  it("加载后按精确优先、通配符兜底自动匹配", async () => {
    setupPresets();
    setupModels([
      { rowKey: "r1", id: "deepseek-v4-pro", name: "Pro" },
      { rowKey: "r2", id: "deepseek-v4-lite" },
      { rowKey: "r3", id: "claude-x" },
    ]);

    // 精确匹配 deepseek-v4-pro → p-pro；通配符兜底 deepseek-v4-lite → p-wild。
    expect(await findCombobox("deepseek-v4-pro")).toHaveTextContent(
      "DS Pro 预设 (deepseek-v4-pro)",
    );
    expect(getCombobox("deepseek-v4-lite")).toHaveTextContent(
      "通配预设 (deepseek-*)",
    );
    // 无匹配的行保持「未匹配」。
    expect(getCombobox("claude-x")).toHaveTextContent("未匹配（不应用）");
  });

  it("未匹配的行默认不应用，选区为 0 时确认按钮禁用", async () => {
    setupPresets([]);
    setupModels([{ rowKey: "r1", id: "gpt-x" }]);

    await screen.findByText("gpt-x");
    expect(applyButton()).toBeDisabled();
    expect(screen.getByText("将为 0 个模型应用预设")).toBeInTheDocument();
  });

  it("手动改选预设和通用预设，确认时只改选中行且保留 id/rowKey/其他字段", async () => {
    setupPresets();
    const user = userEvent.setup();
    const { onApply } = setupModels([
      {
        rowKey: "r1",
        id: "deepseek-v4-pro",
        name: "Pro",
        contextWindow: 1000,
      },
      { rowKey: "r2", id: "deepseek-v4-lite", contextWindow: 2000 },
      { rowKey: "r3", id: "claude-x", maxTokens: 3000 },
    ]);

    await findCombobox("deepseek-v4-pro");

    // 行 1 手动改选另一个预设（Other 预设）。
    await user.click(getCombobox("deepseek-v4-pro"));
    await user.click(
      await screen.findByRole("option", { name: "Other 预设 (gpt-*)" }),
    );

    // 行 2 手动改选通用预设。
    await user.click(getCombobox("deepseek-v4-lite"));
    await user.click(
      await screen.findByRole("option", { name: "使用通用预设" }),
    );

    // 行 3 无匹配、不手动改 → 保持未匹配，原样回写。
    expect(
      await screen.findByText("将为 2 个模型应用预设"),
    ).toBeInTheDocument();
    await user.click(applyButton());

    expect(onApply).toHaveBeenCalledTimes(1);
    const next = onApply.mock.calls[0][0] as DshModel[];
    expect(next).toHaveLength(3);

    // 行 1：套用 Other 预设（temperature: 0.6），id/name/rowKey/原有字段保留。
    expect(next[0]).toMatchObject({
      rowKey: "r1",
      id: "deepseek-v4-pro",
      name: "Pro",
      contextWindow: 1000,
      temperature: 0.6,
    });

    // 行 2：套用通用参数，只叠加 temperature，原字段不动。
    expect(next[1]).toMatchObject({
      rowKey: "r2",
      id: "deepseek-v4-lite",
      contextWindow: 2000,
      temperature: 0.4,
    });

    // 行 3：未匹配，原样返回。
    expect(next[2]).toMatchObject({
      rowKey: "r3",
      id: "claude-x",
      maxTokens: 3000,
    });
  });

  it("手动改选回「未匹配」后该行不被修改", async () => {
    setupPresets();
    const user = userEvent.setup();
    const { onApply } = setupModels([
      { rowKey: "r1", id: "deepseek-v4-pro", contextWindow: 1000 },
      { rowKey: "r2", id: "deepseek-v4-lite" },
    ]);

    await findCombobox("deepseek-v4-pro");
    await user.click(getCombobox("deepseek-v4-pro"));
    await user.click(
      await screen.findByRole("option", { name: "未匹配（不应用）" }),
    );
    expect(
      await screen.findByText("将为 1 个模型应用预设"),
    ).toBeInTheDocument();

    await user.click(applyButton());
    const next = onApply.mock.calls[0][0] as DshModel[];
    // 行 1 被改回未匹配 → 原样保留，不被套参数。
    expect(next[0].contextWindow).toBe(1000);
    expect(next[0].reasoningEffort).toBeUndefined();
    // 行 2 仍自动匹配通配预设 → 套用 temperature。
    expect(next[1].temperature).toBe(0.5);
  });
  it("取消时不调用 onApply", async () => {
    setupPresets();
    const user = userEvent.setup();
    const { onApply, onClose } = setupModels([
      { rowKey: "r1", id: "deepseek-v4-pro" },
    ]);

    await findCombobox("deepseek-v4-pro");
    await user.click(screen.getByRole("button", { name: "common.cancel" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onApply).not.toHaveBeenCalled();
  });

  it("空模型 ID 的行禁用下拉并跳过", async () => {
    setupPresets();
    setupModels([
      { rowKey: "r1", id: "", name: "blank" },
      { rowKey: "r2", id: "deepseek-v4-pro" },
    ]);

    await screen.findByText("空模型 ID（跳过）");
    expect(getCombobox("1")).toBeDisabled();
    expect(await findCombobox("deepseek-v4-pro")).toHaveTextContent(
      "DS Pro 预设 (deepseek-v4-pro)",
    );
  });

  it("没有模型行时给出空态", async () => {
    setupPresets();
    setupModels([]);

    expect(await screen.findByText("暂无可匹配的模型。")).toBeInTheDocument();
  });

  it("加载中显示 loading，加载完成前禁用确认", async () => {
    let resolveGet: (value: unknown) => void = () => {};
    getMock.mockReturnValue(
      new Promise((resolve) => {
        resolveGet = resolve;
      }),
    );
    const { onApply } = setupModels([{ rowKey: "r1", id: "deepseek-v4-pro" }]);

    expect(await screen.findByText("正在读取模型预设…")).toBeInTheDocument();
    expect(applyButton()).toBeDisabled();

    resolveGet({ presets: [exactPreset], generic: {} });
    expect(await findCombobox("deepseek-v4-pro")).toHaveTextContent(
      "DS Pro 预设 (deepseek-v4-pro)",
    );
    expect(applyButton()).toBeEnabled();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("加载失败时展示错误并可重试", async () => {
    getMock.mockRejectedValueOnce(new Error("boom"));
    const user = userEvent.setup();
    const { onClose } = setupModels([{ rowKey: "r1", id: "deepseek-v4-pro" }]);

    expect(
      await screen.findByText("读取模型预设失败，请重试。"),
    ).toBeInTheDocument();

    getMock.mockResolvedValue({ presets: [exactPreset], generic: {} });
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await findCombobox("deepseek-v4-pro")).toHaveTextContent(
      "DS Pro 预设 (deepseek-v4-pro)",
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("通用预设没有参数时下拉项禁用", async () => {
    setupPresets([otherPreset], {});
    const user = userEvent.setup();
    setupModels([{ rowKey: "r1", id: "gpt-x" }]);

    await findCombobox("gpt-x");
    await user.click(getCombobox("gpt-x"));
    const genericOption = await screen.findByRole("option", {
      name: "通用预设（尚未配置参数）",
    });
    expect(genericOption).toHaveAttribute("data-disabled");
  });
});
