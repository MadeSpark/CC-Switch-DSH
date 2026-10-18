import type { TFunction } from "i18next";

/**
 * 模型预设（需求 5）：给某类模型 id 预置上下文窗口 / 最大输出 / 思考等级 / 温度 / 额外参数，
 * 添加模型时按模型 id 匹配并询问是否套用。
 *
 * 这里只放纯数据、匹配和格式化逻辑，不依赖 React，设置页和表单里的询问弹窗共用。
 */

/** 可套用到模型表单上的参数（不含标识字段）。 */
export interface ModelPresetParams {
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoningEffort?: string;
  temperature?: number;
  extraParams?: Record<string, unknown>;
}

/** 一条模型预设。modelId 是匹配用的模式，支持 `*`（任意多个字符）和 `?`（单个字符）。 */
export interface ModelPreset extends ModelPresetParams {
  id: string;
  name: string;
  modelId: string;
}

/** 后端 `model_presets` 设置的整体形状（`get_model_presets` / `save_model_presets`）。 */
export interface ModelPresetSettings {
  presets: ModelPreset[];
  generic: ModelPresetParams;
}

/** 询问弹窗里「要套用的参数」来源：命中的预设，或所有模型共用的通用参数。 */
export type ModelPresetApplySource = "preset" | "generic";

/** 思考等级下拉的固定取值；不在列表里的自定义值用下面的哨兵值表示。 */
export const REASONING_EFFORT_OPTIONS = [
  "off",
  "low",
  "medium",
  "high",
  "max",
] as const;

export const CUSTOM_REASONING_EFFORT = "__custom__";

export const EMPTY_MODEL_PRESET_SETTINGS: ModelPresetSettings = {
  presets: [],
  generic: {},
};

/**
 * 「添加模型时是否询问套用通用参数」没有后端字段，存本地（切换即时生效）。
 * 只影响没有命中预设的模型；通用参数为空时永远不会询问。
 */
export const GENERIC_PROMPT_ENABLED_STORAGE_KEY =
  "cc-switch.modelPresets.genericPrompt";

/** 模式里允许出现的字符（另外不允许空白字符）。 */
const VALID_MODEL_PATTERN = /^[A-Za-z0-9._:/?*-]+$/;

const WILDCARD_CHAR = /[*?]/;

/** 去掉首尾空白；空串表示没有填写。 */
export function normalizeModelPattern(pattern: string): string {
  return pattern.trim();
}

/** 不含通配符的模式就是精确匹配。 */
export function isExactModelPattern(pattern: string): boolean {
  return !WILDCARD_CHAR.test(normalizeModelPattern(pattern));
}

/**
 * 匹配用的模式是否合法：非空、不含空白字符、只由字母数字和 `._-:/?*` 组成。
 * `*` 和 `?` 是通配符，所以像 `deepseek-v4-*` 是合法的。
 */
export function isValidModelPattern(pattern: string): boolean {
  const normalized = normalizeModelPattern(pattern);
  if (!normalized) return false;
  return VALID_MODEL_PATTERN.test(normalized);
}

