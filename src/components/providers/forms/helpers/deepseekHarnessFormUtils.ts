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
   * 模型声明的思考等级表。`false` 是原生哨兵值，表示「该模型不提供思考参数」，
   * 与「未设置」（省略该字段）语义不同，必须原样保留。
   *
   * 类型故意放宽成 `unknown`：表单不是修复器，落盘里的 `null`、数组、数字等
   * 非法值也要原样带回去，交给保存前的硬校验显式拦下。加载时丢掉坏值会让
   * 「打开表单再保存」把非法配置静默洗白（审计 T5 第 2 点）。
   */
  reasoningEfforts?: unknown;
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
 * 深拷贝配置值。模型行会整表写回，嵌套对象若是同一引用，表单里的一次修改
 * 可能反向污染原始 `settingsConfig`；这里只复制普通对象 / 数组，其余标量按
 * 原值返回（包括 `undefined`，由调用方决定是否省略字段）。
 */
function cloneDshConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneDshConfigValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        cloneDshConfigValue(item),
      ]),
    );
  }
  return value;
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

      // 原生字段原样深拷贝，包括 `{}`、`null`、`true`、数组和非法 wire。
      // 这里禁止任何「顺手修复」：否则保存前的原生格式硬校验会被绕过，
      // 而且一次模型行编辑就会把非法值洗成合法值（审计 T5）。
      if (item.reasoningEfforts === undefined) {
        delete model.reasoningEfforts;
      } else {
        model.reasoningEfforts = cloneDshConfigValue(item.reasoningEfforts);
      }

      models.push(model);
    }
  }
  return models;
}

// ── 推理等级（reasoningEfforts）──────────────────────────────────────
//
// 逐条对齐 DSH 44.7 原生 schema 与设置页：
// - `dsh-llm-pi-ai/lib/index.js:1033` 字段定义、`:585-597` 校验；
// - `dsh-client-ui-settings-models/lib/client.js:265-369` 读取/写回/编辑器。
//
// 推理等级是**模型级**字段，只有三种合法形态：字段缺省（继承目录能力）、
// `false`（声明该模型非推理模型）、非空对象（精确声明可用档位）。档位固定
// 七档、由弱到强；值是该档位写进请求的 API 参数值，`null` 只允许给 `off`。
// 读取一律保序、保未知键：空串 / 非法 null / 非七档的键都留在表单里由校验
// 标错并在保存时拦截，绝不静默丢弃。

/** 档位，由弱到强（原生 `THINKING_LEVELS`，顺序不能动）。 */
export const DSH_REASONING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** 打开开关时播种的原生初始档位（`INITIAL_LEVELS`）。 */
export const DSH_REASONING_INITIAL_LEVELS = [
  "off",
  "low",
  "medium",
  "high",
] as const;

export type DshReasoningLevel = (typeof DSH_REASONING_LEVELS)[number];

/**
 * 有序的等级表条目（保留落盘顺序，含七档之外的未知键）。
 *
 * 值故意放宽为 `unknown`：原生 `readEfforts`（`client.js:291-296`）只按
 * `Object.entries` 原样读出，数字、布尔、`undefined` 都保留并交给校验标错；
 * 这里若过滤掉坏值，界面会少一行、用户也无从修复。
 */
export type DshReasoningEntries = Array<[string, unknown]>;

/** 原生校验错误：值缺失 / 缺少非 off 档位 / 档位不属于七档。 */
export type DshReasoningIssue =
  | { kind: "valueRequired"; level: string }
  | { kind: "needsLevel" }
  | { kind: "unknownLevel"; level: string };

