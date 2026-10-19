import { DEEPSEEK_HARNESS_DEFAULT_CONFIG } from "@/config/deepseekHarnessProviderPresets";

// ── Default configs ──────────────────────────────────────────────────

export const DSH_MODEL_API_OPTIONS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
] as const;

export type DshModelApi = (typeof DSH_MODEL_API_OPTIONS)[number];

/**
 * 每个等级对应的实际发送值：字符串照原样发给 pi-ai，`null` 表示不发送思考参数。
 * 例如 `{ off: null, low: "low", medium: "medium" }`。
 */
export type DshReasoningEfforts = Record<string, string | null>;

export type DshModel = {
  id: string;
  name?: string;
  contextWindow?: number;
  /** 模型支持的输入模态（如 `["text", "image"]`）；表单只原样透传，不做编辑。 */
  input?: unknown;
  /**
   * 模型声明的思考等级表。`false` 是插件的哨兵值，表示「强制关闭思考」，
   * 与「未设置」（省略该字段）语义不同，必须原样保留。
   */
  reasoningEfforts?: DshReasoningEfforts | false;
  /** 传输层兼容开关（如 `forceAdaptiveThinking`）；原样透传。 */
  compat?: Record<string, unknown>;
  /** Client-only stable React key; stripped before persisting. */
  rowKey?: string;
  /**
   * pi-ai 目录里的其余字段（以及以后新增的字段）全部原样透传：
   * 表单只编辑它认识的几列，保存时不能把不认识的字段丢掉。
   */
  [key: string]: unknown;
};

let dshRowKeySeq = 0;

/** Mirrors the stable per-row keys Pi's provider form uses for model rows. */
export function nextDshRowKey(): string {
  dshRowKeySeq += 1;
  return `dsh-row-${dshRowKeySeq}`;
}

export function withDshRowKeys(models: DshModel[]): DshModel[] {
  return models.map((model) => ({
    ...model,
    rowKey: model.rowKey ?? nextDshRowKey(),
  }));
}

/**
 * Drops blank model rows before persisting. The Add button appends empty
 * rows (mirroring Pi/OpenCode), so a half-filled row must never reach the
 * native `models` catalog where it would break model resolution.
 *
 * Bare-id strings are a valid native catalog form (the backend `model_id_of`
 * accepts them), so they survive the prune — trimmed like object ids so they
 * match the trimmed `meta.dshCurrentModel` comparison on the Rust side.
 */
export function pruneDshModelRows(
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(config.models)) return config;
  let changed = false;
  const pruned: unknown[] = [];
  for (const model of config.models) {
    if (typeof model === "string") {
      const id = model.trim();
      if (id === "") {
        changed = true;
        continue;
      }
      if (id !== model) changed = true;
      pruned.push(id);
      continue;
    }
    if (
      model !== null &&
      typeof model === "object" &&
      !Array.isArray(model) &&
      typeof (model as Record<string, unknown>).id === "string" &&
      ((model as Record<string, unknown>).id as string).trim() !== ""
    ) {
      const raw = model as Record<string, unknown>;
      const id = (raw.id as string).trim();
      if (id !== raw.id) {
        changed = true;
        pruned.push({ ...raw, id });
        continue;
      }
      pruned.push(model);
      continue;
    }
    // Nulls, arrays, and objects without a usable id are not model entries.
    changed = true;
  }
  if (!changed) return config;
  return { ...config, models: pruned };
}

export const DSH_OFFICIAL_DEFAULT_CONFIG = DEEPSEEK_HARNESS_DEFAULT_CONFIG;

export const DSH_CUSTOM_DEFAULT_CONFIG: Record<string, unknown> = {
  displayName: "Custom DSH",
  api: "openai-completions",
  baseURL: "",
  apiKeyEnv: "CUSTOM_DSH_API_KEY",
  apiKey: "",
  models: [],
};

// ── Pure functions ───────────────────────────────────────────────────

