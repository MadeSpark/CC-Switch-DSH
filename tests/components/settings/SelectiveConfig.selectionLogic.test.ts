import { describe, expect, it } from "vitest";
import {
  buildCatalogGroups,
  countSelected,
  defaultSelection,
  groupCheckedState,
  overallCheckedState,
  toggleAll,
  toggleGroup,
  toggleItem,
} from "@/components/settings/selective-config/selectionLogic";
import type {
  CatalogCustomApp,
  SelectiveCatalog,
} from "@/lib/api/selectiveConfig";

function makeCatalog(): SelectiveCatalog {
  return {
    providers: [
      {
        appType: "claude",
        items: [
          { id: "p1", name: "P1" },
          { id: "p2", name: "P2" },
        ],
      },
      { appType: "codex", items: [{ id: "p3", name: "P3" }] },
    ],
    customApps: [
      {
        id: "custom-1",
        name: "爱丽",
        icon: null,
        iconColor: null,
        providers: [{ id: "cp1", name: "CP1" }],
        exists: true,
      },
    ],
    modelPricing: [{ id: "m1", name: "M1", detail: null }],
    modelPresets: [{ id: "preset1", name: "Preset1", detail: null }],
    hasGenericPreset: true,
  };
}

function customApp(id: string, exists: boolean | null): CatalogCustomApp {
  return {
    id,
    name: id,
    icon: null,
    iconColor: null,
    providers: [],
    exists,
  };
}

describe("buildCatalogGroups", () => {
  it("builds groups in catalog order with synthetic custom-app items", () => {
    const groups = buildCatalogGroups(makeCatalog()).groups;
    expect(groups.map((g) => g.id)).toEqual([
      "providers:claude",
      "providers:codex",
      "customApp:custom-1",
      "modelPricing",
      "modelPresets",
      "genericPreset",
    ]);
    // 自定义应用组的合成 item 必须是 {id, name, exists}，不含 providers
    const customGroup = groups[2];
    expect(customGroup.items).toEqual([
      { id: "custom-1", name: "爱丽", exists: true },
    ]);
    expect(customGroup.label).toBe("爱丽");
    // 布尔组 items 为空
    expect(groups[5].items).toEqual([]);
    expect(groups[5].isBoolean).toBe(true);
  });

  it("skips empty provider groups and absent plain groups", () => {
    const catalog = makeCatalog();
    catalog.providers.push({ appType: "empty-app", items: [] });
    catalog.modelPricing = [];
    const groups = buildCatalogGroups(catalog).groups;
    expect(groups.map((g) => g.id)).not.toContain("providers:empty-app");
    expect(groups.map((g) => g.id)).not.toContain("modelPricing");
  });
});

describe("defaultSelection", () => {
  it("selects every item including custom apps", () => {
    const catalog = makeCatalog();
    const selection = defaultSelection(catalog);
    expect(selection).toEqual({
      providers: { claude: ["p1", "p2"], codex: ["p3"] },
      customApps: ["custom-1"],
      modelPricing: ["m1"],
      modelPresets: ["preset1"],
      genericPreset: true,
    });
  });
});

describe("groupCheckedState", () => {
  it("reports full / partial / empty states per group", () => {
    const catalog = makeCatalog();
    const groups = buildCatalogGroups(catalog).groups;
    const full = defaultSelection(catalog);
    expect(groupCheckedState(groups[0], full)).toBe(true);
    expect(groupCheckedState(groups[2], full)).toBe(true);
    expect(groupCheckedState(groups[5], full)).toBe(true);

    const partial = defaultSelection(catalog);
    partial.providers.claude = ["p1"];
    expect(groupCheckedState(groups[0], partial)).toBe("indeterminate");

    const none = defaultSelection(catalog);
    none.providers.claude = [];
    none.genericPreset = false;
    expect(groupCheckedState(groups[0], none)).toBe(false);
    expect(groupCheckedState(groups[5], none)).toBe(false);
  });
});

describe("toggleGroup", () => {
  it("selects the whole group from unchecked state", () => {
    const catalog = makeCatalog();
    const groups = buildCatalogGroups(catalog).groups;
    const selection = defaultSelection(catalog);
    selection.modelPricing = [];
    const next = toggleGroup(groups[3], selection, true);
    expect(next.modelPricing).toEqual(["m1"]);
  });

  it("deselects the whole group with explicit false", () => {
    const catalog = makeCatalog();
    const groups = buildCatalogGroups(catalog).groups;
    const selection = defaultSelection(catalog);
    const next = toggleGroup(groups[0], selection, false);
    expect(next.providers.claude).toEqual([]);
    expect(next.providers.codex).toEqual(["p3"]);
    expect(next.customApps).toEqual(["custom-1"]);
  });

  it("toggles the custom app as a single unit", () => {
    const catalog = makeCatalog();
    const groups = buildCatalogGroups(catalog).groups;
    const selection = defaultSelection(catalog);
    const next = toggleGroup(groups[2], selection, false);
    expect(next.customApps).toEqual([]);
    const back = toggleGroup(groups[2], next, true);
    expect(back.customApps).toEqual(["custom-1"]);
  });

  it("simulates the checkbox emission in indeterminate state: false means select all", () => {
    // 原生 input 在半选态渲染 checked=false，点击发出 false；
    // 组件层负责把半选态的 false 转成 true（全选）。
    const catalog = makeCatalog();
    const groups = buildCatalogGroups(catalog).groups;
    const selection = defaultSelection(catalog);
    selection.providers.claude = ["p1"]; // indeterminate
    // 模拟 checkbox 发出 false，组件层转换后的行为与 true 一致
    expect(toggleGroup(groups[0], selection, true).providers.claude).toEqual([
      "p1",
      "p2",
    ]);
  });
});