function escapeRegExpChar(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

/** 把带 `*` / `?` 的模式转成整串匹配、大小写不敏感的正则。 */
function compileModelPattern(pattern: string): RegExp {
  let source = "";
  for (const char of pattern) {
    if (char === "*") source += ".*";
    else if (char === "?") source += ".";
    else source += escapeRegExpChar(char);
  }
  return new RegExp(`^${source}$`, "i");
}

interface PatternScore {
  /** 字面字符数：越多越精确 */
  literal: number;
  /** 通配符个数：越少越精确 */
  wildcards: number;
  /** 模式长度：同精确度时更长的更具体 */
  length: number;
}

function scorePattern(pattern: string): PatternScore {
  const wildcards = pattern.match(/[*?]/g);
  return {
    literal: pattern.replace(/[*?]/g, "").length,
    wildcards: wildcards ? wildcards.length : 0,
    length: pattern.length,
  };
}

/** a 比 b 更精确返回正数。 */
function comparePatternScore(a: PatternScore, b: PatternScore): number {
  if (a.literal !== b.literal) return a.literal - b.literal;
  if (a.wildcards !== b.wildcards) return b.wildcards - a.wildcards;
  return a.length - b.length;
}

/**
 * 给模型 id 找最合适的预设：
 * 1. 精确匹配优先（忽略大小写和首尾空白）；
 * 2. 否则在通配符模式里挑最具体的（字面字符最多、通配符最少），`deepseek-v4-*` 胜过 `deepseek-*`；
 * 3. 都不命中返回 null。
 */
export function matchModelPreset(
  modelId: string,
  presets: readonly ModelPreset[],
): ModelPreset | null {
  const target = modelId.trim().toLowerCase();
  if (!target) return null;

  let wildcardMatch: ModelPreset | null = null;
  let wildcardScore: PatternScore | null = null;

  for (const preset of presets) {
    const pattern = normalizeModelPattern(preset.modelId);
    if (!pattern) continue;

    if (isExactModelPattern(pattern)) {
      if (pattern.toLowerCase() === target) return preset;
      continue;
    }

    let matcher: RegExp;
    try {
      matcher = compileModelPattern(pattern.toLowerCase());
    } catch {
      continue;
    }
    if (!matcher.test(target)) continue;

    const score = scorePattern(pattern);
    if (!wildcardScore || comparePatternScore(score, wildcardScore) > 0) {
      wildcardMatch = preset;
      wildcardScore = score;
    }
  }

  return wildcardMatch;
}

/**
 * 从预设 / 通用参数里拷出可套用的参数：
 * 去掉 id / name / modelId，丢掉无效字段，extraParams 深拷一层避免调用方改到 hook 里的数据。
 */
export function pickPresetParams(
  source?: ModelPresetParams | null,
): ModelPresetParams {
  if (!source) return {};
  const params: ModelPresetParams = {};

  if (
    typeof source.contextWindow === "number" &&
    Number.isFinite(source.contextWindow)
  ) {
    params.contextWindow = source.contextWindow;
  }
  if (
    typeof source.maxOutputTokens === "number" &&
    Number.isFinite(source.maxOutputTokens)
  ) {
    params.maxOutputTokens = source.maxOutputTokens;
  }
  if (
    typeof source.reasoningEffort === "string" &&
    source.reasoningEffort.trim()
  ) {
    params.reasoningEffort = source.reasoningEffort.trim();
  }
  if (
    typeof source.temperature === "number" &&
    Number.isFinite(source.temperature)
  ) {
    params.temperature = source.temperature;
  }
  if (
    source.extraParams &&
    typeof source.extraParams === "object" &&
    !Array.isArray(source.extraParams)
  ) {
    const entries = Object.entries(source.extraParams);
    if (entries.length > 0) params.extraParams = Object.fromEntries(entries);
  }

  return params;
}

/** 这组参数里是否有值得套用的内容（决定要不要弹询问框）。 */
export function hasPresetParams(params?: ModelPresetParams | null): boolean {
  return Object.keys(pickPresetParams(params)).length > 0;
}

/** 把参数整理成「思考等级: max」这样的行，用于设置页摘要和询问弹窗。 */
export function describePresetParams(
  params: ModelPresetParams | null | undefined,
  t: TFunction,
): string[] {
  const normalized = pickPresetParams(params);
  const rows: string[] = [];

  if (normalized.contextWindow !== undefined) {
    rows.push(
      `${t("modelPresets.paramLabels.contextWindow")}: ${normalized.contextWindow}`,
    );
  }
  if (normalized.maxOutputTokens !== undefined) {
    rows.push(
      `${t("modelPresets.paramLabels.maxOutputTokens")}: ${normalized.maxOutputTokens}`,
    );
  }
  if (normalized.reasoningEffort !== undefined) {
    rows.push(
      `${t("modelPresets.paramLabels.reasoningEffort")}: ${normalized.reasoningEffort}`,
    );
  }
  if (normalized.temperature !== undefined) {
    rows.push(
      `${t("modelPresets.paramLabels.temperature")}: ${normalized.temperature}`,
    );
  }
  if (normalized.extraParams !== undefined) {
    let text = "";
    try {
      text = JSON.stringify(normalized.extraParams);
    } catch {
      text = "";
    }
    if (text) {
      rows.push(`${t("modelPresets.paramLabels.extraParams")}: ${text}`);
    }
  }

  return rows;
}

/** 新增预设时用的随机 id（crypto.randomUUID 不可用时退回时间戳 + 随机串）。 */
export function uniquePresetId(): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject && typeof cryptoObject.randomUUID === "function") {
    return `preset-${cryptoObject.randomUUID()}`;
  }
  return `preset-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

export type ExtraParamsParseResult =
  | { ok: true; value?: Record<string, unknown> }
  | { ok: false };

/** 解析「额外参数」文本框里的 JSON；空文本表示不设置，必须是对象。 */
export function parseExtraParams(text: string): ExtraParamsParseResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ok: true, value: parsed as Record<string, unknown> };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

/** 额外参数对象 → 编辑框里的 JSON 文本；空对象返回空串。 */
export function stringifyExtraParams(
  extraParams?: Record<string, unknown>,
): string {
  if (!extraParams) return "";
  try {
    if (Object.keys(extraParams).length === 0) return "";
    return JSON.stringify(extraParams, null, 2);
  } catch {
    return "";
  }
}

/** 通用参数询问开关（本地保存，默认开启）。 */
export function readGenericPromptEnabled(): boolean {
  try {
    if (typeof localStorage === "undefined") return true;
    return localStorage.getItem(GENERIC_PROMPT_ENABLED_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function writeGenericPromptEnabled(enabled: boolean): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(
      GENERIC_PROMPT_ENABLED_STORAGE_KEY,
      enabled ? "true" : "false",
    );
  } catch {
    // 隐私模式等写不进去的情况：仅本次会话不记住，不影响功能
  }
}
