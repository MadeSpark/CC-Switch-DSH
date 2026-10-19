import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { TFunction } from "i18next";
import { ModelPresetsSection } from "@/components/settings/sections/ModelPresetsSection";
import {
  useModelPresetPrompt,
  type ModelPresetApplyHandler,
} from "@/hooks/useModelPresetPrompt";
import { useModelPresets } from "@/hooks/useModelPresets";
import {
  GENERIC_PROMPT_ENABLED_STORAGE_KEY,
  describePresetParams,
  hasPresetParams,
  isValidModelPattern,
  matchModelPreset,
  parseExtraParams,
  uniquePresetId,
  writeGenericPromptEnabled,
  type ModelPreset,
  type ModelPresetSettings,
} from "@/lib/modelPresets";
import { renderWithQueryClient } from "../utils/testQueryClient";

const { getMock, saveMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  saveMock: vi.fn(),
}));

vi.mock("@/lib/api/modelPresets", () => ({
  modelPresetsApi: { get: getMock, save: saveMock },
}));

/** i18n 在测试里资源为空，t 直接返回 key。 */
const t = ((key: string) => key) as unknown as TFunction;

const deepseekPreset: ModelPreset = {
  id: "p1",
  name: "DeepSeek V4 Pro",
  modelId: "deepseek-v4-pro",
  contextWindow: 128000,
  maxOutputTokens: 8192,
  reasoningEffort: "max",
};

function setupPresets(settings: ModelPresetSettings) {
  getMock.mockResolvedValue(settings);
  saveMock.mockImplementation(async (payload: ModelPresetSettings) => payload);
}

beforeEach(() => {
  localStorage.removeItem(GENERIC_PROMPT_ENABLED_STORAGE_KEY);
});

