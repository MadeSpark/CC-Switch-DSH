/**
 * `deepseekHarnessFormUtils` 里与 `reasoningEfforts` 相关的纯函数单测。
 *
 * 这些函数把 DSH 44.7 原生 schema 翻成表单可编辑的结构：读取保序保未知键、
 * 换档按原生规则保留自定义参数值、校验按原生顺序报错、规范化不静默丢数据。
 */
import { describe, expect, it } from "vitest";
import {
  DSH_REASONING_INITIAL_LEVELS,
  DSH_REASONING_LEVELS,
  dshReasoningDefaultValue,
  dshReasoningInitialEntries,
  dshReasoningIssue,
  dshReasoningLevelChoices,
  dshReasoningNextLevel,
  dshReasoningWithLevel,
  dshReasoningWithWire,
  findDshReasoningIssue,
  findDshReasoningIssueInConfig,
  formatDshReasoningLevelsLabel,
  formatDshReasoningWire,
  normalizeDshModels,
  readDshReasoningEntries,
} from "@/components/providers/forms/helpers/deepseekHarnessFormUtils";
import type {
  DshModel,
  DshReasoningEntries,
} from "@/components/providers/forms/helpers/deepseekHarnessFormUtils";

const INITIAL: DshReasoningEntries = [
  ["off", null],
  ["low", "low"],
  ["medium", "medium"],
  ["high", "high"],
];

