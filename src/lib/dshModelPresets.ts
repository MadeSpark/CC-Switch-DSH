import type { DshModel } from "@/components/providers/forms/helpers/deepseekHarnessFormUtils";
import type { ModelPresetParams } from "@/lib/modelPresets";

/**
 * 从 DSH 供应商模型行里抽出来、可以搬进模型预设的字段。
 *
 * `value` 是深拷贝后的原值，调用方随便改都不会影响 DSH 那边同一份配置。
 */
export interface DshModelPresetField {
  key: string;
  value: unknown;
}

/** 模型身份字段：只用来选模型 / 生成预设名，不作为可导入参数。 */
const IDENTITY_KEYS: ReadonlySet<string> = new Set(["id", "name", "rowKey"]);

/** 原型污染键：任何一层都不拷贝、不落盘。 */
const UNSAFE_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

// Provider connection fields are excluded from reusable model parameters.
const CONNECTION_KEYS = new Set([
  "apikey",
  "apikeyenv",
  "baseurl",
  "authorization",
  "headers",
  "token",
  "accesstoken",
  "refreshtoken",
  "password",
  "secret",
]);

function isExcludedField(key: string): boolean {
  return (
    IDENTITY_KEYS.has(key) ||
    UNSAFE_KEYS.has(key) ||
    CONNECTION_KEYS.has(key.toLowerCase())
  );
}

/**
 * 已知字段排在前面，其余按模型行里的原始顺序透传。
 * 顺序只影响面板里的展示，不影响导入结果。
 */
const FIELD_ORDER: readonly string[] = [
  "contextWindow",
  "maxTokens",
  "maxOutputTokens",
  "reasoningEffort",
  "temperature",
  "reasoningEfforts",
  "compat",
  "input",
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** 只复制 JSON 结构；false / null / 0 / 空字符串都原样保留。 */
function deepCopyValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => deepCopyValue(entry));
  }
  if (isPlainObject(value)) {
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(key)) continue;
      copy[key] = deepCopyValue(entry);
    }
    return copy;
  }
  return value;
}

function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

function readModelField(model: DshModel, key: string): unknown {
  if (!hasOwn(model, key)) return undefined;
  return (model as Record<string, unknown>)[key];
}

/**
 * 列出某条 DSH 模型里可以导入预设的字段（深拷贝值）。
 *
 * - 去掉 `id` / `name` / `rowKey` 这些身份字段；
 * - 去掉值为 `undefined` 的字段（没设置 ≠ 设成 false/null）；
 * - 去掉 `__proto__` / `constructor` / `prototype` 等原型污染键；
 * - 其余字段（包括 `reasoningEfforts`、`compat`、`input`、`maxTokens`
 *   以及以后 pi-ai 新增的字段）全部透传，保证导入再套用不会丢配置。
 */
export function getDshModelPresetFields(
  model: DshModel,
): DshModelPresetField[] {
  const keys = Object.keys(model);
  const ordered = [
    ...FIELD_ORDER.filter((key) => keys.includes(key)),
    ...keys.filter((key) => !FIELD_ORDER.includes(key)),
  ];
  const fields: DshModelPresetField[] = [];
  const seen = new Set<string>();

  for (const key of ordered) {
    if (seen.has(key)) continue;
    seen.add(key);
    if (isExcludedField(key)) continue;
    if (!hasOwn(model, key)) continue;
    const value = readModelField(model, key);
    if (value === undefined) continue;
    fields.push({ key, value: deepCopyValue(value) });
  }

  return fields;
}

/**
 * 把用户勾选的 DSH 模型字段转成模型预设参数。
 *
 * 映射关系：
 * - `contextWindow` / `reasoningEffort` / `temperature` 同名直传；
 * - `maxTokens` → `maxOutputTokens`（`maxOutputTokens` 也兼容；两者都在时
 *   以原生 `maxTokens` 为准，另一个留在额外参数里，不丢）；
 * - 其余字段（`reasoningEfforts`、`compat`、`input`、`maxTokens` 之外的未知
 *   字段）原样放进 `extraParams`；
 * - 值类型不符合参数契约时（例如字符串形式的 contextWindow）也放进
 *   `extraParams`，保证往返不丢数据；`false` / `null` 一律保留。
 */