describe("modelPresets 纯逻辑", () => {
  it("精确匹配忽略大小写和首尾空白", () => {
    expect(matchModelPreset("  DeepSeek-V4-Pro ", [deepseekPreset])?.id).toBe(
      "p1",
    );
  });

  it("通配符匹配，命中多个时取最具体的一个", () => {
    const presets: ModelPreset[] = [
      { id: "loose", name: "loose", modelId: "deepseek-*" },
      { id: "tight", name: "tight", modelId: "deepseek-v4-*" },
      { id: "exact", name: "exact", modelId: "deepseek-v4-pro" },
    ];
    expect(matchModelPreset("deepseek-v4-pro", presets)?.id).toBe("exact");
    expect(matchModelPreset("deepseek-v4-lite", presets)?.id).toBe("tight");
    expect(matchModelPreset("deepseek-r1", presets)?.id).toBe("loose");
  });

  it("? 只匹配一个字符，没有命中返回 null", () => {
    const presets: ModelPreset[] = [
      { id: "single", name: "single", modelId: "gpt-?" },
    ];
    expect(matchModelPreset("gpt-4", presets)?.id).toBe("single");
    expect(matchModelPreset("gpt-45", presets)).toBeNull();
    expect(matchModelPreset("claude-3", presets)).toBeNull();
  });

  it("校验匹配模式", () => {
    expect(isValidModelPattern("deepseek-v4-*")).toBe(true);
    expect(isValidModelPattern("gpt-4.1")).toBe(true);
    expect(isValidModelPattern("qwen3:32b")).toBe(true);
    expect(isValidModelPattern("")).toBe(false);
    expect(isValidModelPattern("   ")).toBe(false);
    expect(isValidModelPattern("has space")).toBe(false);
    expect(isValidModelPattern("中文模型")).toBe(false);
  });

  it("describePresetParams 列出已设置的参数（温度 0 也算）", () => {
    expect(describePresetParams({ temperature: 0 }, t)).toEqual([
      "modelPresets.paramLabels.temperature: 0",
    ]);
    expect(
      describePresetParams(
        {
          contextWindow: 128000,
          maxOutputTokens: 8192,
          reasoningEffort: "max",
          temperature: 0.7,
          extraParams: { top_k: 20 },
        },
        t,
      ),
    ).toEqual([
      "modelPresets.paramLabels.contextWindow: 128000",
      "modelPresets.paramLabels.maxOutputTokens: 8192",
      "modelPresets.paramLabels.reasoningEffort: max",
      "modelPresets.paramLabels.temperature: 0.7",
      'modelPresets.paramLabels.extraParams: {"top_k":20}',
    ]);
    expect(describePresetParams({}, t)).toEqual([]);
  });

  it("hasPresetParams 区分空参数和温度 0", () => {
    expect(hasPresetParams({})).toBe(false);
    expect(hasPresetParams(null)).toBe(false);
    expect(hasPresetParams({ temperature: 0 })).toBe(true);
  });

  it("解析额外参数 JSON", () => {
    expect(parseExtraParams("")).toEqual({ ok: true });
    expect(parseExtraParams('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseExtraParams("[1,2]").ok).toBe(false);
    expect(parseExtraParams("{bad").ok).toBe(false);
    expect(parseExtraParams('"text"').ok).toBe(false);
  });

  it("uniquePresetId 每次不同", () => {
    expect(uniquePresetId()).not.toBe(uniquePresetId());
  });
});

function PromptHarness({
  modelId,
  onApply,
}: {
  modelId: string;
  onApply: ModelPresetApplyHandler;
}) {
  const { isLoading, presets } = useModelPresets();
  const { offer, dialog, isPending } = useModelPresetPrompt();
  const [offered, setOffered] = useState("none");

  return (
    <div>
      <span data-testid="loaded">
        {isLoading ? "loading" : `loaded-${presets.length}`}
      </span>
      <button
        type="button"
        onClick={() => setOffered(String(offer(modelId, onApply)))}
      >
        offer
      </button>
      <span data-testid="offered">{offered}</span>
      <span data-testid="pending">{isPending ? "pending" : "idle"}</span>
      {dialog}
    </div>
  );
}

describe("useModelPresetPrompt", () => {
  it("命中预设时弹询问框，套用后回调参数和来源", async () => {
    setupPresets({ presets: [deepseekPreset], generic: {} });
    const onApply = vi.fn();
    renderWithQueryClient(
      <PromptHarness modelId="deepseek-v4-pro" onApply={onApply} />,
    );

    await screen.findByText("loaded-1");
    fireEvent.click(screen.getByRole("button", { name: "offer" }));

    expect(screen.getByTestId("offered")).toHaveTextContent("true");
    expect(screen.getByText("modelPresets.prompt.title")).toBeInTheDocument();
    expect(
      screen.getByText("modelPresets.paramLabels.contextWindow: 128000"),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", {
        name: "modelPresets.prompt.applyPreset",
      }),
    );

    expect(onApply).toHaveBeenCalledWith(
      { contextWindow: 128000, maxOutputTokens: 8192, reasoningEffort: "max" },
      "preset",
      expect.objectContaining({ id: "p1" }),
    );
    expect(screen.getByTestId("pending")).toHaveTextContent("idle");
  });

  it("没有命中预设时用通用参数，通用参数为空则不弹", async () => {
    setupPresets({ presets: [], generic: { temperature: 0.3 } });
    const onApply = vi.fn();
    const { unmount } = renderWithQueryClient(
      <PromptHarness modelId="unknown-model" onApply={onApply} />,
    );

    await screen.findByText("loaded-0");
    fireEvent.click(screen.getByRole("button", { name: "offer" }));
    expect(
      screen.getByText("modelPresets.prompt.genericBody"),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: "modelPresets.prompt.applyGeneric",
      }),
    );
    expect(onApply).toHaveBeenCalledWith(
      { temperature: 0.3 },
      "generic",
      undefined,
    );
    unmount();

    setupPresets({ presets: [], generic: {} });
    const onApplyEmpty = vi.fn();
    renderWithQueryClient(
      <PromptHarness modelId="unknown-model" onApply={onApplyEmpty} />,
    );
    await screen.findByText("loaded-0");
    fireEvent.click(screen.getByRole("button", { name: "offer" }));
    expect(screen.getByTestId("offered")).toHaveTextContent("false");
    expect(screen.queryByText("modelPresets.prompt.title")).toBeNull();
    expect(onApplyEmpty).not.toHaveBeenCalled();
  });

  it("通用参数询问开关关闭后不再询问", async () => {
    writeGenericPromptEnabled(false);
    setupPresets({ presets: [], generic: { contextWindow: 64000 } });
    const onApply = vi.fn();
    renderWithQueryClient(
      <PromptHarness modelId="unknown-model" onApply={onApply} />,
    );

    await screen.findByText("loaded-0");
    fireEvent.click(screen.getByRole("button", { name: "offer" }));
    expect(screen.getByTestId("offered")).toHaveTextContent("false");
    expect(screen.queryByText("modelPresets.prompt.title")).toBeNull();
  });

  it("命中的预设没有可套用参数时不询问", async () => {
    setupPresets({
      presets: [{ id: "empty", name: "empty", modelId: "plain-model" }],
      generic: {},
    });
    const onApply = vi.fn();
    renderWithQueryClient(
      <PromptHarness modelId="plain-model" onApply={onApply} />,
    );

    await screen.findByText("loaded-1");
    fireEvent.click(screen.getByRole("button", { name: "offer" }));
    expect(screen.getByTestId("offered")).toHaveTextContent("false");
    expect(onApply).not.toHaveBeenCalled();
  });
});

