import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useUsageTrends } from "@/lib/query/usage";
import { Loader2 } from "lucide-react";
import {
  fmtInt,
  formatTokensShort,
  getLocaleFromLanguage,
  parseFiniteNumber,
  type TokenUnit,
} from "./format";
import { resolveUsageRange } from "@/lib/usageRange";
import type { UsageRangeSelection } from "@/types/usage";
import { useMoneyFormat } from "@/hooks/useMoneyFormat";
import { useTokenFormat } from "@/hooks/useTokenFormat";
import { USAGE_CHOICE_KEYS, useRememberedChoice } from "./rememberedChoice";
import {
  UsageTrendTooltip,
  USAGE_TREND_MAX_MODEL_ROWS,
  USAGE_TREND_MODEL_COLORS,
  USAGE_TREND_OTHER_MODEL_COLOR,
  USAGE_TREND_TOKEN_COLORS,
  getModelTrendColor,
  type UsageTrendModelStatLike,
} from "./UsageTrendTooltip";

interface UsageTrendChartProps {
  range: UsageRangeSelection;
  rangeLabel: string;
  appType?: string;
  providerName?: string;
  /** undefined = 全部模型；有值 = 单个模型（tooltip 不再拆模型区）。 */
  model?: string;
  refreshIntervalMs: number;
}

export interface UsageTrendStatLike {
  date: string;
  requestCount?: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  totalCost: string | number;
  /** 仅「全部模型」时后端才给：按模型拆分的 token 总量（并行开发的可选契约）。 */
  models?: UsageTrendModelStatLike[];
}

export interface UsageTrendChartPoint {
  /** Unique category key for Recharts — must not collide across years. */
  xKey: string;
  rawDate: string;
  /** Short tick label shown on the X axis. */
  label: string;
  /** Fuller label used by the tooltip. */
  tooltipLabel: string;
  hour: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** 请求数（「请求」指标） */
  requests: number;
  /** 真实消耗 Tokens = 新增输入 + 输出 + 缓存写入 + 缓存命中（和指标卡同口径） */
  tokens: number;
  cost: number | null;
  /** 仅「全部模型」时非空：按模型拆分的 token 总量。 */
  models?: UsageTrendModelStatLike[];
}

/** Build chart rows from backend trend stats. Exported for unit tests. */
export function buildUsageTrendChartData(
  trends: UsageTrendStatLike[] | undefined,
  options: {
    isHourly: boolean;
    dateLocale: string;
    /** Inclusive range endpoints (unix seconds). Used to decide year labels. */
    startDate: number;
    endDate: number;
  },
): UsageTrendChartPoint[] {
  const { isHourly, dateLocale, startDate, endDate } = options;
  const startYear = new Date(startDate * 1000).getFullYear();
  const endYear = new Date(endDate * 1000).getFullYear();
  const spansMultipleYears = startYear !== endYear;

  return (
    trends?.map((stat) => {
      const pointDate = new Date(stat.date);
      const cost = parseFiniteNumber(stat.totalCost);
      // Prefer a stable unique key from the source timestamp / date string.
      // Falling back to ISO keeps categories unique even if the backend
      // returns sparse points that share the same local MM/DD across years.
      const xKey = stat.date;
      const tooltipLabel = isHourly
        ? pointDate.toLocaleString(dateLocale, {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          })
        : pointDate.toLocaleDateString(dateLocale, {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          });
      const label = isHourly
        ? pointDate.toLocaleString(dateLocale, {
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          })
        : spansMultipleYears
          ? pointDate.toLocaleDateString(dateLocale, {
              year: "2-digit",
              month: "2-digit",
              day: "2-digit",
            })
          : pointDate.toLocaleDateString(dateLocale, {
              month: "2-digit",
              day: "2-digit",
            });

      return {
        xKey,
        rawDate: stat.date,
        label,
        tooltipLabel,
        hour: pointDate.getHours(),
        inputTokens: stat.totalInputTokens,
        outputTokens: stat.totalOutputTokens,
        cacheCreationTokens: stat.totalCacheCreationTokens,
        cacheReadTokens: stat.totalCacheReadTokens,
        requests: stat.requestCount ?? 0,
        tokens:
          stat.totalInputTokens +
          stat.totalOutputTokens +
          stat.totalCacheCreationTokens +
          stat.totalCacheReadTokens,
        cost: cost ?? null,
        models: stat.models,
      };
    }) || []
  );
}

