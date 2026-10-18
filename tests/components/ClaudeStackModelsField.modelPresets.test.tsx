import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeStackModelsField,
  createClaudeStackModelRow,
  type ClaudeStackModelRow,
} from "@/components/providers/forms/ClaudeStackModelsField";
import { Form } from "@/components/ui/form";
import type { ModelPreset } from "@/lib/modelPresets";

const presetStore = vi.hoisted(() => ({
  presets: [] as ModelPreset[],
  generic: {},
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

const APPLY_PRESET = "modelPresets.prompt.applyPreset";
const SKIP = "modelPresets.prompt.skip";

const INITIAL_ROWS = [createClaudeStackModelRow({ model: "claude-a" })];

const FormShell = ({ children }: PropsWithChildren) => {
  const form = useForm();
  return <Form {...form}>{children}</Form>;
};

function renderStackField() {
  const onRowsChange = vi.fn();

  function Harness() {
    const [rows, setRows] = useState<ClaudeStackModelRow[]>(INITIAL_ROWS);
    return (
      <FormShell>
        <ClaudeStackModelsField
          rows={rows}
          onRowsChange={(next) => {
            onRowsChange(next);
            setRows(next);
          }}
          fetchedModels={[]}
          onFetchModels={vi.fn()}
          isFetchingModels={false}
        />
      </FormShell>
    );
  }

  render(<Harness />);
  return { onRowsChange };
}

function requestModelInput() {
  return screen.getByLabelText("实际请求模型");
}

function oneMCheckbox() {
  return screen.getByRole("checkbox", { name: "1M" });
}

function commitModel(value: string) {
  fireEvent.change(requestModelInput(), { target: { value } });
  fireEvent.keyDown(requestModelInput(), { key: "Enter" });
}

describe("ClaudeStackModelsField 模型预设", () => {
  beforeEach(() => {
    presetStore.presets = [
      {
        id: "preset-claude",
        name: "Claude 长上下文",
        modelId: "claude-3-*",
        contextWindow: 1_000_000,
        temperature: 0.2,
      },
    ];
    presetStore.generic = {};
  });

  it("提交命中的模型 id 后弹询问框，套用时勾上 1M", async () => {
    const { onRowsChange } = renderStackField();

    commitModel("claude-3-7-sonnet");

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: APPLY_PRESET }));

    await waitFor(() => {
      expect(oneMCheckbox()).toBeChecked();
    });
    expect(onRowsChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ model: "claude-3-7-sonnet", oneM: true }),
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("跳过时不勾 1M、模型名也不动", async () => {
    renderStackField();

    commitModel("claude-3-7-sonnet");

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: SKIP }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(oneMCheckbox()).not.toBeChecked();
    expect(requestModelInput()).toHaveValue("claude-3-7-sonnet");
  });

  it("窗口不到 100 万时这行表达不了，套用也不勾 1M", async () => {
    presetStore.presets = [
      {
        id: "preset-claude",
        name: "Claude 普通窗口",
        modelId: "claude-3-*",
        contextWindow: 200000,
      },
    ];
    renderStackField();

    commitModel("claude-3-7-sonnet");
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: APPLY_PRESET,
      }),
    );

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(oneMCheckbox()).not.toBeChecked();
  });
});