describe("ModelPresetsSection", () => {
  it("已有预设读取失败时禁用导入，重试恢复后保留已有数据", async () => {
    setupPresets({ presets: [deepseekPreset], generic: { temperature: 0.2 } });
    getMock.mockRejectedValueOnce(new Error("fixture loading failure"));
    renderWithQueryClient(<ModelPresetsSection />);
    await screen.findByRole("alert");
    const importButton = screen.getByRole("button", {
      name: "从已配置供应商导入",
    });
    expect(importButton).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText("DeepSeek V4 Pro");
    await waitFor(() => expect(importButton).toBeEnabled());
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("渲染预设列表和通用参数并提供添加 / 编辑 / 删除 / 复制入口", async () => {
    setupPresets({ presets: [deepseekPreset], generic: { temperature: 0.2 } });
    renderWithQueryClient(<ModelPresetsSection />);

    expect(await screen.findByText("DeepSeek V4 Pro")).toBeInTheDocument();
    expect(screen.getByText("deepseek-v4-pro")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "modelPresets.addPreset" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "modelPresets.editPreset" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "common.copy" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "modelPresets.deletePreset" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "modelPresets.genericAskToggle" }),
    ).toBeChecked();
  });

  it("新增预设后整份保存，列表里出现新预设", async () => {
    setupPresets({ presets: [], generic: {} });
    renderWithQueryClient(<ModelPresetsSection />);

    expect(await screen.findByText("modelPresets.empty")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "modelPresets.addPreset" }),
    );

    const dialog = screen.getByRole("dialog");
    fireEvent.change(
      within(dialog).getByLabelText("modelPresets.fields.modelId"),
      { target: { value: "qwen-*" } },
    );
    fireEvent.change(
      within(dialog).getByLabelText("modelPresets.fields.name"),
      { target: { value: "Qwen" } },
    );
    fireEvent.change(
      within(dialog).getByLabelText("modelPresets.fields.contextWindow"),
      { target: { value: "32000" } },
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "modelPresets.save" }),
    );

    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    expect(saveMock).toHaveBeenCalledWith({
      presets: [
        expect.objectContaining({
          name: "Qwen",
          modelId: "qwen-*",
          contextWindow: 32000,
        }),
      ],
      generic: {},
    });
    expect(await screen.findByText("Qwen")).toBeInTheDocument();
  });

  it("模型 id 非法或重复时提示错误且不保存", async () => {
    setupPresets({ presets: [deepseekPreset], generic: {} });
    renderWithQueryClient(<ModelPresetsSection />);
    await screen.findByText("DeepSeek V4 Pro");

    fireEvent.click(
      screen.getByRole("button", { name: "modelPresets.addPreset" }),
    );
    let dialog = screen.getByRole("dialog");
    fireEvent.change(
      within(dialog).getByLabelText("modelPresets.fields.modelId"),
      { target: { value: "has space" } },
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "modelPresets.save" }),
    );
    expect(
      await within(dialog).findByText("modelPresets.invalidModelId"),
    ).toBeInTheDocument();

    fireEvent.change(
      within(dialog).getByLabelText("modelPresets.fields.modelId"),
      { target: { value: "deepseek-v4-pro" } },
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "modelPresets.save" }),
    );
    expect(
      await within(dialog).findByText("modelPresets.duplicateModelId"),
    ).toBeInTheDocument();
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("删除预设需要确认，确认后整份保存", async () => {
    setupPresets({ presets: [deepseekPreset], generic: {} });
    renderWithQueryClient(<ModelPresetsSection />);
    await screen.findByText("DeepSeek V4 Pro");

    fireEvent.click(
      screen.getByRole("button", { name: "modelPresets.deletePreset" }),
    );
    expect(
      await screen.findByText("modelPresets.deleteConfirmTitle"),
    ).toBeInTheDocument();

    const deleteButtons = screen.getAllByRole("button", {
      name: "modelPresets.deletePreset",
    });
    fireEvent.click(deleteButtons[deleteButtons.length - 1]);

    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    expect(saveMock).toHaveBeenCalledWith({ presets: [], generic: {} });
    expect(await screen.findByText("modelPresets.empty")).toBeInTheDocument();
  });

  it("保存通用参数", async () => {
    setupPresets({ presets: [], generic: { temperature: 0.2 } });
    renderWithQueryClient(<ModelPresetsSection />);
    await screen.findByText("modelPresets.empty");

    // 等后端数据到位、通用参数草稿被同步一次之后再改
    const temperatureInput = screen.getByLabelText(
      "modelPresets.fields.temperature",
    );
    await waitFor(() => expect(temperatureInput).toHaveValue("0.2"));

    fireEvent.change(temperatureInput, { target: { value: "0.5" } });
    fireEvent.click(screen.getByRole("button", { name: "modelPresets.save" }));

    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    expect(saveMock).toHaveBeenCalledWith({
      presets: [],
      generic: { temperature: 0.5 },
    });
  });
});