/**
 * Official DSH routes are identified authoritatively by the persisted provider
 * meta `providerType` (`dsh_deepseek` vs `dsh_pi_ai`), with the fixed provider
 * id and official category as fallbacks. A reserved credential reference is NOT
 * a signal: custom routes may legitimately use `DEEPSEEK_API_KEY`.
 */
export function isDshOfficial(
  id: string | undefined,
  category: string | undefined,
  _config: Record<string, unknown> | undefined,
  providerType?: string | null,
): boolean {
  if (providerType === "dsh_deepseek") return true;
  if (providerType === "dsh_pi_ai") return false;
  if (id === "deepseek-official") return true;
  if (category === "official") return true;
  return false;
}

/**
 * Safely parses a DSH model catalog, tolerating `{ id }` objects and bare
 * id strings from imported native configuration.
 */
export function normalizeDshModels(value: unknown): DshModel[] {
  if (!Array.isArray(value)) return [];

  const models: DshModel[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      // Bare-id strings are valid native catalog entries; trim so the editor
      // matches the trimmed default-model comparison on the Rust side.
      const id = entry.trim();
      if (id !== "") models.push({ id });
      continue;
    }
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const item = entry as Record<string, unknown>;
      const id = item.id == null ? "" : String(item.id).trim();
      // 除下面几个结构化字段外全部原样透传（`input` / `compat` / 以后新增的
      // 字段），否则「打开表单再保存」会把不认识的字段悄悄删掉。
      const model: DshModel = { ...item, id };
      delete model.rowKey;

      if (typeof item.name === "string" && item.name !== "") {
        model.name = item.name;
      } else {
        delete model.name;
      }

      if (
        typeof item.contextWindow === "number" &&
        Number.isFinite(item.contextWindow)
      ) {
        model.contextWindow = item.contextWindow;
      } else {
        delete model.contextWindow;
      }

      const reasoningEfforts = normalizeDshReasoningEfforts(
        item.reasoningEfforts,
      );
      if (reasoningEfforts === undefined) {
        delete model.reasoningEfforts;
      } else {
        model.reasoningEfforts = reasoningEfforts;
      }

      models.push(model);
    }
  }
  return models;
}

// ── 推理等级（reasoningEfforts）─────────────────────────────────────
//
// 下面这段等级表、模型族推荐值和落盘规则逐行照抄 DSH 桌面插件
// `dsh-desktop-ui-reasoning-effort@0.1.2` 的 `lib/client.js` L108-222
// （`effortsOf` / `preset` / `atLeast` / `normalizeModelId` / `presetFor`），
// 保证 CC Switch 里配出来的 `reasoningEfforts` 和 `compat.forceAdaptiveThinking`
// 跟插件面板里配出来的逐键一致：等级由弱到强、值是发给 pi-ai 的字面值、
// `null` 表示不发送思考参数、字段未设置时整段省略（绝不写成 `{}`）。
// 不认识或非推理模型一律返回 null，不再按前缀瞎猜。
// 契约镜像测试：`tests/components/dshReasoningPresetMirror.test.ts`。

/** 思考等级，由弱到强（与插件的 LEVELS 顺序一致）。 */
export const DSH_REASONING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type DshReasoningLevel = (typeof DSH_REASONING_LEVELS)[number];

