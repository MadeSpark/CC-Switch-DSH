import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModelPresetsSection } from "@/components/settings/sections/ModelPresetsSection";
import type { Provider } from "@/types";
import {
  GENERIC_PROMPT_ENABLED_STORAGE_KEY,
  type ModelPreset,
  type ModelPresetSettings,
} from "@/lib/modelPresets";
import { renderWithQueryClient } from "../utils/testQueryClient";

const { providersGetAllMock, getMock, saveMock } = vi.hoisted(() => ({
  providersGetAllMock: vi.fn(),
  getMock: vi.fn(),
  saveMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  providersApi: { getAll: providersGetAllMock },
}));

vi.mock("@/lib/api/modelPresets", () => ({
  modelPresetsApi: { get: getMock, save: saveMock },
}));

const conflictingPreset: ModelPreset = {
  id: "p-existing",
  name: "Duplicated existing",
  modelId: "deepseek-v4-dup",
  temperature: 0.9,
  extraParams: { custom: "keep" },
};

const providersFixture: Record<string, Provider> = {
  "dsh-main": {
    id: "dsh-main",
    name: "DSH 主账号",
    settingsConfig: {
      models: [
        {
          id: "deepseek-v4-pro",
          name: "DeepSeek V4 Pro",
          contextWindow: 128000,
          maxTokens: 8192,
          reasoningEffort: "high",
          temperature: 0.3,
          reasoningEfforts: { low: "low", high: "high" },
          compat: { supportsStore: true },
          input: ["text"],
        },
        {
          id: "deepseek-v4-lite",
          name: "DeepSeek V4 Lite",
          contextWindow: 64000,
          reasoningEffort: "medium",
        },
        "bare-model",
        {
          id: "deepseek-v4-dup",
          name: "DeepSeek V4 Duplicate",
          contextWindow: 32000,
        },
      ],
    },
  },
  "dsh-second": {
    id: "dsh-second",
    name: "DSH 备用账号",
    settingsConfig: {
      models: [{ id: "second-model", name: "Second Model", temperature: 0.7 }],
    },
  },
};

function setupPresets(settings: Partial<ModelPresetSettings> = {}) {
  getMock.mockResolvedValue({
    presets: [],
    generic: {},
    ...settings,
  });
  saveMock.mockImplementation(async (payload: ModelPresetSettings) => payload);
}

async function renderLoadedSection(
  settings: Partial<ModelPresetSettings> = {},
) {
  setupPresets(settings);
  renderWithQueryClient(<ModelPresetsSection />);
  if (settings.presets && settings.presets.length > 0) {
    await screen.findByText(settings.presets[0].name);
  } else {
    await screen.findByText("modelPresets.empty");
  }
}

type User = ReturnType<typeof userEvent.setup>;

async function openImportDialog() {
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "从已配置供应商导入" }),
  );
  const dialog = await screen.findByRole("dialog");
  return { user, dialog };
}

async function chooseProvider(
  user: User,
  dialog: HTMLElement,
  providerName: string,
) {
  await user.click(within(dialog).getByRole("combobox", { name: "供应商" }));
  await user.click(await screen.findByRole("option", { name: providerName }));
}

function getModelTable(dialog: HTMLElement): HTMLElement {
  return within(dialog).getByRole("table", { name: "供应商模型" });
}

function getModelRow(dialog: HTMLElement, modelId: string): HTMLElement {
  const row = within(getModelTable(dialog))
    .getAllByRole("row")
    .find((candidate) =>
      within(candidate).queryByText(modelId, { selector: "code" }),
    );
  if (!row) throw new Error(`找不到模型行：${modelId}`);
  return row;
}

function rowCheckbox(row: HTMLElement): HTMLInputElement {
  return within(row).getByRole("checkbox") as HTMLInputElement;
}

function selectAllCheckbox(dialog: HTMLElement): HTMLInputElement {
  return within(dialog).getByRole("checkbox", {
    name: "全选",
  }) as HTMLInputElement;
}

function importButton(dialog: HTMLElement): HTMLElement {
  return within(dialog).getByRole("button", { name: /导入/ });
}

beforeEach(() => {
  providersGetAllMock.mockReset();
  getMock.mockReset();
  saveMock.mockReset();
  localStorage.removeItem(GENERIC_PROMPT_ENABLED_STORAGE_KEY);
  Element.prototype.scrollIntoView = vi.fn();
});

