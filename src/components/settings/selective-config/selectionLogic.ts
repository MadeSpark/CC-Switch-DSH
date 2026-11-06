import type {
  CatalogAppGroup,
  CatalogCustomApp,
  CatalogItem,
  SelectiveCatalog,
  SelectiveSelection,
} from "@/lib/api/selectiveConfig";

/**
 * 选择性导出 / 导入的纯选择逻辑：默认全选、组三态、计数、构建 SelectiveSelection。
 * 全部是无副作用函数，便于单元测试；组件层只做事件转接。
 */

export type GroupId =
  | `providers:${string}`
  | `customApp:${string}`
  | "modelPricing"
  | "modelPresets"
  | "genericPreset";

export interface GroupNode {
  id: GroupId;
  /** 组名（组件层负责 i18n / 应用名） */
  label: string;
  /** 组内全部 item id（genericPreset 组恒为空，用 flag 表达单项） */
  items: CatalogItem[];
  /** 通用参数模板这种单布尔组 */
  isBoolean?: boolean;
}

/** 目录 → 可选组列表（空组剔除，保持目录顺序） */
export function buildGroups(catalog: SelectiveCatalog): GroupNode[] {
  return buildCatalogGroups(catalog).groups;
}

/** 组内 item id 全集 */
export function groupItemIds(group: GroupNode): string[] {
  return group.items.map((item) => item.id);
}

/** 默认全选 */
export function defaultSelection(
  catalog: SelectiveCatalog,
): SelectiveSelection {
  const selection: SelectiveSelection = {
    providers: {},
    customApps: [],
    modelPricing: [],
    modelPresets: [],
    genericPreset: catalog.hasGenericPreset,
  };
  for (const group of catalog.providers) {
    selection.providers[group.appType] = group.items.map((item) => item.id);
  }
  selection.customApps = catalog.customApps.map((app) => app.id);
  selection.modelPricing = catalog.modelPricing.map((item) => item.id);
  selection.modelPresets = catalog.modelPresets.map((item) => item.id);
  return selection;
}

/** 组的三态：全选 true / 全不选 false / 部分 "indeterminate" */
export function groupCheckedState(
  group: GroupNode,
  selection: SelectiveSelection,
): boolean | "indeterminate" {
  if (group.isBoolean) {
    return selection.genericPreset;
  }
  const ids = groupItemIds(group);
  if (ids.length === 0) return false;
  const selectedIds = selectedIdsForGroup(group.id, selection);
  const count = ids.filter((id) => selectedIds.has(id)).length;
  if (count === 0) return false;
  if (count === ids.length) return true;
  return "indeterminate";
}

/** 组在 SelectiveSelection 里的已选 id 集合 */
export function selectedIdsForGroup(
  groupId: GroupId,
  selection: SelectiveSelection,
): Set<string> {
  if (groupId === "modelPricing") {
    return new Set(selection.modelPricing);
  }
  if (groupId === "modelPresets") {
    return new Set(selection.modelPresets);
  }
  if (groupId.startsWith("customApp:")) {
    const appId = groupId.slice("customApp:".length);
    return new Set(selection.customApps.includes(appId) ? [appId] : []);
  }
  if (groupId.startsWith("providers:")) {
    const appType = groupId.slice("providers:".length);
    return new Set(selection.providers[appType] ?? []);
  }
  // genericPreset 是布尔组，没有 item id
  return new Set<string>();
}

/**
 * 整组切换：目标态 = 当前不是全选时 → 全选；已全选 → 全不选。
 * 与 Checkbox 的行为对齐（indeterminate 点击后 onCheckedChange 给 true）。
 */
export function toggleGroup(
  group: GroupNode,
  selection: SelectiveSelection,
  next?: boolean,
): SelectiveSelection {
  const current = groupCheckedState(group, selection);
  const target = next ?? current !== true;
  if (group.isBoolean) {
    return { ...selection, genericPreset: target };
  }
  const ids = groupItemIds(group);
  if (group.id === "modelPricing") {
    return { ...selection, modelPricing: target ? ids : [] };
  }
  if (group.id === "modelPresets") {
    return { ...selection, modelPresets: target ? ids : [] };
  }
  if (group.id.startsWith("customApp:")) {
    const appId = group.id.slice("customApp:".length);
    const customApps = target
      ? Array.from(new Set([...selection.customApps, appId]))
      : selection.customApps.filter((id) => id !== appId);
    return { ...selection, customApps };
  }
  const appType = group.id.slice("providers:".length);
  return {
    ...selection,
    providers: { ...selection.providers, [appType]: target ? ids : [] },
  };
}

/** 单项切换（自定义应用组也走这里，item id = appId 整体） */
export function toggleItem(
  group: GroupNode,
  itemId: string,
  selection: SelectiveSelection,
): SelectiveSelection {
  const selected = selectedIdsForGroup(group.id, selection);
  const next = new Set(selected);
  if (next.has(itemId)) {
    next.delete(itemId);
  } else {
    next.add(itemId);
  }
  const ids = Array.from(next);
  if (group.id === "modelPricing") {
    return { ...selection, modelPricing: ids };
  }
  if (group.id === "modelPresets") {
    return { ...selection, modelPresets: ids };
  }
  if (group.id.startsWith("customApp:")) {
    const appId = group.id.slice("customApp:".length);
    return {
      ...selection,
      customApps: next.has(appId)
        ? Array.from(new Set([...selection.customApps, appId]))
        : selection.customApps.filter((id) => id !== appId),
    };
  }
  const appType = group.id.slice("providers:".length);
  return {
    ...selection,
    providers: { ...selection.providers, [appType]: ids },
  };
}

