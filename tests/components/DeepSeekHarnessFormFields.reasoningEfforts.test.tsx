/**
 * DSH 表单的「思考强度（reasoningEfforts）」用例 —— 新交互（模式下拉 + 档位芯片
 * + 折叠的 API 参数值行）。
 *
 * 数据契约见 `.tmp-local/dsh-codex-style/spec.md`：字段缺省 = 继承目录能力，
 * `false` = 声明非推理模型，非空对象 = 精确声明可用档位；切到自定义时已是
 * 普通对象就原样保留（含非法对象，不在此修复）。
 *
 * 期望值都按原生规则手抄，不反过来用实现算期望：实现改错了这里必须红。
 * helper 的纯函数单测在 `deepseekHarnessFormUtils.reasoningEfforts.test.ts`。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

// jsdom 没有 scrollIntoView；Radix Select 打开时会滚动到选中项（repo 内其他
// 用到 Radix Select 的测试同样补了这个桩，见 UsageDisplaySection.test.tsx）。
Element.prototype.scrollIntoView ??= vi.fn();

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
const MODE = "Mode";
const INHERIT_HINT_KEY = "dshReasoning.inheritHint";
const INHERIT = "Follow model catalog (default)";
const NO_REASONING = "No reasoning";
const CUSTOM = "Custom levels";
const ADVANCED = "Advanced: API parameter values";

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
function savedEntries(index = 0): Array<[string, unknown]> {
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

// Radix Select 在 jsdom 下点击 trigger 会冒泡把外层 Popover 关掉（repo 既有
// 测试同样用键盘开下拉）：ArrowDown 打开列表框，再点选项。
async function chooseMode(label: string): Promise<void> {
  fireEvent.keyDown(screen.getByRole("combobox", { name: MODE }), {
    key: "ArrowDown",
  });
  const user = userEvent.setup();
  await user.click(screen.getByRole("option", { name: label }));
}

/** 从未设置/关闭状态切到自定义档位（会播种 off/low/medium/high）。 */
async function enableCustom(): Promise<void> {
  openEditor();
  await chooseMode(CUSTOM);
}

function chip(level: string): HTMLElement {
  const found = screen.getByRole("button", { name: level });
  return found;
}

function chipPressed(level: string): boolean {
  return chip(level).getAttribute("aria-pressed") === "true";
}

function advancedToggle(): HTMLElement {
  return screen.getByRole("button", { name: ADVANCED });
}

async function openAdvanced(): Promise<void> {
  const button = advancedToggle();
  if (button.getAttribute("aria-expanded") !== "true") {
    const user = userEvent.setup();
    await user.click(button);
  }
}

function valueInput(index: number): HTMLInputElement {
  return screen.getByLabelText(`Value ${index + 1}`) as HTMLInputElement;
}

function typeValue(index: number, text: string): void {
  fireEvent.change(valueInput(index), { target: { value: text } });
}

const INITIAL_LEVELS = ["off", "low", "medium", "high"];

describe("DSH 思考强度 · 脏值摘要与面板正文", () => {
  it.each([
    ["null", null],
    ["空数组", []],
    ["字符串", "x"],
    ["数字", 1],
  ] as const)(
    "非普通对象脏值（%s）显示 needsLevelShort 且面板正文 role=alert",
    async (_name, efforts) => {
      renderHarness({
        initialModels: [
          {
            id: "gw",
            reasoningEfforts: efforts as unknown,
            rowKey: "r1",
          } as unknown as DshModel,
        ],
      });

      // 触发按钮：needsLevelShort 文案 + 现有 issue 红色。
      expect(trigger()).toHaveTextContent(NEEDS_LEVELS);
      expect(trigger()).toHaveClass("text-danger-text");

      openEditor();
      expect(screen.getByRole("alert")).toHaveTextContent(NEEDS_LEVEL);
      expect(screen.queryByText(INHERIT_HINT_KEY)).toBeNull();

      // 脏值时模式下拉已显示为自定义：Radix 对重新点选当前选中项不回调
      // onValueChange（受控 setValue 里 value === prop 直接跳过），所以真实
      // 路径是先切走（继承会清掉脏字段）再切回自定义播种默认四档。
      await chooseMode(INHERIT);
      expect(currentModel()).not.toHaveProperty("reasoningEfforts");

      await chooseMode(CUSTOM);
      expect(savedEntries()).toEqual([
        ["off", null],
        ["low", "low"],
        ["medium", "medium"],
        ["high", "high"],
      ]);
    },
  );

  it("undefined 仍显示 notSet 摘要与 inheritHint 正文", async () => {
    renderHarness();

    expect(trigger()).toHaveTextContent(NOT_SET);
    expect(trigger()).not.toHaveClass("text-danger-text");

    openEditor();
    expect(screen.queryByRole("alert")).toBeNull();
    // 测试环境 i18n 资源为空：不带 defaultValue 的 t() 原样返回 key，
    // inheritHint 正文正好用它断言（避免绑死任何语言的具体文案）。
    expect(screen.getByText(INHERIT_HINT_KEY)).toBeInTheDocument();
  });

  it("false 仍显示 disabled 摘要与 disabled 正文", async () => {
    renderHarness({
      initialModels: [{ id: "o3", reasoningEfforts: false, rowKey: "r1" }],
    });

    expect(trigger()).toHaveTextContent(DISABLED);
    expect(trigger()).not.toHaveClass("text-danger-text");

    openEditor();
    expect(screen.queryByRole("alert")).toBeNull();
    // 触发按钮与面板正文都是「已禁用」，正文那条有专属 class，用它定位。
    const bodyHints = screen.getAllByText(DISABLED);
    expect(bodyHints).toHaveLength(2);
    expect(bodyHints[1]).toHaveClass("text-fg-3");
  });
});

