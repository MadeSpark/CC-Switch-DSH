import { useTranslation } from "react-i18next";
import { fmtInt } from "./format";

/** 后端 DailyStats.models 的可选字段（并行开发，按可选契约写）。 */
export interface UsageTrendModelStatLike {
  model: string;
  totalTokens: number;
}

/** Tooltip 需要的最小数据形状（UsageTrendChartPoint 的子集）。 */
export interface UsageTrendTooltipPointLike {
  tooltipLabel?: string;
  label?: string;
  cacheReadTokens: number;
  inputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  models?: UsageTrendModelStatLike[];
}

/** tokens 堆叠序列的颜色：浅 → 深蓝，图、tooltip、图例共用一套。 */
export const USAGE_TREND_TOKEN_COLORS = {
  cacheRead: "#93C5FD",
  input: "#3B82F6",
  cacheCreation: "#2563EB",
  output: "#1E40AF",
} as const;

export type UsageTrendTokenRowKey = keyof typeof USAGE_TREND_TOKEN_COLORS;

export interface UsageTrendTokenRow {
  key: UsageTrendTokenRowKey;
  labelKey: string;
  value: number;
  color: string;
}

const TOKEN_ROW_DEFS: ReadonlyArray<{
  key: UsageTrendTokenRowKey;
  labelKey: string;
}> = [
  { key: "cacheRead", labelKey: "usage.trend.tokenHit" },
  { key: "input", labelKey: "usage.trend.tokenMiss" },
  { key: "cacheCreation", labelKey: "usage.trend.tokenWrite" },
  { key: "output", labelKey: "usage.trend.tokenOutput" },
];

/**
 * tooltip 的 token 明细行：输入（命中缓存）/ 输入（未命中缓存）/ 缓存写入 / 输出。
 * 整个序列都没有缓存写入时（hasCacheCreation=false）隐藏「缓存写入」行。
 */
export function buildUsageTrendTokenRows(
  point: UsageTrendTooltipPointLike | undefined,
  hasCacheCreation: boolean,
): UsageTrendTokenRow[] {
  if (!point) return [];
  const values: Record<UsageTrendTokenRowKey, number> = {
    cacheRead: point.cacheReadTokens,
    input: point.inputTokens,
    cacheCreation: point.cacheCreationTokens,
    output: point.outputTokens,
  };
  return TOKEN_ROW_DEFS.filter(
    (def) => def.key !== "cacheCreation" || hasCacheCreation,
  ).map((def) => ({
    key: def.key,
    labelKey: def.labelKey,
    value: values[def.key],
    color: USAGE_TREND_TOKEN_COLORS[def.key],
  }));
}

/**
 * 模型曲线/柱段的取色盘。图的序列按 token 总量排序后按顺序取色，
 * 保证同一张图里的模型颜色互不相同；tooltip 通过 modelColors 复用同一套映射。
 */
export const USAGE_TREND_MODEL_COLORS = [
  "#6366F1",
  "#EC4899",
  "#14B8A6",
  "#F59E0B",
  "#8B5CF6",
  "#10B981",
  "#F97316",
  "#06B6D4",
  "#EF4444",
  "#84CC16",
] as const;

/** 「其他 N 个模型」聚合段/曲线的颜色。 */
export const USAGE_TREND_OTHER_MODEL_COLOR = "#94A3B8";

/** 无图色映射时的兜底：按模型名 hash 稳定取色。 */
export function getModelTrendColor(name: string): string {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return USAGE_TREND_MODEL_COLORS[
    (hash >>> 0) % USAGE_TREND_MODEL_COLORS.length
  ];
}

export interface UsageTrendModelRow {
  /** null 表示聚合出来的「其他 {{count}} 个模型」行。 */
  model: string | null;
  /** 聚合行包含的模型个数；非聚合行没有。 */
  count?: number;
  totalTokens: number;
  color: string;
}

/**
 * 模型区最多显示的行数，其余聚合成一行「其他」。图的模型序列、图例、
 * tooltip 共用这个上限，保证三处展示的模型集合一致。
 */