export interface UsageTrendModelSeries {
  /** Recharts 用的稳定 key（避免模型名里的点被当成字段路径）。 */
  key: string;
  /** null = 「其他 N 个模型」聚合序列。 */
  model: string | null;
  count?: number;
  totalTokens: number;
  color: string;
}

/** 图表行 = 原始趋势点 + 每个模型序列当天的 token 数。 */
export type UsageTrendChartRow = UsageTrendChartPoint & {
  modelValues: Record<string, number>;
};

/**
 * 按整个时间范围的总 token 把模型排成固定顺序：前 limit-1 个模型各一条序列，
 * 其余聚合成一条「其他」。柱状图用它做堆叠段，面积图用它加模型曲线。
 */
export function buildUsageTrendModelSeries(
  chartData: UsageTrendChartPoint[],
  limit: number = USAGE_TREND_MAX_MODEL_ROWS,
): UsageTrendModelSeries[] {
  const totals = new Map<string, number>();
  for (const point of chartData) {
    for (const entry of point.models ?? []) {
      totals.set(
        entry.model,
        (totals.get(entry.model) ?? 0) + entry.totalTokens,
      );
    }
  }
  if (totals.size === 0) return [];

  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const cap = Math.max(1, limit);
  const visible = sorted.length > cap ? sorted.slice(0, cap - 1) : sorted;
  const series: UsageTrendModelSeries[] = visible.map(
    ([model, totalTokens], index) => ({
      key: `model-${index}`,
      model,
      totalTokens,
      color: USAGE_TREND_MODEL_COLORS[index % USAGE_TREND_MODEL_COLORS.length],
    }),
  );
  if (sorted.length > cap) {
    const rest = sorted.slice(cap - 1);
    series.push({
      key: "model-other",
      model: null,
      count: rest.length,
      totalTokens: rest.reduce((sum, [, value]) => sum + value, 0),
      color: USAGE_TREND_OTHER_MODEL_COLOR,
    });
  }
  return series;
}

/** 给每个图表行补上模型序列对应的 token 数，供 Recharts 的 dataKey 函数读取。 */
export function attachUsageTrendModelValues(
  chartData: UsageTrendChartPoint[],
  series: UsageTrendModelSeries[],
): UsageTrendChartRow[] {
  const keyByModel = new Map<string, string>();
  let otherKey: string | undefined;
  for (const entry of series) {
    if (entry.model == null) {
      otherKey = entry.key;
    } else {
      keyByModel.set(entry.model, entry.key);
    }
  }

  return chartData.map((point) => {
    const modelValues: Record<string, number> = {};
    for (const entry of series) modelValues[entry.key] = 0;
    for (const entry of point.models ?? []) {
      const key = keyByModel.get(entry.model) ?? otherKey;
      if (key != null) {
        modelValues[key] = (modelValues[key] ?? 0) + entry.totalTokens;
      }
    }
    return { ...point, modelValues };
  });
}

/** Resolve a tick label by the unique category key (not by filtered tick index). */
export function formatUsageTrendTickLabel(
  xKey: string,
  chartData: UsageTrendChartPoint[],
): string {
  const point = chartData.find((row) => row.xKey === xKey);
  return point?.label ?? xKey;
}

/** Y 轴 Token/请求数刻度：和用量页其他数字共用一套单位表（国际缩写 / 中文数位）。 */
export function formatUsageTrendTokenTickLabel(
  value: unknown,
  unit: TokenUnit,
  lang: string,
): string {
  const num = parseFiniteNumber(value);
  if (num == null) return "--";

  return formatTokensShort(num, lang, unit);
}

const TREND_METRICS = ["requests", "tokens", "cost"] as const;
type TrendMetric = (typeof TREND_METRICS)[number];
const CHART_TYPES = ["bar", "area"] as const;
type ChartType = (typeof CHART_TYPES)[number];

const AXIS_TICK = { fill: "var(--text-3)", fontSize: 11 };

/**
 * tokens 堆叠序列（stackId="tokens"）里每个类型段的小图例标签键，
 * 顺序即画图顺序（浅 → 深蓝）。
 */