export interface DshReasoningIssueLocation {
  modelId: string;
  issue: DshReasoningIssue;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDshReasoningLevelName(level: string): boolean {
  return (DSH_REASONING_LEVELS as readonly string[]).includes(level);
}

/**
 * 兼容读取落盘的 `reasoningEfforts`：`false` / `null` / 非对象 / 数组 一律
 * 视为「没有等级表」（返回 `undefined`）；普通对象按键顺序原样返回，未知键
 * 和任何值类型都保留（原生 `client.js:291-296` 同样不过滤），由
 * `dshReasoningIssue` 标错并在保存时拦截。
 */
export function readDshReasoningEntries(
  value: unknown,
): DshReasoningEntries | undefined {
  if (!isPlainObject(value)) return undefined;
  return Object.entries(value);
}

/** 档位默认 API 参数值：`off` → `null`，其余 → 档位名本身。 */
export function dshReasoningDefaultValue(level: string): string | null {
  return level === "off" ? null : level;
}

/** 开关打开时的原生初始表：`off: null, low, medium, high`。 */
export function dshReasoningInitialEntries(): DshReasoningEntries {
  return DSH_REASONING_INITIAL_LEVELS.map((level) => [
    level,
    dshReasoningDefaultValue(level),
  ]);
}

/**
 * 「添加档位」：优先取高于当前最高已用档位的第一个未用档位，否则取第一个
 * 未用档位（原生 `:351-357`）。七档用完时返回 `undefined`。
 */
export function dshReasoningNextLevel(
  used: readonly string[],
): string | undefined {
  const usedSet = new Set(used);
  const levels = DSH_REASONING_LEVELS as readonly string[];
  let highest = -1;
  for (const level of used) {
    const position = levels.indexOf(level);
    if (position > highest) highest = position;
  }
  for (let index = highest + 1; index < levels.length; index += 1) {
    if (!usedSet.has(levels[index])) return levels[index];
  }
  for (const level of levels) {
    if (!usedSet.has(level)) return level;
  }
  return undefined;
}

/**
 * 档位下拉选项，照抄原生 `client.js:370` 的 `choicesFor`：
 * `[...(levels.includes(current) ? [] : [current]), ...levels.filter(
 * choice => choice === current || !used.includes(choice))]`。
 *
 * 也就是说：当前值属于七档时按七档规范顺序排列（当前档位留在它原本的位置，
 * 不置顶）；只有当前值是七档之外的未知键（或空串）时，才把它放在最前面，
 * 保证不被静默改掉。签名里 `current` 是这一行的档位，`used` 是整张等级表的
 * 档位列表（含 `current` 自己）。
 */
export function dshReasoningLevelChoices(
  current: string,
  used: readonly string[],
): string[] {
  const canonical = DSH_REASONING_LEVELS as readonly string[];
  const choices: string[] = canonical.includes(current) ? [] : [current];
  for (const level of canonical) {
    if (level === current || !used.includes(level)) choices.push(level);
  }
  return choices;
}

/**
 * 换档：旧值是自定义参数值（字符串非空、不等于旧档位名）且新旧档位都不是
 * `off` 时保留，否则换成新档位的默认值（原生 `:348-350`）。
 *
 * 注意原生判空用 `wire.length > 0` 而不是 `trim()`：纯空白虽然不是合法 wire
 * （失焦时会被 `leaveValue` 复位），但换档本身不该顺手改写它。
 */
export function dshReasoningWithLevel(
  entries: ReadonlyArray<readonly [string, unknown]>,
  index: number,
  nextLevel: string,
): DshReasoningEntries {
  const next: DshReasoningEntries = entries.map(([level, wire]) => [
    level,
    wire,
  ]);
  const entry = next[index];
  if (!entry) return next;
  const [level, wire] = entry;
  const customWire =
    level !== "off" &&
    nextLevel !== "off" &&
    typeof wire === "string" &&
    wire.length > 0 &&
    wire !== level
      ? wire
      : undefined;
  next[index] = [nextLevel, customWire ?? dshReasoningDefaultValue(nextLevel)];
  return next;
}

/**
 * 参数值编辑，照抄原生 `client.js:358-364`：
 * `const trimmed = text.trim(); write(trimmed.length === 0 ? defaultValue(level) : trimmed)`。
 *
 * 所以非空输入也会 trim（不会把用户输入的首尾空格写进 API 参数值），空串 /
 * 纯空白则重置为该档位默认值。
 */
export function dshReasoningWithWire(
  entries: ReadonlyArray<readonly [string, unknown]>,
  index: number,
  text: string,
): DshReasoningEntries {
  const next: DshReasoningEntries = entries.map(([level, wire]) => [
    level,
    wire,
  ]);
  const entry = next[index];
  if (!entry) return next;
  const trimmed = text.trim();
  next[index] = [
    entry[0],
    trimmed.length === 0 ? dshReasoningDefaultValue(entry[0]) : trimmed,
  ];
  return next;
}

/**
 * 校验等级表。前两步照抄原生 `dsh-llm-pi-ai/lib/index.js:585-597` 的顺序：
 * 值是否合法 → 是否至少有一个非 `off` 档位。
 *
 * 第三步（未知键报 `unknownLevel`）是 **CCS 比原生更严的策略，不是原生行为**：
 * 原生 runtime 只遍历七档，七档之外的键直接忽略（`index.js:588-591`），原生 UI
 * 也会把未知键原样保留、允许继续编辑（`client.js:291-296`）。CCS 为了让无效键
 * 可见并阻止落盘，选择在这里拦住它；同理 `findDshReasoningIssue*` 会因此在保存
 * 前报错。改动这里的松紧度前请先确认这是有意的产品决策。
 */
export function dshReasoningIssue(
  value: unknown,
): DshReasoningIssue | undefined {
  if (value === undefined || value === false) return undefined;
  if (!isPlainObject(value)) return { kind: "needsLevel" };
  const entries = Object.entries(value);
  if (entries.length === 0) return { kind: "needsLevel" };

  for (const [level, wire] of entries) {
    const valid =
      (typeof wire === "string" && wire.trim() !== "") ||
      (wire === null && level === "off");
    if (!valid) return { kind: "valueRequired", level };
  }

  for (const [level] of entries) {
    if (!isDshReasoningLevelName(level)) return { kind: "unknownLevel", level };
  }

  if (!entries.some(([level]) => level !== "off"))
    return { kind: "needsLevel" };
  return undefined;
}

/**
 * 保存巡检只管「会落盘的行」：T2 的保存路径先 `pruneDshModelRows` 再校验，
 * 空 ID 行会被整行删掉，不能因为空行上残留的非法 `reasoningEfforts` 误拦保存。
 */
function hasDshModelId(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** 按模型顺序返回第一个 `reasoningEfforts` 非法的模型（跳过空 ID 行）。 */
export function findDshReasoningIssue(
  models: readonly DshModel[],
): DshReasoningIssueLocation | undefined {
  for (const model of models) {
    if (!model || typeof model !== "object") continue;
    if (!hasDshModelId(model.id)) continue;
    const issue = dshReasoningIssue(model.reasoningEfforts);
    if (issue) return { modelId: model.id, issue };
  }
  return undefined;
}

/** 档位参数值在输入框里的只读文本；任何脏值都不能让渲染抛错。 */
export function formatDshReasoningWire(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return typeof value === "object"
      ? (JSON.stringify(value) ?? "")
      : String(value);
  } catch {
    try {
      return String(value);
    } catch {
      return "";
    }
  }
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
 * 从原始 settings JSON 值检查 `models[].reasoningEfforts`，不经过
 * `normalizeDshModels`：这样手工粘贴进来的非法值也能在保存前拦住。
 * 与 `findDshReasoningIssue` 一样跳过空 ID 行（保存时会被 prune 掉）。
 */
export function findDshReasoningIssueInConfig(
  config: unknown,
): DshReasoningIssueLocation | undefined {
  if (!isPlainObject(config)) return undefined;
  const models = config.models;
  if (!Array.isArray(models)) return undefined;
  for (const entry of models) {
    if (!isPlainObject(entry)) continue;
    const modelId = entry.id;
    if (!hasDshModelId(modelId)) continue;
    const issue = dshReasoningIssue(entry.reasoningEfforts);
    if (issue) return { modelId, issue };
  }
  return undefined;
}
/** DSH credential reference names must match the backend's env-var pattern. */
export function isValidCredentialRef(value: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/.test(value);
}