describe("toggleItem", () => {
  it("toggles one provider within a group", () => {
    const catalog = makeCatalog();
    const groups = buildCatalogGroups(catalog).groups;
    const selection = defaultSelection(catalog);
    const next = toggleItem(groups[0], "p1", selection);
    expect(next.providers.claude).toEqual(["p2"]);
    const back = toggleItem(groups[0], "p1", next);
    // toggleItem 用 Set 去重，不保证顺序，只断言集合内容
    expect(back.providers.claude.sort()).toEqual(["p1", "p2"]);
  });

  it("toggles the custom app synthetic item", () => {
    const catalog = makeCatalog();
    const groups = buildCatalogGroups(catalog).groups;
    const selection = defaultSelection(catalog);
    const next = toggleItem(groups[2], "custom-1", selection);
    expect(next.customApps).toEqual([]);
    const back = toggleItem(groups[2], "custom-1", next);
    expect(back.customApps).toEqual(["custom-1"]);
  });
});

describe("toggleAll", () => {
  it("propagates explicit true / false across all groups", () => {
    const catalog = makeCatalog();
    const groups = buildCatalogGroups(catalog).groups;
    const full = toggleAll(groups, defaultSelection(catalog), true);
    expect(countSelected(groups, full)).toBe(7);

    const empty = toggleAll(groups, defaultSelection(catalog), false);
    expect(countSelected(groups, empty)).toBe(0);
    expect(empty.genericPreset).toBe(false);
    expect(empty.customApps).toEqual([]);
    expect(empty.providers.claude).toEqual([]);
  });
});

describe("overallCheckedState", () => {
  it("is true when everything is selected, false when empty, indeterminate in between", () => {
    const catalog = makeCatalog();
    const groups = buildCatalogGroups(catalog).groups;
    const full = defaultSelection(catalog);
    expect(overallCheckedState(groups, full)).toBe(true);

    const partial = { ...full, customApps: [] };
    expect(overallCheckedState(groups, partial)).toBe("indeterminate");

    const empty = toggleAll(groups, full, false);
    expect(overallCheckedState(groups, empty)).toBe(false);
  });

  it("stays false for an empty catalog", () => {
    const groups = buildCatalogGroups({
      providers: [],
      customApps: [],
      modelPricing: [],
      modelPresets: [],
      hasGenericPreset: false,
    }).groups;
    expect(groups).toEqual([]);
    expect(
      overallCheckedState(groups, {
        providers: {},
        customApps: [],
        modelPricing: [],
        modelPresets: [],
        genericPreset: false,
      }),
    ).toBe(false);
  });
});

describe("countSelected", () => {
  it("counts providers, custom apps, pricing, presets and generic preset", () => {
    const catalog = makeCatalog();
    const groups = buildCatalogGroups(catalog).groups;
    expect(countSelected(groups, defaultSelection(catalog))).toBe(7);

    const onlyCustom = {
      providers: {},
      customApps: ["custom-1"],
      modelPricing: [],
      modelPresets: [],
      genericPreset: false,
    };
    expect(countSelected(groups, onlyCustom)).toBe(1);
  });
});

describe("custom app exists propagation", () => {
  it("keeps exists on the synthetic item for import preview badges", () => {
    const catalog = makeCatalog();
    catalog.customApps = [
      customApp("app-yes", true),
      customApp("app-null", null),
    ];
    const { groups, customAppGroups } = buildCatalogGroups(catalog);
    // 自定义应用组排在 provider 组之后
    const customIds = groups
      .map((g) => g.id)
      .filter((id) => id.startsWith("customApp:"));
    expect(customIds).toEqual(["customApp:app-yes", "customApp:app-null"]);
    const g0 = groups.find((g) => g.id === "customApp:app-yes");
    const g1 = groups.find((g) => g.id === "customApp:app-null");
    expect(g0?.items[0]).toEqual({
      id: "app-yes",
      name: "app-yes",
      exists: true,
    });
    expect(g1?.items[0]).toEqual({
      id: "app-null",
      name: "app-null",
      exists: null,
    });
    expect(customAppGroups[0].data.exists).toBe(true);
    expect(customAppGroups[1].data.exists).toBe(null);
  });
});