export function dshModelFieldsToPresetParams(
  model: DshModel,
  selectedKeys: readonly string[],
): ModelPresetParams {
  const selected = new Set(selectedKeys);
  const params: ModelPresetParams = {};
  const extraParams: Record<string, unknown> = {};

  const wants = (key: string) => selected.has(key) && hasOwn(model, key);
  const read = (key: string) => readModelField(model, key);

  if (wants("contextWindow")) {
    const value = read("contextWindow");
    if (isTokenCount(value)) params.contextWindow = value;
    else if (value !== undefined)
      extraParams.contextWindow = deepCopyValue(value);
  }

  // maxTokens 是 DSH 原生字段，优先；maxOutputTokens 只在它没被选中/没有值时兜底。
  const maxTokens = read("maxTokens");
  const maxOutputTokens = read("maxOutputTokens");
  const hasMaxTokens = selected.has("maxTokens") && maxTokens !== undefined;
  const hasMaxOutputTokens =
    selected.has("maxOutputTokens") && maxOutputTokens !== undefined;

  if (hasMaxTokens && isTokenCount(maxTokens)) {
    params.maxOutputTokens = maxTokens;
    // 两个字段都勾了：另一个也留着，套用时两处都能还原。
    if (hasMaxOutputTokens) {
      extraParams.maxOutputTokens = deepCopyValue(maxOutputTokens);
    }
  } else if (hasMaxTokens) {
    extraParams.maxTokens = deepCopyValue(maxTokens);
    if (hasMaxOutputTokens) {
      extraParams.maxOutputTokens = deepCopyValue(maxOutputTokens);
    }
  } else if (hasMaxOutputTokens) {
    if (isTokenCount(maxOutputTokens)) {
      params.maxOutputTokens = maxOutputTokens;
    } else {
      extraParams.maxOutputTokens = deepCopyValue(maxOutputTokens);
    }
  }

  if (wants("reasoningEffort")) {
    const value = read("reasoningEffort");
    if (typeof value === "string") params.reasoningEffort = value;
    else if (value !== undefined) {
      extraParams.reasoningEffort = deepCopyValue(value);
    }
  }

  if (wants("temperature")) {
    const value = read("temperature");
    if (isFiniteNumber(value)) params.temperature = value;
    else if (value !== undefined)
      extraParams.temperature = deepCopyValue(value);
  }

  const handled = new Set([
    "contextWindow",
    "maxTokens",
    "maxOutputTokens",
    "reasoningEffort",
    "temperature",
  ]);

  for (const key of selected) {
    if (handled.has(key)) continue;
    if (isExcludedField(key)) continue;
    if (!hasOwn(model, key)) continue;
    const value = readModelField(model, key);
    if (value === undefined) continue;
    extraParams[key] = deepCopyValue(value);
  }

  if (Object.keys(extraParams).length > 0) {
    params.extraParams = extraParams;
  }

  return params;
}

/**
 * 把模型预设参数套到一条 DSH 模型上，返回新对象（不修改入参）。
 *
 * - 只有预设里真的存在的参数才会覆盖模型上的同名配置；
 * - `maxOutputTokens` 落到 DSH 原生字段 `maxTokens`；
 * - `extraParams` 的键落在模型行顶层；
 * - `compat` 与原有 compat 浅合并，保留模型上其他兼容开关；
 * - `reasoningEfforts` 整表替换（不会残留旧等级），并且深拷贝；
 * - `id` / `name` / `rowKey` 以及原型污染键不会被 `extraParams` 覆盖。
 */
export function applyPresetToDshModel(
  model: DshModel,
  params: ModelPresetParams,
): DshModel {
  const target = deepCopyValue(model) as Record<string, unknown>;
  const next = target as DshModel;

  if (isTokenCount(params.contextWindow)) {
    target.contextWindow = params.contextWindow;
  }
  if (isTokenCount(params.maxOutputTokens)) {
    target.maxTokens = params.maxOutputTokens;
  }
  if (typeof params.reasoningEffort === "string") {
    target.reasoningEffort = params.reasoningEffort;
  }
  if (isFiniteNumber(params.temperature)) {
    target.temperature = params.temperature;
  }

  if (isPlainObject(params.extraParams)) {
    for (const [key, rawValue] of Object.entries(params.extraParams)) {
      if (isExcludedField(key)) continue;
      const value = deepCopyValue(rawValue);

      if (key === "compat") {
        if (isPlainObject(value) && isPlainObject(target.compat)) {
          target.compat = {
            ...(deepCopyValue(target.compat) as Record<string, unknown>),
            ...value,
          };
        } else {
          target.compat = value;
        }
        continue;
      }

      // reasoningEfforts 走整表替换：旧等级不会残留。
      target[key] = value;
    }
  }

  return next;
}