/** 某个模型族的推荐等级表；`adaptive` 表示要同时开自适应思考。 */
export interface DshReasoningPreset {
  family: string;
  efforts: DshReasoningEfforts;
  adaptive: boolean;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 把面板里的短写法（`"off=none,low"`）解析成等级表。 */
function effortsOf(spec: string): DshReasoningEfforts {
  const efforts: DshReasoningEfforts = {};
  for (const part of spec.split(",")) {
    const token = part.trim();
    if (token === "") continue;
    const [level, wire] = token.split("=");
    const key = level.trim();
    if (key === "") continue;
    efforts[key] =
      wire === undefined ? (key === "off" ? null : key) : wire.trim();
  }
  return efforts;
}

/** 插件 `preset(family, spec, adaptive)`：`adaptive` 只有显式 true 才算。 */
function preset(
  family: string,
  spec: string,
  adaptive = false,
): DshReasoningPreset {
  return { family, efforts: effortsOf(spec), adaptive: adaptive === true };
}

/** `[major, minor]` 至少到 `[a, b]`（插件 `atLeast`，纯数字比较）。 */
function atLeast(major: number, minor: number, a: number, b: number): boolean {
  return major > a || (major === a && minor >= b);
}

/** 归一化模型 id（逐行照抄插件 `normalizeModelId`，顺序不能动）。 */
export function normalizeDshModelId(modelId: string): string {
  let id = String(modelId).trim().toLowerCase();
  id = id.slice(id.lastIndexOf("/") + 1);
  id = id.replace(/[:@].*$/, "");
  let previous = "";
  do {
    previous = id;
    id = id.replace(
      /-(?:thinking|nothinking|openai-compact|compact|preview|exp|\d{8}|\d{4}-\d{2}-\d{2})$/,
      "",
    );
  } while (id !== previous);
  // claude-opus-4.7 → claude-opus-4-7
  id = id.replace(
    /^claude-(opus|sonnet|haiku|fable)-(\d+)\.(\d+)/,
    "claude-$1-$2-$3",
  );
  // grok-4-6 → grok-4.6 / glm-5-2 → glm-5.2
  id = id.replace(/^(grok|glm)-(\d+)-(\d+)(?=-|$)/, "$1-$2.$3");
  id = id.replace(/^claude-3\.7-/, "claude-3-7-");
  return id;
}

/** 按模型 id 取推荐等级表（逐行照抄插件 `presetFor`）；不认识返回 null。 */
export function dshReasoningPresetFor(
  modelId: string,
): DshReasoningPreset | null {
  const normalized = normalizeDshModelId(modelId);

  // GPT / OpenAI：gpt-5 起才有思考等级；5.0/5.1/5.2/5.6 与 6.x 各自不同。
  const gpt = /^gpt-(\d+)(?:\.(\d+))?(.*)$/.exec(normalized);
  if (gpt !== null) {
    const major = Number(gpt[1]);
    const minor = gpt[2] === undefined ? 0 : Number(gpt[2]);
    const rest = gpt[3];
    const at = (a: number, b: number) => atLeast(major, minor, a, b);
    if (!at(5, 0)) return null;
    if (/^-chat(?:-|$)/.test(rest)) {
      return major === 5 && minor === 2 ? preset("GPT", "medium,xhigh") : null;
    }
    if (/-pro(?:-|$)/.test(rest)) {
      return preset("GPT", at(5, 2) ? "medium,high,xhigh" : "high");
    }
    if (/-codex-spark(?:-|$)/.test(rest)) {
      return preset("GPT", "low,medium,high,xhigh");
    }
    if (at(6, 0)) {
      return preset(
        "GPT",
        /astra/.test(rest)
          ? "low,medium,high,xhigh,max"
          : "off=none,low,medium,high,xhigh,max",
      );
    }
    if (at(5, 6)) {
      return preset("GPT", "off=none,low,medium,high,xhigh,max");
    }
    if (at(5, 2)) return preset("GPT", "off=none,low,medium,high,xhigh");
    if (at(5, 1)) return preset("GPT", "off=none,low,medium,high");
    return preset("GPT", "minimal,low,medium,high");
  }

  if (/^gpt-oss(?:-|$)/.test(normalized)) {
    return preset("GPT", "low,medium,high");
  }
  if (/^o[134](?:-|$)/.test(normalized)) {
    return preset("OpenAI o", "low,medium,high");
  }

  // Claude：fable / opus 5+ 用 5 档且强制自适应；4.6 / 4.7 才带 off 与 max。
  const claude =
    /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(
      normalized,
    );
  if (claude !== null) {
    const tier = claude[1];
    const major = Number(claude[2]);
    const minor = claude[3] === undefined ? 0 : Number(claude[3]);
    const at = (a: number, b: number) => atLeast(major, minor, a, b);
    if (tier === "fable" || (tier === "opus" && at(5, 0))) {
      return preset("Claude", "low,medium,high,xhigh,max", true);
    }
    if (at(4, 7)) {
      return preset("Claude", "off,low,medium,high,xhigh,max", true);
    }
    if (at(4, 6)) return preset("Claude", "off,low,medium,high,max", true);
    if (at(4, 0) && (tier !== "haiku" || at(4, 5))) {
      return preset("Claude", "off,low,medium,high");
    }
    return null;
  }
  if (/^claude-3-7-sonnet(?:-|$)/.test(normalized)) {
    return preset("Claude", "off,low,medium,high");
  }

  // Grok：4.1 起才有等级；fast/mini/reasoning 变体只给 low/high。
  const grok = /^grok-(\d+)(?:\.(\d+))?(.*)$/.exec(normalized);
  if (grok !== null) {
    const major = Number(grok[1]);
    const minor = grok[2] === undefined ? 0 : Number(grok[2]);
    const rest = grok[3];
    const at = (a: number, b: number) => atLeast(major, minor, a, b);
    if (at(4, 1) && !at(4, 3) && /(?:fast|mini|reasoning)/.test(rest)) {
      return preset("Grok", "low,high");
    }
    if (at(4, 6)) return preset("Grok", "low,medium,high,xhigh");
    if (at(4, 5)) return preset("Grok", "low,medium,high");
    if (at(4, 3)) return preset("Grok", "off=none,low,medium,high");
    if (at(4, 1)) return preset("Grok", "low,medium,high");
    if (major === 3 && /mini/.test(rest)) return preset("Grok", "low,high");
    return null;
  }

  const glm = /^glm-(\d+)(?:\.(\d+))?/.exec(normalized);
  if (glm !== null) {
    const major = Number(glm[1]);
    const minor = glm[2] === undefined ? 0 : Number(glm[2]);
    const at = (a: number, b: number) => atLeast(major, minor, a, b);
    if (at(5, 3)) return preset("GLM", "low,high,max");
    if (at(5, 2)) return preset("GLM", "off=none,high,max");
    if (at(4, 5)) return preset("GLM", "off,minimal,low,medium,high");
    return null;
  }

  const mimo = /^(?:xiaomi-)?mimo-v(\d+)(?:\.(\d+))?/.exec(normalized);
  if (mimo !== null) {
    const major = Number(mimo[1]);
    const minor = mimo[2] === undefined ? 0 : Number(mimo[2]);
    return atLeast(major, minor, 2, 5)
      ? preset("MiMo", "off,minimal,low,medium,high")
      : null;
  }

  return null;
}

/** 自定义模式下的默认等级表（与插件一致）。 */
export const DEFAULT_DSH_CUSTOM_EFFORTS: DshReasoningEfforts = effortsOf(
  "off,low,medium,high",
);

/** 值是不是一张合法的等级表（`false` 哨兵值不算）。 */
export function isDshReasoningEfforts(
  value: unknown,
): value is DshReasoningEfforts {
  if (!isPlainObject(value)) return false;
  const entries = Object.entries(value);
  if (entries.length === 0) return false;
  return entries.every(
    ([key, wire]) =>
      key.trim() !== "" &&
      (wire === null || (typeof wire === "string" && wire.trim() !== "")),
  );
}

/**
 * 校验并规范化落盘的 `reasoningEfforts`：值只能是字符串或 `null`，
 * 键按等级从弱到强排序，空表 → `undefined`（调用方应当省略整个字段）。
 * `false` 哨兵值原样保留。
 */
export function normalizeDshReasoningEfforts(
  value: unknown,
): DshReasoningEfforts | false | undefined {
  if (value === false) return false;
  if (!isPlainObject(value)) return undefined;

  const next: DshReasoningEfforts = {};
  for (const level of DSH_REASONING_LEVELS) {
    if (!hasOwn(value, level)) continue;
    const wire = value[level];
    if (wire === null) next[level] = null;
    else if (typeof wire === "string" && wire.trim() !== "") {
      next[level] = wire.trim();
    }
  }
  // 等级表之外的键（网关自定义的等级名）也要保住，否则保存一次就没了。
  for (const [key, wire] of Object.entries(value)) {
    if ((DSH_REASONING_LEVELS as readonly string[]).includes(key)) continue;
    if (wire === null) next[key] = null;
    else if (typeof wire === "string" && wire.trim() !== "") {
      next[key] = wire.trim();
    }
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

/** 按等级顺序重排一张等级表（不丢键）。 */
export function orderDshReasoningEfforts(
  value: DshReasoningEfforts,
): DshReasoningEfforts {
  const ordered: DshReasoningEfforts = {};
  for (const level of DSH_REASONING_LEVELS) {
    if (hasOwn(value, level)) ordered[level] = value[level];
  }
  for (const [key, wire] of Object.entries(value)) {
    if (!hasOwn(ordered, key)) ordered[key] = wire;
  }
  return ordered;
}

/** 两张等级表是否等价（键集合和值都一致）。 */
export function dshReasoningEffortsEqual(
  left: DshReasoningEfforts | undefined,
  right: DshReasoningEfforts | undefined,
): boolean {
  if (!left || !right) return left === right;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every(
    (key) => hasOwn(right, key) && left[key] === right[key],
  );
}

/**
 * 触发器文案：连续三段及以上的等级折叠成 `low → max`，其余按顺序用 `, ` 拼接
 * （与 Codex 表单的推理等级控件同一套折行规则，只是等级表换成 DSH 的）。
 * 传入的等级不是从弱到强的顺序（例如网关自定义等级）时原样拼出来，
 * 免得暗示中间那几个没勾选的等级也被选中了。
 */
export function formatDshReasoningLevelsLabel(levels: string[]): string {
  const canonical = DSH_REASONING_LEVELS as readonly string[];
  const positions = levels.map((level) => canonical.indexOf(level));
  const ordered = positions.every(
    (position, index) =>
      position >= 0 && (index === 0 || position > positions[index - 1]),
  );
  if (!ordered) return levels.join(", ");

  const parts: string[] = [];
  let runStart = 0;
  for (let index = 1; index <= levels.length; index += 1) {
    const continues =
      index < levels.length && positions[index] === positions[index - 1] + 1;
    if (continues) continue;
    const run = levels.slice(runStart, index);
    if (run.length >= 3) {
      parts.push(`${run[0]} → ${run[run.length - 1]}`);
    } else {
      parts.push(...run);
    }
    runStart = index;
  }
  return parts.join(", ");
}

/**
 * 某等级实际要发的值：优先用推荐值，否则 `off` → `null`，其余等级发等级名本身。
 */
export function dshReasoningWireFor(
  level: string,
  preset: DshReasoningPreset | null,
): string | null {
  if (preset && hasOwn(preset.efforts, level)) {
    return preset.efforts[level];
  }
  return level === "off" ? null : level;
}

/**
 * 在等级表上加/减一个等级，返回重排后的新表；减空则返回 `undefined`
 * （调用方应当删掉整个字段，而不是写 `{}`）。
 */
export function toggleDshReasoningLevel(
  current: DshReasoningEfforts | false | undefined,
  level: string,
  preset: DshReasoningPreset | null,
): DshReasoningEfforts | undefined {
  const base = isDshReasoningEfforts(current) ? current : {};
  const next: DshReasoningEfforts = { ...base };
  if (hasOwn(next, level)) delete next[level];
  else next[level] = dshReasoningWireFor(level, preset);
  return normalizeDshReasoningEfforts(next) || undefined;
}

/** DSH credential reference names must match the backend's env-var pattern. */
export function isValidCredentialRef(value: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/.test(value);
}