export const USAGE_TREND_MAX_MODEL_ROWS = 10;

/**
 * 「全部模型」时 tooltip 的模型区行：按 token 总量降序，超过 limit 行的把剩余
 * 模型聚合成一行（数值为剩余之和）。没有模型数据时返回 null（不渲染模型区）。
 * colors 由图表按范围总量排序后生成，传进来后 tooltip 和图保持同色。
 */
export function buildUsageTrendModelRows(
  models: UsageTrendModelStatLike[] | undefined,
  limit: number = USAGE_TREND_MAX_MODEL_ROWS,
  colors?: Record<string, string>,
): UsageTrendModelRow[] | null {
  if (!models || models.length === 0) return null;
  const sorted = [...models].sort((a, b) => b.totalTokens - a.totalTokens);
  const toRow = (entry: UsageTrendModelStatLike): UsageTrendModelRow => ({
    model: entry.model,
    totalTokens: entry.totalTokens,
    color: colors?.[entry.model] ?? getModelTrendColor(entry.model),
  });
  if (sorted.length <= limit) {
    return sorted.map(toRow);
  }
  const head = sorted.slice(0, limit - 1).map(toRow);
  const rest = sorted.slice(limit - 1);
  return [
    ...head,
    {
      model: null,
      count: rest.length,
      totalTokens: rest.reduce((sum, entry) => sum + entry.totalTokens, 0),
      color: USAGE_TREND_OTHER_MODEL_COLOR,
    },
  ];
}

export interface UsageTrendTooltipProps {
  point: UsageTrendTooltipPointLike | undefined;
  /** 整个序列有缓存写入时才显示「缓存写入」行。 */
  hasCacheCreation: boolean;
  /** 仅「全部模型」（model prop 为空）且有按模型拆分的数据时才显示模型区。 */
  showModels: boolean;
  /** 图的模型颜色映射，保证 tooltip 和图例、曲线同色。 */
  modelColors?: Record<string, string>;
  /** 千分位数字用的 locale。 */
  locale?: string;
}

/** tokens 指标的 hover tooltip：token 类型明细（+ 全部模型时的模型区）。 */
export function UsageTrendTooltip({
  point,
  hasCacheCreation,
  showModels,
  modelColors,
  locale,
}: UsageTrendTooltipProps) {
  const { t } = useTranslation();
  const heading = point?.tooltipLabel ?? point?.label ?? "";
  const tokenRows = buildUsageTrendTokenRows(point, hasCacheCreation);
  const modelRows = showModels
    ? buildUsageTrendModelRows(
        point?.models,
        USAGE_TREND_MAX_MODEL_ROWS,
        modelColors,
      )
    : null;

  return (
    <div className="rounded-[8px] border border-border bg-surface px-3 py-2 text-caption text-fg-1 shadow-v7-md">
      <p className="mb-1 font-semibold">{heading}</p>
      {tokenRows.map((row) => (
        <div key={row.key} className="flex items-center gap-2 tabular-nums">
          <span
            aria-hidden="true"
            className="h-2 w-2 shrink-0 rounded-[2px]"
            style={{ background: row.color }}
          />
          <span className="text-fg-2">{t(row.labelKey)}</span>
          <span className="ms-auto ps-3">{fmtInt(row.value, locale)}</span>
        </div>
      ))}
      {modelRows && (
        <div className="mt-1.5 border-t border-border pt-1.5">
          <p className="mb-1 text-fg-3">{t("usage.trend.modelSection")}</p>
          {modelRows.map((row, index) => (
            <div
              key={row.model ?? `more-${index}`}
              className="flex items-center gap-2 tabular-nums"
            >
              <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rounded-[2px]"
                style={{ background: row.color }}
              />
              <span className="text-fg-2">
                {row.model ??
                  t("usage.trend.moreModels", { count: row.count ?? 0 })}
              </span>
              <span className="ms-auto ps-3">
                {fmtInt(row.totalTokens, locale)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