describe("DSH 思考强度 · 模式下拉", () => {
  it("默认未设置；切到自定义播种 off/low/medium/high 并落盘", async () => {
    renderHarness();

    expect(trigger()).toHaveTextContent(NOT_SET);
    expect(currentModel()).not.toHaveProperty("reasoningEfforts");

    await enableCustom();

    for (const level of INITIAL_LEVELS) {
      expect(chipPressed(level)).toBe(true);
    }
    expect(chipPressed("minimal")).toBe(false);
    expect(chipPressed("xhigh")).toBe(false);
    expect(chipPressed("max")).toBe(false);

    // off 不发参数，输入框（折叠区里）禁用且留空；其余默认等于档位名。
    await openAdvanced();
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

  it("模式下拉的 listbox 带 z-[1100]，盖过外层 z-[1000] 的 Popover", async () => {
    renderHarness();

    await enableCustom();

    // 重新打开模式下拉，检查 listbox 容器的层级类（jsdom 不算样式，只断言类名）。
    fireEvent.keyDown(screen.getByRole("combobox", { name: MODE }), {
      key: "ArrowDown",
    });
    const listbox = screen.getByRole("listbox");
    expect(listbox.className).toContain("z-[1100]");
  });

  it("切到「不支持思考」写 false；再切回「跟随」删除字段", async () => {
    renderHarness();

    await enableCustom();
    expect(currentModel()).toHaveProperty("reasoningEfforts");

    await chooseMode(NO_REASONING);
    expect(currentModel().reasoningEfforts).toBe(false);
    expect(trigger()).toHaveTextContent(DISABLED);

    await chooseMode(INHERIT);
    expect(currentModel()).not.toHaveProperty("reasoningEfforts");
    expect(JSON.stringify(currentModel())).not.toContain("reasoningEfforts");
    expect(trigger()).toHaveTextContent(NOT_SET);
  });

  it("存量 false 切到自定义播种默认四档", async () => {
    renderHarness({
      initialModels: [{ id: "o3", reasoningEfforts: false, rowKey: "r1" }],
    });
    expect(trigger()).toHaveTextContent(DISABLED);

    await enableCustom();
    expect(savedEntries()).toEqual([
      ["off", null],
      ["low", "low"],
      ["medium", "medium"],
      ["high", "high"],
    ]);
  });

  it("已是对象（含非法）时切到自定义原样保留，未知档位以选中芯片展示", async () => {
    renderHarness({
      initialModels: [
        { id: "gw", reasoningEfforts: { turbo: "turbo" }, rowKey: "r1" },
      ],
    });

    await enableCustom();

    expect(savedEntries()).toEqual([["turbo", "turbo"]]);
    expect(chipPressed("turbo")).toBe(true);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "turbo is not a native level",
    );
    expect(trigger()).toHaveTextContent(NEEDS_LEVELS);
  });
});

describe("DSH 思考强度 · 档位芯片", () => {
  it("点选芯片按规范序插入默认值，再点一次移除", async () => {
    renderHarness({
      initialModels: [
        { id: "gw", reasoningEfforts: { low: "low" }, rowKey: "r1" },
      ],
    });
    await enableCustom();
    await openAdvanced();

    const user = userEvent.setup();
    // high 的规范序号比 low 大，插不到前面 → 追加到末尾。
    await user.click(chip("high"));
    expect(savedEntries()).toEqual([
      ["low", "low"],
      ["high", "high"],
    ]);

    // off 插到首个规范序号更大的档位（low）之前。
    await user.click(chip("off"));
    expect(savedEntries()).toEqual([
      ["off", null],
      ["low", "low"],
      ["high", "high"],
    ]);
    expect(valueInput(0)).toBeDisabled();

    // 再点一次 = 移除，其余条目原样保留。
    await user.click(chip("low"));
    expect(savedEntries()).toEqual([
      ["off", null],
      ["high", "high"],
    ]);
  });

  it("取消所有芯片得到 {} 并显示 needsLevel（保存拦截交给 ProviderForm）", async () => {
    renderHarness();
    await enableCustom();

    const user = userEvent.setup();
    for (const level of INITIAL_LEVELS) {
      await user.click(chip(level));
    }

    expect(JSON.stringify(currentModel().reasoningEfforts)).toBe("{}");
    expect(screen.getByRole("alert")).toHaveTextContent(NEEDS_LEVEL);
    expect(trigger()).toHaveTextContent(NEEDS_LEVELS);
  });

  it("点击未知档位芯片即移除该键", async () => {
    renderHarness({
      initialModels: [
        { id: "gw", reasoningEfforts: { turbo: "turbo" }, rowKey: "r1" },
      ],
    });
    await enableCustom();

    const user = userEvent.setup();
    await user.click(chip("turbo"));
    expect(JSON.stringify(currentModel().reasoningEfforts)).toBe("{}");
    expect(screen.getByRole("alert")).toHaveTextContent(NEEDS_LEVEL);
  });
});

describe("DSH 思考强度 · 高级：API 参数值", () => {
  it("折叠区默认收起；展开后 off 输入框禁用", async () => {
    renderHarness();
    await enableCustom();

    expect(advancedToggle()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("Value 1")).toBeNull();

    await openAdvanced();
    expect(advancedToggle()).toHaveAttribute("aria-expanded", "true");
    expect(valueInput(0)).toBeDisabled();
    expect(valueInput(0)).toHaveValue("");
    expect(valueInput(1)).not.toBeDisabled();
    expect(valueInput(1)).toHaveValue("low");
  });

  it("编辑参数值即时写回并 trim", async () => {
    renderHarness();
    await enableCustom();
    await openAdvanced();

    typeValue(1, "  high-x  ");
    expect(savedEntries()).toEqual([
      ["off", null],
      ["low", "high-x"],
      ["medium", "medium"],
      ["high", "high"],
    ]);
  });

  it("清空 / 只有空白时失焦回落到档位默认值", async () => {
    renderHarness();
    await enableCustom();
    await openAdvanced();

    typeValue(1, "");
    expect(valueInput(1)).toHaveValue("");
    expect(savedEntries()[1]).toEqual(["low", "low"]);

    fireEvent.blur(valueInput(1));
    expect(valueInput(1)).toHaveValue("low");

    typeValue(1, "   ");
    fireEvent.blur(valueInput(1));
    expect(valueInput(1)).toHaveValue("low");
    expect(savedEntries()[1]).toEqual(["low", "low"]);
  });

  it("存量脏对象不会撞渲染，显示 JSON，失焦回落到默认值", async () => {
    const hostileModel = {
      id: "gw",
      reasoningEfforts: { off: null, low: { toString: 3 } },
      rowKey: "r1",
    } as unknown as DshModel;
    renderHarness({ initialModels: [hostileModel] });

    await enableCustom();
    await openAdvanced();
    expect(valueInput(1)).toHaveValue('{"toString":3}');
    expect(valueInput(1)).not.toBeDisabled();

    fireEvent.blur(valueInput(1));
    expect(valueInput(1)).toHaveValue("low");
    expect(savedEntries()).toEqual([
      ["off", null],
      ["low", "low"],
    ]);
  });

  it("非 off 档位空值显示 valueRequired，并只标红那一行", async () => {
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
    await enableCustom();
    await openAdvanced();

    expect(screen.getByRole("alert")).toHaveTextContent("low needs a value");
    expect(valueInput(0)).toHaveAttribute("aria-invalid", "true");
    expect(valueInput(1)).not.toHaveAttribute("aria-invalid");
  });
});

describe("DSH 思考强度 · 字节级保留", () => {
  it("只开面板 / 折叠区不改存量字段；其余模型字段一字不动", async () => {
    renderHarness({
      initialModels: [
        {
          id: "gw",
          name: "Sol",
          baseUrl: "https://api.example.com/v1",
          reasoningEfforts: { low: "custom-low", turbo: "turbo" },
          rowKey: "r1",
        },
      ],
    });
    const before = JSON.stringify(currentModel());

    await enableCustom();
    await openAdvanced();
    // 再收起折叠区。
    const user = userEvent.setup();
    await user.click(advancedToggle());

    expect(JSON.stringify(currentModel())).toBe(before);
    expect(savedEntries()).toEqual([
      ["low", "custom-low"],
      ["turbo", "turbo"],
    ]);
  });

  it("已是对象时切到自定义不重排、不修复，键序原样", async () => {
    renderHarness({
      initialModels: [
        {
          id: "gw",
          reasoningEfforts: { turbo: "turbo", off: null, low: "low" },
          rowKey: "r1",
        },
      ],
    });
    const before = JSON.stringify(currentModel());

    await enableCustom();

    expect(JSON.stringify(currentModel())).toBe(before);
    expect(chipPressed("turbo")).toBe(true);
    expect(chipPressed("low")).toBe(true);
  });
});

describe("DSH 思考强度 · 官方路由不渲染该列", () => {
  it("自定义 pi-ai 路由有编辑入口和列头", () => {
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