describe("档位常量", () => {
  it("七档顺序固定为 off → max", () => {
    expect(DSH_REASONING_LEVELS).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("原生初始档位是 off/low/medium/high", () => {
    expect(DSH_REASONING_INITIAL_LEVELS).toEqual([
      "off",
      "low",
      "medium",
      "high",
    ]);
  });

  it("off 的默认参数值是 null，其余是档位名", () => {
    expect(dshReasoningDefaultValue("off")).toBeNull();
    expect(dshReasoningDefaultValue("minimal")).toBe("minimal");
    expect(dshReasoningDefaultValue("max")).toBe("max");
  });

  it("初始表按原生顺序播种", () => {
    expect(dshReasoningInitialEntries()).toEqual(INITIAL);
  });
});

describe("readDshReasoningEntries", () => {
  it("缺省 / false / null / 数组 / 标量都读不成等级表", () => {
    expect(readDshReasoningEntries(undefined)).toBeUndefined();
    expect(readDshReasoningEntries(false)).toBeUndefined();
    expect(readDshReasoningEntries(null)).toBeUndefined();
    expect(readDshReasoningEntries([])).toBeUndefined();
    expect(readDshReasoningEntries("low")).toBeUndefined();
    expect(readDshReasoningEntries(3)).toBeUndefined();
  });

  it("保留键顺序、未知键与所有原值类型（坏值交给校验标错）", () => {
    expect(
      readDshReasoningEntries({
        turbo: "turbo",
        off: null,
        low: "",
        medium: 3,
        high: true,
      }),
    ).toEqual([
      ["turbo", "turbo"],
      ["off", null],
      ["low", ""],
      ["medium", 3],
      ["high", true],
    ]);
  });

  it("空对象读成空表（不是 undefined）", () => {
    expect(readDshReasoningEntries({})).toEqual([]);
  });
});

describe("dshReasoningNextLevel", () => {
  it("初始四档之后补 xhigh（高于最高已用档位的第一个未用）", () => {
    expect(dshReasoningNextLevel(INITIAL.map(([level]) => level))).toBe(
      "xhigh",
    );
  });

  it("高点已用满时回头补最小空档", () => {
    expect(
      dshReasoningNextLevel(["off", "low", "medium", "high", "xhigh", "max"]),
    ).toBe("minimal");
    expect(dshReasoningNextLevel(["off", "minimal", "low"])).toBe("medium");
  });

  it("只有未知档位时从最小档开始", () => {
    expect(dshReasoningNextLevel(["turbo"])).toBe("off");
    expect(dshReasoningNextLevel([])).toBe("off");
  });

  it("七档用完返回 undefined", () => {
    expect(dshReasoningNextLevel([...DSH_REASONING_LEVELS])).toBeUndefined();
  });
});

describe("dshReasoningLevelChoices", () => {
  it("当前档位属于七档时按七档顺序排在原位，不置顶（原生 client.js:370）", () => {
    expect(dshReasoningLevelChoices("medium", ["medium"])).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(dshReasoningLevelChoices("low", ["off", "low", "high"])).toEqual([
      "minimal",
      "low",
      "medium",
      "xhigh",
      "max",
    ]);
  });

  it("未知档位 / 空串才排第一，保证不会被静默改掉", () => {
    expect(dshReasoningLevelChoices("venus", ["venus"])).toEqual([
      "venus",
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(dshReasoningLevelChoices("turbo", ["turbo", "low"])[0]).toBe(
      "turbo",
    );
    expect(dshReasoningLevelChoices("", [""])[0]).toBe("");
  });

  it("未知档位后面只补没被占用的七档", () => {
    expect(dshReasoningLevelChoices("venus", ["venus", "off", "high"])).toEqual(
      ["venus", "minimal", "low", "medium", "xhigh", "max"],
    );
  });
});

describe("dshReasoningWithLevel", () => {
  it("自定义参数值在非 off 之间换档时保留", () => {
    const entries: DshReasoningEntries = [
      ["low", "gateway-low"],
      ["medium", "medium"],
    ];
    expect(dshReasoningWithLevel(entries, 0, "high")).toEqual([
      ["high", "gateway-low"],
      ["medium", "medium"],
    ]);
    // 不改原数组
    expect(entries[0]).toEqual(["low", "gateway-low"]);
  });

  it("参数值等于旧档位名（默认值）时换成新档位名", () => {
    expect(dshReasoningWithLevel(INITIAL, 1, "xhigh")).toEqual([
      ["off", null],
      ["xhigh", "xhigh"],
      ["medium", "medium"],
      ["high", "high"],
    ]);
  });

  it("从 off 换出、或换到 off 都重算默认值", () => {
    const fromOff: DshReasoningEntries = [
      ["off", "none"],
      ["low", "low"],
    ];
    expect(dshReasoningWithLevel(fromOff, 0, "low")[0]).toEqual(["low", "low"]);
    expect(dshReasoningWithLevel(INITIAL, 1, "off")[1]).toEqual(["off", null]);
  });

  it("空串不当作自定义值；纯空白按原生 length>0 原样保留", () => {
    const entries: DshReasoningEntries = [
      ["low", ""],
      ["high", "   "],
    ];
    expect(dshReasoningWithLevel(entries, 0, "medium")[0]).toEqual([
      "medium",
      "medium",
    ]);
    // 原生 changeLevel 用 wire.length > 0 判空，换档时不 trim、不擅改坏值；
    // 纯空白会在失焦时由 leaveValue 复位。
    expect(dshReasoningWithLevel(entries, 1, "max")[1]).toEqual([
      "max",
      "   ",
    ]);
  });

  it("索引越界时原样返回", () => {
    expect(dshReasoningWithLevel(INITIAL, 9, "low")).toEqual(INITIAL);
  });
});

describe("dshReasoningWithWire", () => {
  it("非空输入 trim 后写入（原生 client.js:358-364）", () => {
    expect(dshReasoningWithWire(INITIAL, 1, "  high-x  ")).toEqual([
      ["off", null],
      ["low", "high-x"],
      ["medium", "medium"],
      ["high", "high"],
    ]);
    // 不改原数组
    expect(INITIAL[1]).toEqual(["low", "low"]);
  });

  it("空串 / 只有空白回到档位默认值", () => {
    expect(dshReasoningWithWire(INITIAL, 1, "")[1]).toEqual(["low", "low"]);
    expect(dshReasoningWithWire(INITIAL, 1, "   ")[1]).toEqual(["low", "low"]);
    expect(dshReasoningWithWire(INITIAL, 0, "")[0]).toEqual(["off", null]);
  });

  it("索引越界时原样返回", () => {
    expect(dshReasoningWithWire(INITIAL, -1, "x")).toEqual(INITIAL);
  });
});

describe("dshReasoningIssue", () => {
  it("缺省与 false 合法（继承 / 非推理模型）", () => {
    expect(dshReasoningIssue(undefined)).toBeUndefined();
    expect(dshReasoningIssue(false)).toBeUndefined();
  });

  it("合法等级表不报错", () => {
    expect(dshReasoningIssue({ off: null, low: "low" })).toBeUndefined();
    expect(
      dshReasoningIssue({ off: null, low: "low", max: "max" }),
    ).toBeUndefined();
  });

  it("null / 数组 / 空对象都算缺少档位", () => {
    expect(dshReasoningIssue(null)).toEqual({ kind: "needsLevel" });
    expect(dshReasoningIssue([])).toEqual({ kind: "needsLevel" });
    expect(dshReasoningIssue({})).toEqual({ kind: "needsLevel" });
    expect(dshReasoningIssue({ off: null })).toEqual({ kind: "needsLevel" });
  });

  it("非 off 档位的空值报 valueRequired", () => {
    expect(dshReasoningIssue({ low: "" })).toEqual({
      kind: "valueRequired",
      level: "low",
    });
    expect(dshReasoningIssue({ low: "   " })).toEqual({
      kind: "valueRequired",
      level: "low",
    });
    // null 只允许给 off
    expect(dshReasoningIssue({ low: null, high: "high" })).toEqual({
      kind: "valueRequired",
      level: "low",
    });
  });

  it("七档之外的键报 unknownLevel", () => {
    expect(dshReasoningIssue({ turbo: "turbo" })).toEqual({
      kind: "unknownLevel",
      level: "turbo",
    });
    expect(dshReasoningIssue({ "": "x" })).toEqual({
      kind: "unknownLevel",
      level: "",
    });
  });

  it("按原生顺序：先查值、再查档位名、最后查是否只剩 off", () => {
    expect(dshReasoningIssue({ turbo: "", low: "low" })).toEqual({
      kind: "valueRequired",
      level: "turbo",
    });
  });
});

describe("findDshReasoningIssue", () => {
  const models = [
    { id: "a", reasoningEfforts: false },
    { id: "b" },
    { id: "c", reasoningEfforts: { off: null } },
    { id: "d", reasoningEfforts: { turbo: "turbo" } },
  ] as DshModel[];

  it("按模型顺序返回第一个非法行", () => {
    expect(findDshReasoningIssue(models)).toEqual({
      modelId: "c",
      issue: { kind: "needsLevel" },
    });
  });

  it("全部合法时返回 undefined", () => {
    expect(
      findDshReasoningIssue([
        { id: "a", reasoningEfforts: false },
        { id: "b", reasoningEfforts: { off: null, low: "low" } },
      ]),
    ).toBeUndefined();
  });

  it("跳过空 ID 行：保存时这些行会被 prune 掉，不能误拦", () => {
    const withBlankRows = [
      { id: "  ", reasoningEfforts: {} },
      { id: "", reasoningEfforts: { low: "" } },
      { id: 1, reasoningEfforts: { turbo: "turbo" } },
      { id: "ok", reasoningEfforts: { low: "low" } },
    ] as unknown as DshModel[];

    expect(findDshReasoningIssue(withBlankRows)).toBeUndefined();
  });

  it("空 ID 行后面还有非法行时，报后面那个", () => {
    const models = [
      { id: "", reasoningEfforts: {} },
      { id: "c", reasoningEfforts: { off: null } },
    ] as DshModel[];

    expect(findDshReasoningIssue(models)).toEqual({
      modelId: "c",
      issue: { kind: "needsLevel" },
    });
  });
});

describe("findDshReasoningIssueInConfig", () => {
  it("直接检查原始 config JSON，手工粘贴的非法值也能发现", () => {
    expect(
      findDshReasoningIssueInConfig({
        models: [
          { id: "ok", reasoningEfforts: { low: "low" } },
          { id: "bad", reasoningEfforts: { low: "low", turbo: "turbo" } },
        ],
      }),
    ).toEqual({
      modelId: "bad",
      issue: { kind: "unknownLevel", level: "turbo" },
    });
  });

  it("跳过空 ID 行，只有带 ID 的行才拦", () => {
    expect(
      findDshReasoningIssueInConfig({
        models: [
          { id: "", reasoningEfforts: {} },
          { id: "   ", reasoningEfforts: { turbo: "turbo" } },
          { reasoningEfforts: { low: "" } },
          { id: "ok", reasoningEfforts: { low: "low" } },
        ],
      }),
    ).toBeUndefined();
  });

  it("config 形态不对时直接放过", () => {
    expect(findDshReasoningIssueInConfig(undefined)).toBeUndefined();
    expect(findDshReasoningIssueInConfig(null)).toBeUndefined();
    expect(findDshReasoningIssueInConfig("x")).toBeUndefined();
    expect(findDshReasoningIssueInConfig({})).toBeUndefined();
    expect(findDshReasoningIssueInConfig({ models: {} })).toBeUndefined();
    expect(
      findDshReasoningIssueInConfig({ models: [null, 3] }),
    ).toBeUndefined();
  });
});

describe("normalizeDshModels 的 reasoningEfforts 原样透传", () => {
  it("非法值不被丢弃，保存校验仍能看到（审计 T5 第 2 点）", () => {
    const models = normalizeDshModels([
      { id: "bad", reasoningEfforts: { low: 3, high: "high" } },
    ]);
    expect(models[0].reasoningEfforts).toEqual({ low: 3, high: "high" });
    expect(findDshReasoningIssue(models)).toEqual({
      modelId: "bad",
      issue: { kind: "valueRequired", level: "low" },
    });
  });

  it("{} / null / 数组 / true / 标量都原样深拷贝，只有 undefined 省略", () => {
    const raw = { low: 3, nested: { value: "keep" } };
    const models = normalizeDshModels([
      { id: "empty", reasoningEfforts: {} },
      { id: "null", reasoningEfforts: null },
      { id: "array", reasoningEfforts: ["low"] },
      { id: "true", reasoningEfforts: true },
      { id: "scalar", reasoningEfforts: "low" },
      { id: "raw", reasoningEfforts: raw },
      { id: "absent" },
    ]);
    expect(models[0].reasoningEfforts).toEqual({});
    expect(models[1].reasoningEfforts).toBeNull();
    expect(models[2].reasoningEfforts).toEqual(["low"]);
    expect(models[3].reasoningEfforts).toBe(true);
    expect(models[4].reasoningEfforts).toBe("low");
    expect(models[5].reasoningEfforts).toEqual(raw);
    expect(models[6]).not.toHaveProperty("reasoningEfforts");
    // deep copy：改生成值不能反写原始输入。
    (models[5].reasoningEfforts as { nested: { value: string } }).nested.value =
      "changed";
    expect(raw.nested.value).toBe("keep");
  });

  it("键顺序、未知键、compat/input 等其余字段保持原样", () => {
    const [model] = normalizeDshModels([
      {
        id: " m1 ",
        name: "",
        contextWindow: 0,
        reasoningEfforts: { turbo: "turbo", off: null },
        compat: { forceAdaptiveThinking: true },
        input: ["text"],
        futureField: { a: 1 },
      },
    ]);
    expect(model.id).toBe("m1");
    expect(model).not.toHaveProperty("name");
    expect(model.contextWindow).toBe(0);
    expect(Object.keys(model.reasoningEfforts as object)).toEqual([
      "turbo",
      "off",
    ]);
    expect(model.compat).toEqual({ forceAdaptiveThinking: true });
    expect(model.input).toEqual(["text"]);
    expect(model.futureField).toEqual({ a: 1 });
  });
});

describe("formatDshReasoningLevelsLabel", () => {
  it("连续三档及以上折叠成区间", () => {
    expect(formatDshReasoningLevelsLabel(["low", "medium", "high"])).toBe(
      "low → high",
    );
    expect(
      formatDshReasoningLevelsLabel(["off", "low", "medium", "high"]),
    ).toBe("off, low → high");
  });

  it("两档不折叠，断开的档位原样用逗号拼接", () => {
    expect(formatDshReasoningLevelsLabel(["low", "high"])).toBe("low, high");
    expect(formatDshReasoningLevelsLabel(["off", "medium", "max"])).toBe(
      "off, medium, max",
    );
  });

  it("非七档顺序（网关自定义等级）原样拼接", () => {
    expect(formatDshReasoningLevelsLabel(["turbo", "low"])).toBe("turbo, low");
    expect(formatDshReasoningLevelsLabel(["low", "off"])).toBe("low, off");
  });

  it("空表拼成空串", () => {
    expect(formatDshReasoningLevelsLabel([])).toBe("");
  });
});

describe("formatDshReasoningWire", () => {
  it("字符串原样、null/undefined 为空", () => {
    expect(formatDshReasoningWire("high")).toBe("high");
    expect(formatDshReasoningWire(null)).toBe("");
    expect(formatDshReasoningWire(undefined)).toBe("");
  });

  it("非字符串标量安全转文本", () => {
    expect(formatDshReasoningWire(3)).toBe("3");
    expect(formatDshReasoningWire(false)).toBe("false");
    expect(formatDshReasoningWire(1n)).toBe("1");
  });

  it("对象和数组用 JSON 展示，不触发恶意 toString", () => {
    expect(formatDshReasoningWire({ toString: 3 })).toBe('{"toString":3}');
    expect(formatDshReasoningWire(["low", null])).toBe('["low",null]');
  });

  it("JSON 和字符串转换都抛错时回落到空串", () => {
    const hostile = {
      toJSON() {
        throw new Error("toJSON");
      },
      toString() {
        throw new Error("toString");
      },
    };
    expect(formatDshReasoningWire(hostile)).toBe("");
  });
});
