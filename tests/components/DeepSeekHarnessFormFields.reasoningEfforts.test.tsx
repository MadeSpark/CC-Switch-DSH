/**
 * DSH 表单的「思考强度（reasoningEfforts）」用例。
 *
 * 行为契约见 `.tmp-local/dsh-native-reasoning/native-spec.md`：字段缺省 = 继承
 * 目录能力，`false` = 声明非推理模型，非空对象 = 精确声明可用档位。控件照抄
 * DSH 44.7 原生设置页（开关 + 档位行编辑器 + 添加档位），旧的插件「预设 /
 * 推荐 / 自适应 / 清除」按钮全部删除。
 *
 * 期望值都按原生规则手抄，不反过来用实现算期望：实现改错了这里必须红。
 * helper 的纯函数单测在 `deepseekHarnessFormUtils.reasoningEfforts.test.ts`。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import type { PropsWithChildren } from "react";
import { useForm } from "react-hook-form";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepSeekHarnessFormFields } from "@/components/providers/forms/DeepSeekHarnessFormFields";
import { formatDshReasoningLevelsLabel } from "@/components/providers/forms/helpers/deepseekHarnessFormUtils";
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

afterEach(cleanup);

const FormShell = ({ children }: PropsWithChildren) => {
  const form = useForm();

  return <Form {...form}>{children}</Form>;
};

// 测试环境 i18n 资源为空：带 defaultValue 的 t() 返回 defaultValue，
// 不带 defaultValue 的 t() 原样返回 key（见 tests/setupTests.ts）。
const REASONING = "Reasoning";
const NOT_SET = "Not set";
const DISABLED = "Disabled";
const NEEDS_LEVELS = "Needs levels";
const NEEDS_LEVEL = "Keep at least one level other than off";
const ADD_LEVEL = "Add level";
const REMOVE_LEVEL = "Remove level";

interface HarnessProps {
  initialModels?: DshModel[];
  api?: string;
  isOfficial?: boolean;
}

/** 受控外壳：`<output>` 暴露落盘对象，断言「写了什么」而不是「看起来像什么」。 */
function Harness({
  initialModels = [{ id: "gpt-6.1-sol", name: "Sol", rowKey: "r1" }],
  api = "openai-completions",
  isOfficial = false,
}: HarnessProps) {
  const [models, setModels] = useState<DshModel[]>(initialModels);
  const [defaultModel, setDefaultModel] = useState(initialModels[0]?.id ?? "");

  return (
    <>
      <output data-testid="models">{JSON.stringify(models)}</output>
      <FormShell>
        <DeepSeekHarnessFormFields
          isOfficial={isOfficial}
          displayName="Custom DSH"
          onDisplayNameChange={vi.fn()}
          maxTokens=""
          onMaxTokensChange={vi.fn()}
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

function currentModel(index = 0): DshModel {
  const models = JSON.parse(
    screen.getByTestId("models").textContent ?? "[]",
  ) as DshModel[];
  const model = models[index];
  if (!model) throw new Error(`model row ${index} does not exist`);
  return model;
}

/** 落盘的等级表（断言键序时用它，`toEqual` 不保证顺序）。 */
function savedEntries(index = 0): Array<[string, string | null]> {
  return Object.entries(currentModel(index).reasoningEfforts ?? {});
}

function trigger(rowIndex = 0): HTMLElement {
  const found = screen.getAllByRole("button", { name: REASONING })[rowIndex];
  if (!found) throw new Error(`reasoning trigger ${rowIndex} does not exist`);
  return found;
}

/** Radix 的 Popover 再点一次会关掉，已经开着就别重复点。 */
function openEditor(rowIndex = 0): void {
  const element = trigger(rowIndex);
  if (element.getAttribute("data-state") === "open") return;
  fireEvent.click(element);
}

function toggle(): HTMLElement {
  return screen.getByRole("switch", { name: REASONING });
}

function enableReasoning(rowIndex = 0): void {
  openEditor(rowIndex);
  if (toggle().getAttribute("aria-checked") !== "true") {
    fireEvent.click(toggle());
  }
}

function levelSelect(index: number): HTMLSelectElement {
  return screen.getByLabelText(`Level ${index + 1}`) as HTMLSelectElement;
}

function levelValues(): string[] {
  return screen
    .getAllByLabelText(/^Level \d+$/)
    .map((element) => (element as HTMLSelectElement).value);
}

function valueInput(index: number): HTMLInputElement {
  return screen.getByLabelText(`Value ${index + 1}`) as HTMLInputElement;
}

function chooseLevel(index: number, level: string): void {
  fireEvent.change(levelSelect(index), { target: { value: level } });
}

function typeValue(index: number, text: string): void {
  fireEvent.change(valueInput(index), { target: { value: text } });
}

function addLevel(): void {
  fireEvent.click(screen.getByRole("button", { name: ADD_LEVEL }));
}

function removeLevel(index = 0): void {
  fireEvent.click(screen.getAllByRole("button", { name: REMOVE_LEVEL })[index]);
}

const INITIAL_LEVELS = ["off", "low", "medium", "high"];

describe("DSH 思考强度 · 原生开关", () => {
  it("默认未设置；打开开关播种 off/low/medium/high 并落盘", () => {
    renderHarness();

    expect(trigger()).toHaveTextContent(NOT_SET);
    expect(currentModel()).not.toHaveProperty("reasoningEfforts");

    openEditor();
    expect(toggle()).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute("aria-checked", "true");

    expect(levelValues()).toEqual(INITIAL_LEVELS);
    // off 不发参数，输入框禁用且留空；其余默认等于档位名。
    expect(valueInput(0)).toBeDisabled();
    expect(valueInput(0)).toHaveValue("");
    expect(valueInput(1)).toHaveValue("low");
    expect(valueInput(2)).toHaveValue("medium");
    expect(valueInput(3)).toHaveValue("high");

    expect(savedEntries()).toEqual([
      ["off", null],
      ["low", "low"],
      ["medium", "medium"],
      ["high", "high"],
    ]);
    expect(trigger()).toHaveTextContent(
      formatDshReasoningLevelsLabel(INITIAL_LEVELS),
    );
  });

  it("关闭开关删掉字段；`false` 行显示已禁用，打开后变普通对象", () => {
    renderHarness();
    enableReasoning();
    expect(currentModel()).toHaveProperty("reasoningEfforts");

    fireEvent.click(toggle());
    expect(currentModel()).not.toHaveProperty("reasoningEfforts");
    expect(JSON.stringify(currentModel())).not.toContain("reasoningEfforts");

    cleanup();

    renderHarness({
      initialModels: [{ id: "o3", reasoningEfforts: false, rowKey: "r1" }],
    });
    expect(trigger()).toHaveTextContent(DISABLED);
    expect(currentModel().reasoningEfforts).toBe(false);

    openEditor();
    expect(toggle()).toHaveAttribute("aria-checked", "false");
    // 显式 false 只读展示：关着就是关着，不落盘任何对象。
    expect(screen.getAllByText(DISABLED).length).toBeGreaterThan(0);
    expect(currentModel().reasoningEfforts).toBe(false);

    fireEvent.click(toggle());
    expect(savedEntries()).toEqual([
      ["off", null],
      ["low", "low"],
      ["medium", "medium"],
      ["high", "high"],
    ]);
  });
});

describe("DSH 思考强度 · 档位增删", () => {
  it("添加档位按原生「最高已用之上」规则给出 xhigh", () => {
    renderHarness();
    enableReasoning();

    addLevel();
    expect(levelValues()).toEqual([...INITIAL_LEVELS, "xhigh"]);
    expect(valueInput(4)).toHaveValue("xhigh");
    expect(savedEntries()[4]).toEqual(["xhigh", "xhigh"]);

    // 最高档已是 xhigh，再加就是 max（不是回头补 minimal）。
    addLevel();
    expect(levelValues()).toEqual([...INITIAL_LEVELS, "xhigh", "max"]);
    expect(savedEntries()[5]).toEqual(["max", "max"]);
  });

  it("删除所有行得到 {} 并显示 needsLevel（保存拦截交给 ProviderForm）", () => {
    renderHarness();
    enableReasoning();

    for (let index = 0; index < INITIAL_LEVELS.length; index += 1) {
      removeLevel();
    }

    expect(screen.queryAllByLabelText(/^Level \d+$/)).toEqual([]);
    expect(JSON.stringify(currentModel().reasoningEfforts)).toBe("{}");
    expect(screen.getByRole("alert")).toHaveTextContent(NEEDS_LEVEL);
    expect(trigger()).toHaveTextContent(NEEDS_LEVELS);
  });
});

describe("DSH 思考强度 · 换档与自定义参数值", () => {
  it("自定义参数值在合法换档时保留", () => {
    renderHarness({
      initialModels: [
        {
          id: "gw",
          reasoningEfforts: { low: "custom-low", medium: "medium" },
          rowKey: "r1",
        },
      ],
    });
    openEditor();

    chooseLevel(0, "high");
    expect(levelValues()).toEqual(["high", "medium"]);
    expect(valueInput(0)).toHaveValue("custom-low");
    expect(savedEntries()).toEqual([
      ["high", "custom-low"],
      ["medium", "medium"],
    ]);
  });

  it("off → low 用档位默认值，low → off 用 null", () => {
    renderHarness({
      initialModels: [
        {
          id: "gw",
          reasoningEfforts: { off: null, medium: "medium" },
          rowKey: "r1",
        },
      ],
    });
    openEditor();

    chooseLevel(0, "low");
    expect(savedEntries()).toEqual([
      ["low", "low"],
      ["medium", "medium"],
    ]);
    expect(valueInput(0)).toHaveValue("low");

    chooseLevel(0, "off");
    expect(savedEntries()).toEqual([
      ["off", null],
      ["medium", "medium"],
    ]);
    expect(valueInput(0)).toBeDisabled();
    expect(valueInput(0)).toHaveValue("");
  });

  it("未知档位可以下拉修回七档之一", () => {
    renderHarness({
      initialModels: [
        {
          id: "gw",
          reasoningEfforts: { turbo: "turbo" },
          rowKey: "r1",
        },
      ],
    });
    openEditor();

    expect(levelValues()).toEqual(["turbo"]);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "turbo is not a native level",
    );
    // 未知档位排在第一位，但可以选择任一原生档位修复。
    const options = Array.from(levelSelect(0).options).map(
      (option) => option.value,
    );
    expect(options).toEqual([
      "turbo",
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);

    chooseLevel(0, "low");
    expect(savedEntries()).toEqual([["low", "low"]]);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("DSH 思考强度 · 参数值编辑", () => {
  it("清空 / 只有空白时回到档位默认值，失焦后显示默认值", () => {
    renderHarness({
      initialModels: [
        {
          id: "gw",
          reasoningEfforts: { off: null, low: "low" },
          rowKey: "r1",
        },
      ],
    });
    openEditor();

    typeValue(1, "");
    expect(valueInput(1)).toHaveValue("");
    expect(savedEntries()).toEqual([
      ["off", null],
      ["low", "low"],
    ]);

    fireEvent.blur(valueInput(1));
    expect(valueInput(1)).toHaveValue("low");

    typeValue(1, "   ");
    expect(savedEntries()).toEqual([
      ["off", null],
      ["low", "low"],
    ]);
    fireEvent.blur(valueInput(1));
    expect(valueInput(1)).toHaveValue("low");
  });

  it("自定义字符串 trim 后落盘（原生 client.js:358-364 同一个规则）", () => {
    renderHarness({
      initialModels: [
        {
          id: "gw",
          reasoningEfforts: { off: null, low: "low" },
          rowKey: "r1",
        },
      ],
    });
    openEditor();

    typeValue(1, "  high-x  ");
    expect(savedEntries()).toEqual([
      ["off", null],
      ["low", "high-x"],
    ]);
  });

  it('off 的自定义字符串保留并显示；null 不会显示成 "null"', () => {
    renderHarness({
      initialModels: [
        {
          id: "gw",
          reasoningEfforts: { off: "none", low: "low" },
          rowKey: "r1",
        },
      ],
    });
    openEditor();

    expect(valueInput(0)).toBeDisabled();
    expect(valueInput(0)).toHaveValue("none");
    fireEvent.blur(valueInput(0));
    expect(valueInput(0)).toHaveValue("none");

    cleanup();

    renderHarness({
      initialModels: [
        {
          id: "gw",
          reasoningEfforts: { off: null, low: "low" },
          rowKey: "r1",
        },
      ],
    });
    openEditor();
    expect(valueInput(0)).toHaveValue("");
    expect((valueInput(0) as HTMLInputElement).value).not.toBe("null");
  });

  it("存量脏对象不会撞渲染，显示 JSON，失焦回落到默认值", () => {
    const hostileModel = {
      id: "gw",
      reasoningEfforts: { off: null, low: { toString: 3 } },
      rowKey: "r1",
    } as unknown as DshModel;
    renderHarness({ initialModels: [hostileModel] });

    // 旧实现直接 String(wire) 会抛 TypeError: Cannot convert object…
    openEditor();
    expect(valueInput(1)).toHaveValue('{"toString":3}');
    expect(valueInput(1)).not.toBeDisabled();

    fireEvent.blur(valueInput(1));
    expect(valueInput(1)).toHaveValue("low");
    expect(savedEntries()).toEqual([
      ["off", null],
      ["low", "low"],
    ]);
  });
});

describe("DSH 思考强度 · 非法状态提示", () => {
  it("只剩 off 时显示 needsLevel 且触发器标红", () => {
    renderHarness({
      initialModels: [
        { id: "gw", reasoningEfforts: { off: null }, rowKey: "r1" },
      ],
    });

    expect(trigger()).toHaveTextContent(NEEDS_LEVELS);
    expect(trigger()).toHaveClass("text-danger-text");

    openEditor();
    expect(screen.getByRole("alert")).toHaveTextContent(NEEDS_LEVEL);
  });

  it("非 off 档位空值显示 valueRequired，并只标红那一行", () => {
    renderHarness({
      initialModels: [
        {
          id: "gw",
          reasoningEfforts: { low: "", medium: "medium" },
          rowKey: "r1",
        },
      ],
    });

    expect(trigger()).toHaveClass("text-danger-text");
    openEditor();

    expect(screen.getByRole("alert")).toHaveTextContent("low needs a value");
    expect(levelSelect(0)).toHaveAttribute("aria-invalid", "true");
    expect(valueInput(0)).toHaveAttribute("aria-invalid", "true");
    expect(levelSelect(1)).not.toHaveAttribute("aria-invalid");
    expect(valueInput(1)).not.toHaveAttribute("aria-invalid");
  });

  it("存量非法值失焦时回落到档位默认值（原生 leaveValue）", () => {
    renderHarness({
      initialModels: [
        {
          id: "gw",
          reasoningEfforts: { low: "", medium: 3 },
          rowKey: "r1",
        },
      ],
    });
    openEditor();

    expect(valueInput(0)).toHaveValue("");
    fireEvent.blur(valueInput(0));
    expect(savedEntries()).toEqual([
      ["low", "low"],
      ["medium", 3],
    ]);

    expect(valueInput(1)).toHaveValue("3");
    fireEvent.blur(valueInput(1));
    expect(savedEntries()).toEqual([
      ["low", "low"],
      ["medium", "medium"],
    ]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("合法等级表不报错、不标红", () => {
    renderHarness({
      initialModels: [
        {
          id: "gw",
          reasoningEfforts: { off: null, low: "low", max: "max" },
          rowKey: "r1",
        },
      ],
    });

    expect(trigger()).not.toHaveClass("text-danger-text");
    expect(trigger()).toHaveTextContent("off, low, max");
    openEditor();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("DSH 思考强度 · 与原生设置页一致", () => {
  it("不再有插件的预设 / 推荐 / 自适应 / 清除按钮和复选框", () => {
    renderHarness();
    enableReasoning();

    expect(screen.queryByRole("button", { name: /preset/i })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Clear reasoning levels" }),
    ).toBeNull();
    expect(screen.queryByText("Adaptive thinking on")).toBeNull();
    expect(screen.queryByText("Reasoning disabled (false)")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("未知键与顺序原样保留，编辑别的行也不会丢", () => {
    renderHarness({
      initialModels: [
        {
          id: "gw",
          reasoningEfforts: { turbo: "turbo", off: null, low: "low" },
          rowKey: "r1",
        },
      ],
    });
    openEditor();

    expect(levelValues()).toEqual(["turbo", "off", "low"]);

    typeValue(2, "ultra");
    expect(savedEntries()).toEqual([
      ["turbo", "turbo"],
      ["off", null],
      ["low", "ultra"],
    ]);

    chooseLevel(2, "medium");
    expect(savedEntries()).toEqual([
      ["turbo", "turbo"],
      ["off", null],
      ["medium", "ultra"],
    ]);
  });
});

describe("DSH 思考强度 · 官方路由不渲染该列", () => {
  it("自定义 pi-ai 路由有档位编辑入口和列头", () => {
    renderHarness();

    expect(screen.getAllByRole("button", { name: REASONING })).toHaveLength(1);
    expect(screen.getByText(REASONING)).toBeInTheDocument();
  });

  it("官方 llm-deepseek 路由没有入口/列头，已有字段原样透传", () => {
    renderHarness({
      isOfficial: true,
      initialModels: [
        {
          id: "deepseek-v4",
          reasoningEfforts: { off: null, low: "low" },
          rowKey: "r1",
        },
      ],
    });

    expect(screen.queryAllByRole("button", { name: REASONING })).toEqual([]);
    expect(screen.queryByText(REASONING)).toBeNull();
    // 模型行本身还在，只是没有编辑入口；字段不被清掉（原生 schema 也不认这个键）。
    expect(screen.getByPlaceholderText("Model ID")).toHaveValue("deepseek-v4");
    expect(savedEntries()).toEqual([
      ["off", null],
      ["low", "low"],
    ]);
  });
});