/** 全选 / 全不选所有组 */
export function toggleAll(
  groups: GroupNode[],
  selection: SelectiveSelection,
  target: boolean,
): SelectiveSelection {
  let next = selection;
  for (const group of groups) {
    next = toggleGroup(group, next, target);
  }
  return next;
}

/** 全局三态 */
export function overallCheckedState(
  groups: GroupNode[],
  selection: SelectiveSelection,
): boolean | "indeterminate" {
  let total = 0;
  let selected = 0;
  for (const group of groups) {
    if (group.isBoolean) {
      total += 1;
      if (selection.genericPreset) selected += 1;
      continue;
    }
    const ids = groupItemIds(group);
    total += ids.length;
    selected += ids.filter((id) =>
      selectedIdsForGroup(group.id, selection).has(id),
    ).length;
  }
  if (total === 0 || selected === 0) return false;
  if (selected === total) return true;
  return "indeterminate";
}

/** 已选条数（genericPreset 计 1） */
export function countSelected(
  groups: GroupNode[],
  selection: SelectiveSelection,
): number {
  let total = 0;
  for (const group of groups) {
    if (group.isBoolean) {
      if (selection.genericPreset) total += 1;
      continue;
    }
    total += groupItemIds(group).filter((id) =>
      selectedIdsForGroup(group.id, selection).has(id),
    ).length;
  }
  return total;
}

/** 可选总数 */
export function countTotal(groups: GroupNode[]): number {
  let total = 0;
  for (const group of groups) {
    if (group.isBoolean) {
      total += 1;
    } else {
      total += group.items.length;
    }
  }
  return total;
}

/** 组内已选数 / 组内总数（展示用） */
export function groupSelectedCount(
  group: GroupNode,
  selection: SelectiveSelection,
): number {
  if (group.isBoolean) {
    return selection.genericPreset ? 1 : 0;
  }
  const ids = groupItemIds(group);
  return ids.filter((id) => selectedIdsForGroup(group.id, selection).has(id))
    .length;
}

/**
 * 导入预览模式下，按目录（文件里的 catalog）过滤选择：
 * 目录里没有的 id（本机目录较新等情况）直接丢弃，防止后端报错。
 */
export function normalizeSelectionToCatalog(
  catalog: SelectiveCatalog,
  selection: SelectiveSelection,
): SelectiveSelection {
  const providers: Record<string, string[]> = {};
  for (const group of catalog.providers) {
    const valid = new Set(group.items.map((item) => item.id));
    providers[group.appType] = (
      selection.providers[group.appType] ?? []
    ).filter((id) => valid.has(id));
  }
  const customIds = new Set(catalog.customApps.map((app) => app.id));
  const pricingIds = new Set(catalog.modelPricing.map((item) => item.id));
  const presetIds = new Set(catalog.modelPresets.map((item) => item.id));
  return {
    providers,
    customApps: selection.customApps.filter((id) => customIds.has(id)),
    modelPricing: selection.modelPricing.filter((id) => pricingIds.has(id)),
    modelPresets: selection.modelPresets.filter((id) => presetIds.has(id)),
    genericPreset: catalog.hasGenericPreset ? selection.genericPreset : false,
  };
}

/** 给 SelectionTree 用的运行时组数据（含图标信息） */
export interface ProviderGroupData {
  kind: "providers";
  appType: string;
}
export interface CustomAppGroupData {
  kind: "customApp";
  app: CatalogCustomApp;
}
export interface PlainGroupData {
  kind: "plain";
  key: "modelPricing" | "modelPresets" | "genericPreset";
}

/** 从目录直接构造组列表（保留原始数据给组件渲染图标） */
export interface CatalogGroups {
  groups: GroupNode[];
  providerGroups: { group: GroupNode; data: CatalogAppGroup }[];
  customAppGroups: { group: GroupNode; data: CatalogCustomApp }[];
  plainGroups: { group: GroupNode; data: PlainGroupData }[];
}

export function buildCatalogGroups(catalog: SelectiveCatalog): CatalogGroups {
  const providerGroups: CatalogGroups["providerGroups"] = [];
  const customAppGroups: CatalogGroups["customAppGroups"] = [];
  const plainGroups: CatalogGroups["plainGroups"] = [];

  for (const data of catalog.providers) {
    if (data.items.length > 0) {
      providerGroups.push({
        data,
        group: {
          id: `providers:${data.appType}`,
          label: data.appType,
          items: data.items,
        },
      });
    }
  }
  for (const data of catalog.customApps) {
    customAppGroups.push({
      data,
      group: {
        id: `customApp:${data.id}`,
        label: data.name,
        // 自定义应用整体选择：可选单位就是应用本身（单个合成 item），
        // 应用下的 providers 仅作展示数据保留在 data 里
        items: [{ id: data.id, name: data.name, exists: data.exists }],
      },
    });
  }
  if (catalog.modelPricing.length > 0) {
    plainGroups.push({
      data: { kind: "plain", key: "modelPricing" },
      group: {
        id: "modelPricing",
        label: "modelPricing",
        items: catalog.modelPricing,
      },
    });
  }
  if (catalog.modelPresets.length > 0) {
    plainGroups.push({
      data: { kind: "plain", key: "modelPresets" },
      group: {
        id: "modelPresets",
        label: "modelPresets",
        items: catalog.modelPresets,
      },
    });
  }
  if (catalog.hasGenericPreset) {
    plainGroups.push({
      data: { kind: "plain", key: "genericPreset" },
      group: {
        id: "genericPreset",
        label: "genericPreset",
        items: [],
        isBoolean: true,
      },
    });
  }

  return {
    groups: [
      ...providerGroups.map((entry) => entry.group),
      ...customAppGroups.map((entry) => entry.group),
      ...plainGroups.map((entry) => entry.group),
    ],
    providerGroups,
    customAppGroups,
    plainGroups,
  };
}