describe("ImportDshModelPresetDialog", () => {
  it("选择供应商后列出它的全部模型和四列表头", async () => {
    providersGetAllMock.mockResolvedValue(providersFixture);
    await renderLoadedSection();
    const { user, dialog } = await openImportDialog();
    await chooseProvider(user, dialog, "DSH 主账号");

    const table = getModelTable(dialog);
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent?.trim()),
    ).toEqual(["", "显示名称", "模型 ID", "上下文窗口", "推理等级"]);
    expect(within(table).getAllByRole("row")).toHaveLength(5);

    expect(within(table).getByText("DeepSeek V4 Pro")).toBeInTheDocument();
    expect(within(table).getByText("DeepSeek V4 Lite")).toBeInTheDocument();
    expect(
      within(table).getByText("DeepSeek V4 Duplicate"),
    ).toBeInTheDocument();
    expect(within(table).getAllByText("bare-model")).toHaveLength(2);
    for (const modelId of [
      "deepseek-v4-pro",
      "deepseek-v4-lite",
      "bare-model",
      "deepseek-v4-dup",
    ]) {
      expect(
        within(getModelRow(dialog, modelId)).getByText(modelId, {
          selector: "code",
        }),
      ).toBeInTheDocument();
    }

    const proRow = getModelRow(dialog, "deepseek-v4-pro");
    expect(within(proRow).getByText("128000")).toBeInTheDocument();
    expect(within(proRow).getByText("low, high")).toBeInTheDocument();
    const liteRow = getModelRow(dialog, "deepseek-v4-lite");
    expect(within(liteRow).getByText("64000")).toBeInTheDocument();
    // 旧插件在模型行写的 `reasoningEffort: "medium"` 不是原生字段，
    // 不能当成当前档位展示；原生只认 `reasoningEfforts`。
    expect(within(liteRow).getByText("未设置")).toBeInTheDocument();
    expect(within(dialog).getByText("共 3 个可导入")).toBeInTheDocument();
  });

  it("勾选两个模型后只保存一次，每个预设带上该模型的全部参数", async () => {
    providersGetAllMock.mockResolvedValue(providersFixture);
    await renderLoadedSection({ generic: { temperature: 0.2 } });
    const { user, dialog } = await openImportDialog();
    await chooseProvider(user, dialog, "DSH 主账号");

    await user.click(rowCheckbox(getModelRow(dialog, "deepseek-v4-pro")));
    await user.click(rowCheckbox(getModelRow(dialog, "deepseek-v4-lite")));
    expect(within(dialog).getByText("已选 2 个模型")).toBeInTheDocument();

    await user.click(importButton(dialog));
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    const payload = saveMock.mock.calls[0][0] as ModelPresetSettings;

    expect(payload.generic).toEqual({ temperature: 0.2 });
    expect(payload.presets).toHaveLength(2);
    expect(payload.presets[0]).toEqual({
      id: expect.any(String),
      name: "DeepSeek V4 Pro",
      modelId: "deepseek-v4-pro",
      contextWindow: 128000,
      maxOutputTokens: 8192,
      temperature: 0.3,
      extraParams: {
        reasoningEfforts: { low: "low", high: "high" },
        compat: { supportsStore: true },
        input: ["text"],
      },
    });
    expect(payload.presets[1]).toEqual({
      id: expect.any(String),
      name: "DeepSeek V4 Lite",
      modelId: "deepseek-v4-lite",
      contextWindow: 64000,
    });
    expect(payload.presets[0].id).not.toBe(payload.presets[1].id);

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("全选只勾选可导入的模型，表头支持半选且清空可复位", async () => {
    providersGetAllMock.mockResolvedValue(providersFixture);
    await renderLoadedSection({ presets: [conflictingPreset] });
    const { user, dialog } = await openImportDialog();
    await chooseProvider(user, dialog, "DSH 主账号");

    const header = selectAllCheckbox(dialog);
    expect(header).not.toBeChecked();
    expect(header.indeterminate).toBe(false);

    await user.click(header);
    expect(rowCheckbox(getModelRow(dialog, "deepseek-v4-pro"))).toBeChecked();
    expect(rowCheckbox(getModelRow(dialog, "deepseek-v4-lite"))).toBeChecked();
    const duplicateCheckbox = rowCheckbox(
      getModelRow(dialog, "deepseek-v4-dup"),
    );
    expect(duplicateCheckbox).toBeDisabled();
    expect(duplicateCheckbox).not.toBeChecked();
    expect(rowCheckbox(getModelRow(dialog, "bare-model"))).toBeDisabled();
    expect(header).toBeChecked();
    expect(header.indeterminate).toBe(false);
    expect(within(dialog).getByText("已选 2 个模型")).toBeInTheDocument();

    await user.click(rowCheckbox(getModelRow(dialog, "deepseek-v4-lite")));
    expect(header).not.toBeChecked();
    expect(header.indeterminate).toBe(true);
    expect(within(dialog).getByText("已选 1 个模型")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "清空" }));
    expect(
      rowCheckbox(getModelRow(dialog, "deepseek-v4-pro")),
    ).not.toBeChecked();
    expect(header).not.toBeChecked();
    expect(header.indeterminate).toBe(false);
    expect(within(dialog).getByText("已选 0 个模型")).toBeInTheDocument();
    expect(importButton(dialog)).toBeDisabled();
  });

  it("已有相同匹配 ID 的预设时该行禁用，保存不会覆盖原预设", async () => {
    providersGetAllMock.mockResolvedValue(providersFixture);
    await renderLoadedSection({ presets: [conflictingPreset] });
    const { user, dialog } = await openImportDialog();
    await chooseProvider(user, dialog, "DSH 主账号");

    const duplicateRow = getModelRow(dialog, "deepseek-v4-dup");
    expect(rowCheckbox(duplicateRow)).toBeDisabled();
    expect(within(duplicateRow).getByText("已有预设")).toBeInTheDocument();
    expect(
      within(dialog).getByText("已有相同匹配 ID 的预设，不会重复导入。"),
    ).toBeInTheDocument();

    await user.click(rowCheckbox(getModelRow(dialog, "deepseek-v4-pro")));
    await user.click(importButton(dialog));
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    const payload = saveMock.mock.calls[0][0] as ModelPresetSettings;

    expect(payload.presets).toHaveLength(2);
    expect(payload.presets[0]).toEqual(conflictingPreset);
    expect(payload.presets[1]).toMatchObject({
      modelId: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      contextWindow: 128000,
    });
    expect(
      payload.presets.filter((preset) => preset.modelId === "deepseek-v4-dup"),
    ).toHaveLength(1);
  });

  it("只有 ID 没有可导入参数的模型禁用并标记", async () => {
    providersGetAllMock.mockResolvedValue(providersFixture);
    await renderLoadedSection();
    const { user, dialog } = await openImportDialog();
    await chooseProvider(user, dialog, "DSH 主账号");

    const row = getModelRow(dialog, "bare-model");
    expect(rowCheckbox(row)).toBeDisabled();
    expect(within(row).getByText("无可导入参数")).toBeInTheDocument();
    expect(within(dialog).getByText("共 3 个可导入")).toBeInTheDocument();
  });

  it("未勾选任何模型时导入按钮禁用", async () => {
    providersGetAllMock.mockResolvedValue(providersFixture);
    await renderLoadedSection();
    const { user, dialog } = await openImportDialog();

    expect(importButton(dialog)).toBeDisabled();
    expect(importButton(dialog)).toHaveTextContent("导入预设");

    await chooseProvider(user, dialog, "DSH 主账号");
    expect(within(dialog).getByText("已选 0 个模型")).toBeInTheDocument();
    expect(importButton(dialog)).toBeDisabled();
    expect(importButton(dialog)).toHaveTextContent("导入预设");
  });

  it("保存失败后保留对话框和勾选，并允许直接重试", async () => {
    providersGetAllMock.mockResolvedValue(providersFixture);
    await renderLoadedSection();
    const { user, dialog } = await openImportDialog();
    await chooseProvider(user, dialog, "DSH 主账号");
    saveMock.mockRejectedValueOnce(new Error("fixture save failure"));

    await user.click(rowCheckbox(getModelRow(dialog, "deepseek-v4-pro")));
    await user.click(importButton(dialog));
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "保存失败，当前选择已保留，可以直接重试。",
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(rowCheckbox(getModelRow(dialog, "deepseek-v4-pro"))).toBeChecked();
    expect(importButton(dialog)).toBeEnabled();

    await user.click(importButton(dialog));
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("推理等级列展示已禁用、区间、单值和未设置", async () => {
    providersGetAllMock.mockResolvedValue({
      "dsh-reasoning": {
        id: "dsh-reasoning",
        name: "DSH 推理供应商",
        settingsConfig: {
          models: [
            {
              id: "reasoning-disabled",
              name: "关闭推理",
              reasoningEfforts: false,
            },
            {
              id: "reasoning-range",
              name: "三档推理",
              reasoningEfforts: {
                medium: "medium",
                low: "low",
                high: "high",
              },
            },
            {
              id: "reasoning-single",
              name: "单档推理",
              reasoningEfforts: { max: "max" },
            },
            { id: "reasoning-none", name: "无推理设置" },
          ],
        },
      },
    });
    await renderLoadedSection();
    const { user, dialog } = await openImportDialog();
    await chooseProvider(user, dialog, "DSH 推理供应商");

    expect(
      within(getModelRow(dialog, "reasoning-disabled")).getByText("已禁用"),
    ).toBeInTheDocument();
    expect(
      within(getModelRow(dialog, "reasoning-range")).getByText("low → high"),
    ).toBeInTheDocument();
    expect(
      within(getModelRow(dialog, "reasoning-single")).getByText("max"),
    ).toBeInTheDocument();
    expect(
      within(getModelRow(dialog, "reasoning-none")).getByText("未设置"),
    ).toBeInTheDocument();
  });

  it("取消不会触发保存", async () => {
    providersGetAllMock.mockResolvedValue(providersFixture);
    await renderLoadedSection();
    const { user, dialog } = await openImportDialog();
    await chooseProvider(user, dialog, "DSH 主账号");
    await user.click(rowCheckbox(getModelRow(dialog, "deepseek-v4-pro")));

    await user.click(
      within(dialog).getByRole("button", { name: "modelPresets.cancel" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("切换供应商会清空之前的勾选", async () => {
    providersGetAllMock.mockResolvedValue(providersFixture);
    await renderLoadedSection();
    const { user, dialog } = await openImportDialog();
    await chooseProvider(user, dialog, "DSH 主账号");
    await user.click(rowCheckbox(getModelRow(dialog, "deepseek-v4-pro")));
    expect(within(dialog).getByText("已选 1 个模型")).toBeInTheDocument();

    await chooseProvider(user, dialog, "DSH 备用账号");
    expect(getModelRow(dialog, "second-model")).toBeInTheDocument();
    expect(within(dialog).queryByText("DeepSeek V4 Pro")).toBeNull();
    expect(within(dialog).getByText("已选 0 个模型")).toBeInTheDocument();
    expect(importButton(dialog)).toBeDisabled();

    await chooseProvider(user, dialog, "DSH 主账号");
    expect(
      rowCheckbox(getModelRow(dialog, "deepseek-v4-pro")),
    ).not.toBeChecked();
  });

  it("重复的模型 ID 只保留第一条", async () => {
    providersGetAllMock.mockResolvedValue({
      "dsh-dedupe": {
        id: "dsh-dedupe",
        name: "DSH 去重供应商",
        settingsConfig: {
          models: [
            { id: "dup-model", name: "First Dup", contextWindow: 1000 },
            { id: " dup-model ", name: "Second Dup", temperature: 0.5 },
            "dup-model",
            { id: "unique-model", name: "Unique Model", temperature: 0.1 },
          ],
        },
      },
    });
    await renderLoadedSection();
    const { user, dialog } = await openImportDialog();
    await chooseProvider(user, dialog, "DSH 去重供应商");

    const table = getModelTable(dialog);
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(within(table).getByText("First Dup")).toBeInTheDocument();
    expect(within(table).queryByText("Second Dup")).toBeNull();
    expect(
      within(table).getAllByText("dup-model", { selector: "code" }),
    ).toHaveLength(1);
    expect(within(table).getByText("Unique Model")).toBeInTheDocument();
  });

  it("读取供应商失败时展示错误，重试后可继续导入", async () => {
    providersGetAllMock
      .mockRejectedValueOnce(new Error("fixture provider loading failure"))
      .mockResolvedValue(providersFixture);
    await renderLoadedSection();
    const { user, dialog } = await openImportDialog();

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "读取 DSH 供应商失败，请重试。",
    );
    expect(importButton(dialog)).toBeDisabled();

    await user.click(within(dialog).getByRole("button", { name: "重试" }));
    await chooseProvider(user, dialog, "DSH 主账号");
    expect(getModelRow(dialog, "deepseek-v4-pro")).toBeInTheDocument();
    expect(within(dialog).getByText("共 3 个可导入")).toBeInTheDocument();
  });

  it("没有已配置的 DSH 供应商时展示空状态", async () => {
    providersGetAllMock.mockResolvedValue({});
    await renderLoadedSection();
    const { dialog } = await openImportDialog();

    expect(
      within(dialog).getByText(
        "还没有已配置的 DeepSeek Harness 供应商。请先在供应商页添加供应商和模型。",
      ),
    ).toBeInTheDocument();
    expect(importButton(dialog)).toBeDisabled();
  });

  it("供应商没有配置模型时展示空模型提示", async () => {
    providersGetAllMock.mockResolvedValue({
      "dsh-empty": {
        id: "dsh-empty",
        name: "DSH 空模型",
        settingsConfig: { models: [] },
      },
    });
    await renderLoadedSection();
    const { user, dialog } = await openImportDialog();
    await chooseProvider(user, dialog, "DSH 空模型");

    expect(
      await within(dialog).findByText(
        "该供应商还没有配置模型。请先在供应商表单里添加模型。",
      ),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole("table")).toBeNull();
    expect(importButton(dialog)).toBeDisabled();
  });
});