const TOKEN_STACK_SERIES = [
  { dataKey: "cacheReadTokens", legendKey: "usage.trend.legendHit" },
  { dataKey: "inputTokens", legendKey: "usage.trend.legendMiss" },
  { dataKey: "cacheCreationTokens", legendKey: "usage.trend.legendWrite" },
  { dataKey: "outputTokens", legendKey: "usage.trend.legendOutput" },
] as const;

export function UsageTrendChart({
  range,
  rangeLabel,
  appType,
  providerName,
  model,
  refreshIntervalMs,
}: UsageTrendChartProps) {
  const { t, i18n } = useTranslation();
  const { money, moneyTick, rate } = useMoneyFormat();
  const { tokenUnit } = useTokenFormat();
  const [metric, setMetric] = useRememberedChoice<TrendMetric>(
    USAGE_CHOICE_KEYS.trendMetric,
    TREND_METRICS,
    "tokens",
  );
  const [chartType, setChartType] = useRememberedChoice<ChartType>(
    USAGE_CHOICE_KEYS.trendChartType,
    CHART_TYPES,
    "bar",
  );
  const { startDate, endDate } = resolveUsageRange(range);
  const { data: trends, isLoading } = useUsageTrends(
    range,
    { appType, providerName, model },
    {
      refetchInterval: refreshIntervalMs > 0 ? refreshIntervalMs : false,
    },
  );

  const durationSeconds = Math.max(endDate - startDate, 0);
  const isHourly = durationSeconds <= 24 * 60 * 60;
  const language = i18n.resolvedLanguage || i18n.language || "en";
  const dateLocale = getLocaleFromLanguage(language);

  const chartData = useMemo(
    () =>
      buildUsageTrendChartData(trends, {
        isHourly,
        dateLocale,
        startDate,
        endDate,
      }),
    [trends, isHourly, dateLocale, startDate, endDate],
  );

  // 全部模型的 token 趋势：柱状图按模型堆叠，面积图在总 token 之外再加模型曲线。
  const modelSeries = useMemo(
    () =>
      metric === "tokens" && !model
        ? buildUsageTrendModelSeries(chartData)
        : [],
    [metric, model, chartData],
  );
  const chartRows = useMemo(
    () => attachUsageTrendModelValues(chartData, modelSeries),
    [chartData, modelSeries],
  );
  const modelColors = useMemo(() => {
    const colors: Record<string, string> = {};
    for (const entry of modelSeries) {
      if (entry.model != null) colors[entry.model] = entry.color;
    }
    return colors;
  }, [modelSeries]);

  // 单指标：图只画切换选中的那一个指标，单 Y 轴，图例和 tooltip 跟着走。
  const metricLabel =
    metric === "requests"
      ? t("usage.trend.requestsLegend")
      : metric === "tokens"
        ? t("usage.trend.tokens")
        : t("usage.trend.cost");

  const formatMetric = (value: unknown) =>
    metric === "cost" ? money(value, 4) : fmtInt(value, dateLocale);
  const formatYTick = (value: unknown) =>
    metric === "cost"
      ? moneyTick(value)
      : formatUsageTrendTokenTickLabel(value, tokenUnit, language);

  const Chart = chartType === "bar" ? BarChart : AreaChart;
  // 成本先换算成显示币种再画，Y 轴才会按这个币种挑整齐的刻度。
  const dataKey =
    metric === "cost"
      ? (point: UsageTrendChartPoint) =>
          point.cost == null ? null : point.cost * rate
      : metric;

  // tokens 指标按类型堆叠画图；序列里有缓存写入才画那一段。
  const hasCacheCreation =
    metric === "tokens" &&
    chartData.some((point) => point.cacheCreationTokens !== 0);
  const tokenStack =
    metric === "tokens"
      ? TOKEN_STACK_SERIES.filter(
          (series) =>
            hasCacheCreation || series.dataKey !== "cacheCreationTokens",
        )
      : [];

  const renderTooltip = ({ active, payload }: any) => {
    if (!active || !payload || payload.length === 0) return null;
    const point = payload[0]?.payload as UsageTrendChartPoint | undefined;
    const heading = point?.tooltipLabel ?? point?.label ?? "";

    if (metric === "tokens") {
      return (
        <UsageTrendTooltip
          point={point}
          hasCacheCreation={hasCacheCreation}
          showModels={!model && !!point?.models?.length}
          modelColors={modelColors}
          locale={dateLocale}
        />
      );
    }

    return (
      <div className="rounded-[8px] border border-border bg-surface px-3 py-2 text-caption text-fg-1 shadow-v7-md">
        <p className="mb-1 font-semibold">{heading}</p>
        <div className="flex items-center gap-2 tabular-nums">
          <span
            aria-hidden="true"
            className="h-2 w-2 rounded-[2px] bg-chart-1"
          />
          <span className="text-fg-2">{metricLabel}</span>
          <span className="ms-auto ps-3">
            {formatMetric(point ? point[metric] : payload[0]?.value)}
          </span>
        </div>
      </div>
    );
  };

  return (
    <section
      aria-labelledby="usage-trend-title"
      className="shrink-0 rounded-panel border border-border bg-surface px-4 py-2.5"
    >
      <div className="flex min-h-7 flex-wrap items-center gap-x-3.5 gap-y-1">
        <h2
          id="usage-trend-title"
          className="m-0 whitespace-nowrap text-caption font-semibold text-fg-2"
        >
          {t("usage.trend.title", { range: rangeLabel })}
        </h2>
        <span
          data-testid="usage-trend-legend"
          className="inline-flex flex-wrap items-center gap-1.5 whitespace-nowrap text-caption text-fg-2"
        >
          {metric === "tokens" &&
          chartType === "area" &&
          tokenStack.length > 0 ? (
            tokenStack.map((series) => (
              <span
                key={series.dataKey}
                className="inline-flex items-center gap-1"
              >
                <span
                  aria-hidden="true"
                  className="h-2.5 w-2.5 rounded-[2px]"
                  style={{ background: seriesColor(series.dataKey) }}
                />
                {t(series.legendKey)}
              </span>
            ))
          ) : (
            <span className="inline-flex items-center gap-1">
              <span
                aria-hidden="true"
                className="h-2.5 w-2.5 rounded-[2px]"
                style={{
                  background:
                    metric === "tokens" && chartType === "bar" && model
                      ? getModelTrendColor(model)
                      : "var(--chart-1)",
                }}
              />
              {metric === "tokens" && chartType === "bar" && model
                ? model
                : metricLabel}
            </span>
          )}
        </span>
        <div className="flex-1" />
        <SegmentedControl<TrendMetric>
          size="sm"
          aria-label={t("usage.trend.metricLabel")}
          value={metric}
          onValueChange={setMetric}
          items={[
            { value: "tokens", label: t("usage.trend.tokens") },
            { value: "requests", label: t("usage.trend.requests") },
            { value: "cost", label: t("usage.trend.cost") },
          ]}
        />
        <SegmentedControl<ChartType>
          size="sm"
          aria-label={t("usage.trend.chartTypeLabel")}
          value={chartType}
          onValueChange={setChartType}
          items={[
            { value: "bar", label: t("usage.trend.bar") },
            { value: "area", label: t("usage.trend.area") },
          ]}
        />
      </div>

      {modelSeries.length > 0 && (
        <div
          data-testid="usage-trend-model-legend"
          className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-fg-2"
        >
          <span className="text-fg-3">{t("usage.trend.modelSection")}</span>
          {modelSeries.map((series) => (
            <span
              key={series.key}
              className="inline-flex items-center gap-1 whitespace-nowrap"
            >
              <span
                aria-hidden="true"
                className="h-2.5 w-2.5 rounded-[2px]"
                style={{ background: series.color }}
              />
              {series.model ??
                t("usage.trend.moreModels", { count: series.count ?? 0 })}
            </span>
          ))}
        </div>
      )}

      <div className="mt-1 h-[132px] w-full">
        {isLoading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-fg-3" />
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <Chart
              data={chartRows}
              margin={{ top: 6, right: 0, left: 0, bottom: 0 }}
            >
              <CartesianGrid
                vertical={false}
                stroke="var(--chart-grid)"
                strokeWidth={1}
              />
              {/* 🔴 分类键必须是后端 RFC3339 桶时间戳（xKey），不能用显示文字，否则跨年错位 */}
              <XAxis
                dataKey="xKey"
                axisLine={false}
                tickLine={false}
                tick={AXIS_TICK}
                tickMargin={6}
                minTickGap={12}
                tickFormatter={(value) =>
                  formatUsageTrendTickLabel(String(value), chartRows)
                }
                allowDuplicatedCategory={false}
              />
              <YAxis
                width={44}
                axisLine={false}
                tickLine={false}
                tick={AXIS_TICK}
                tickCount={3}
                tickFormatter={formatYTick}
              />
              <Tooltip
                content={renderTooltip}
                cursor={
                  chartType === "bar"
                    ? { fill: "var(--bg-subtle)" }
                    : { stroke: "var(--text-3)", strokeDasharray: "3 3" }
                }
              />
              {metric === "tokens" ? (
                chartType === "bar" ? (
                  // 每个时间桶一根柱：柱内按「模型」的 token 总量多段堆叠，
                  // 不再按 token 类型拆段，也绝不能并排多根柱。
                  modelSeries.length > 0 ? (
                    modelSeries.map((series, index) => (
                      <Bar
                        key={series.key}
                        dataKey={(row: any) =>
                          row.modelValues?.[series.key] ?? 0
                        }
                        name={
                          series.model ??
                          t("usage.trend.moreModels", {
                            count: series.count ?? 0,
                          })
                        }
                        stackId="model-tokens"
                        fill={series.color}
                        radius={
                          index === modelSeries.length - 1
                            ? [3, 3, 0, 0]
                            : undefined
                        }
                        maxBarSize={36}
                        isAnimationActive={false}
                      />
                    ))
                  ) : (
                    // 单个模型（或后端没有模型拆分数据）时，柱子只表达这个
                    // 模型/总量的 token，不再拆 token 类型。
                    <Bar
                      dataKey="tokens"
                      name={model ?? metricLabel}
                      fill={
                        model ? getModelTrendColor(model) : "var(--chart-1)"
                      }
                      radius={[3, 3, 0, 0]}
                      maxBarSize={36}
                      isAnimationActive={false}
                    />
                  )
                ) : (
                  <>
                    {/* 总 token 的构成仍然是按 token 类型堆叠的面积 */}
                    {tokenStack.map((series) => (
                      <Area
                        key={series.dataKey}
                        type="monotone"
                        dataKey={series.dataKey}
                        name={t(series.legendKey)}
                        stackId="tokens"
                        stroke={seriesColor(series.dataKey)}
                        strokeWidth={2}
                        fill={seriesColor(series.dataKey)}
                        fillOpacity={0.16}
                        dot={chartRows.length === 1 ? { r: 3 } : false}
                        activeDot={{ r: 4 }}
                        isAnimationActive={false}
                      />
                    ))}
                    {/* 在总 token 面积之上叠加每个模型的 token 消耗曲线 */}
                    {modelSeries.map((series) => (
                      <Area
                        key={series.key}
                        className="usage-trend-model-curve"
                        type="monotone"
                        dataKey={(row: any) =>
                          row.modelValues?.[series.key] ?? 0
                        }
                        name={
                          series.model ??
                          t("usage.trend.moreModels", {
                            count: series.count ?? 0,
                          })
                        }
                        stroke={series.color}
                        strokeWidth={1.5}
                        fill="none"
                        fillOpacity={0}
                        dot={false}
                        activeDot={{ r: 3 }}
                        isAnimationActive={false}
                      />
                    ))}
                  </>
                )
              ) : chartType === "bar" ? (
                <Bar
                  dataKey={dataKey}
                  name={metricLabel}
                  fill="var(--chart-1)"
                  radius={[3, 3, 0, 0]}
                  maxBarSize={36}
                  isAnimationActive={false}
                />
              ) : (
                <Area
                  type="monotone"
                  dataKey={dataKey}
                  name={metricLabel}
                  stroke="var(--chart-1)"
                  strokeWidth={2}
                  fill="var(--chart-1)"
                  fillOpacity={0.16}
                  dot={chartRows.length === 1 ? { r: 3 } : false}
                  activeDot={{ r: 4 }}
                  isAnimationActive={false}
                />
              )}
            </Chart>
          </ResponsiveContainer>
        )}
      </div>
    </section>
  );
}

/** 堆叠段颜色：图、tooltip、图例共用同一套浅 → 深蓝。 */
function seriesColor(dataKey: string): string {
  switch (dataKey) {
    case "cacheReadTokens":
      return USAGE_TREND_TOKEN_COLORS.cacheRead;
    case "inputTokens":
      return USAGE_TREND_TOKEN_COLORS.input;
    case "cacheCreationTokens":
      return USAGE_TREND_TOKEN_COLORS.cacheCreation;
    default:
      return USAGE_TREND_TOKEN_COLORS.output;
  }
}
