import type {
  UsageGranularity,
  UsageRangePreset,
  UsageRangeSelection,
} from "@/types/usage";

const DAY_SECONDS = 24 * 60 * 60;
const DAY_MS = DAY_SECONDS * 1000;

export interface ResolvedUsageRange {
  startDate: number;
  endDate: number;
}

function getStartOfLocalDayDate(nowMs: number): Date {
  const date = new Date(nowMs);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function getPresetLookbackStart(
  preset: Exclude<UsageRangePreset, "today" | "1d" | "all" | "custom">,
  nowMs: number,
): number {
  const dayCount = preset === "7d" ? 7 : preset === "14d" ? 14 : 30;
  return Math.floor(
    getStartOfLocalDayDate(nowMs - (dayCount - 1) * DAY_MS).getTime() / 1000,
  );
}

export function resolveUsageRange(
  selection: UsageRangeSelection,
  nowMs: number = Date.now(),
): ResolvedUsageRange {
  const endDate = Math.floor(nowMs / 1000);

  switch (selection.preset) {
    case "today":
      return {
        startDate: Math.floor(getStartOfLocalDayDate(nowMs).getTime() / 1000),
        endDate,
      };
    case "1d":
      return {
        startDate: endDate - DAY_SECONDS,
        endDate,
      };
    case "7d":
    case "14d":
    case "30d":
      return {
        startDate: getPresetLookbackStart(selection.preset, nowMs),
        endDate,
      };
    // 全部：从最早的记录算起，汇总和明细表按全量统计
    case "all":
      return { startDate: 0, endDate };
    case "custom": {
      const startDate = selection.customStartDate ?? endDate - DAY_SECONDS;
      const customEndDate = selection.liveEndTime
        ? endDate
        : (selection.customEndDate ?? endDate);
      return {
        startDate,
        endDate: customEndDate,
      };
    }
  }
}

/** 粒度下拉的选项顺序（由细到粗） */
export const USAGE_GRANULARITIES: readonly UsageGranularity[] = [
  "10m",
  "30m",
  "1h",
  "1d",
];

/** 粒度 → 后端 bucket_seconds */
export const USAGE_GRANULARITY_SECONDS: Record<UsageGranularity, number> = {
  "10m": 600,
  "30m": 1800,
  "1h": 3600,
  "1d": DAY_SECONDS,
};

export function getUsageGranularitySeconds(
  granularity: UsageGranularity,
): number {
  return USAGE_GRANULARITY_SECONDS[granularity];
}

/** 小于一天的粒度：图表用「日期 + 时:分」标签；1d 只显示日期 */
export function isSubDayUsageGranularity(
  granularity: UsageGranularity,
): boolean {
  return USAGE_GRANULARITY_SECONDS[granularity] < DAY_SECONDS;
}

/**
 * 时间范围对应的默认粒度。切换任何时间范围（预设或自定义日历）都按它重置。
 * today → 30m；1d / 7d → 1h；14d / 30d → 1d；
 * custom 跨度 > 7 天 → 1d，否则 1h；all 不显示粒度控件，兜底 1d。
 */
export function getDefaultUsageGranularity(
  selection: UsageRangeSelection,
  nowMs: number = Date.now(),
): UsageGranularity {
  switch (selection.preset) {
    case "today":
      return "30m";
    case "1d":
    case "7d":
      return "1h";
    case "14d":
    case "30d":
    case "all":
      return "1d";
    case "custom": {
      const { startDate, endDate } = resolveUsageRange(selection, nowMs);
      return endDate - startDate > 7 * DAY_SECONDS ? "1d" : "1h";
    }
  }
}

export function getUsageRangePresetLabel(
  preset: UsageRangePreset,
  t: (key: string, options?: { defaultValue?: string }) => string,
): string {
  switch (preset) {
    case "today":
      return t("usage.presetToday", { defaultValue: "当天" });
    case "1d":
      return t("usage.preset1d", { defaultValue: "1d" });
    case "7d":
      return t("usage.preset7d", { defaultValue: "7d" });
    case "14d":
      return t("usage.preset14d", { defaultValue: "14d" });
    case "30d":
      return t("usage.preset30d", { defaultValue: "30d" });
    case "all":
      return t("usage.presetAll", { defaultValue: "全部" });
    case "custom":
      return t("usage.customRange", { defaultValue: "日历筛选" });
  }
}
