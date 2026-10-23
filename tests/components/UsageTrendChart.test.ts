import { describe, expect, it } from "vitest";
import {
  attachUsageTrendModelValues,
  buildUsageTrendChartData,
  buildUsageTrendModelSeries,
  formatUsageTrendTokenTickLabel,
  formatUsageTrendTickLabel,
} from "@/components/usage/UsageTrendChart";
import {
  buildUsageTrendModelRows,
  buildUsageTrendTokenRows,
} from "@/components/usage/UsageTrendTooltip";

const day = (isoDate: string) =>
  ({
    date: `${isoDate}T12:00:00.000Z`,
    totalInputTokens: 100,
    totalOutputTokens: 50,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    totalCost: "0.01",
  }) as const;

describe("buildUsageTrendChartData (#6302)", () => {
  it("keeps unique x-axis keys when the same MM/DD appears in multiple years", () => {
    // 2025-04-27 and 2026-04-27 share the same MM/DD tick text in single-year
    // formatting. Using that text as the Recharts category key made activeDots
    // jump to the earlier year's point while the tooltip followed the cursor.
    const startDate = Math.floor(Date.parse("2025-01-01T00:00:00Z") / 1000);
    const endDate = Math.floor(Date.parse("2026-08-10T00:00:00Z") / 1000);

    const points = buildUsageTrendChartData(
      [day("2025-04-27"), day("2026-04-27")],
      {
        isHourly: false,
        dateLocale: "en-US",
        startDate,
        endDate,
      },
    );

    expect(points).toHaveLength(2);
    expect(points[0].xKey).not.toBe(points[1].xKey);
    expect(points[0].xKey).toContain("2025-04-27");
    expect(points[1].xKey).toContain("2026-04-27");
    // Tooltip always carries a year so the user can tell which April it is.
    expect(points[0].tooltipLabel).toMatch(/2025/);
    expect(points[1].tooltipLabel).toMatch(/2026/);
  });

  it("includes a year in the axis tick when the selected range spans years", () => {
    const startDate = Math.floor(Date.parse("2025-01-01T00:00:00Z") / 1000);
    const endDate = Math.floor(Date.parse("2026-08-10T00:00:00Z") / 1000);

    const points = buildUsageTrendChartData([day("2026-04-27")], {
      isHourly: false,
      dateLocale: "en-US",
      startDate,
      endDate,
    });

    expect(points[0].label).toMatch(/26|2026/);
  });

  it("keeps short MM/DD ticks for single-year ranges", () => {
    const startDate = Math.floor(Date.parse("2026-01-01T00:00:00Z") / 1000);
    const endDate = Math.floor(Date.parse("2026-08-10T00:00:00Z") / 1000);

    const points = buildUsageTrendChartData([day("2026-04-27")], {
      isHourly: false,
      dateLocale: "en-US",
      startDate,
      endDate,
    });

    // en-US 2-digit month/day — should not need a year prefix inside one year.
    expect(points[0].label).not.toMatch(/2026/);
    expect(points[0].tooltipLabel).toMatch(/2026/);
  });
});

describe("formatUsageTrendTickLabel", () => {
  it("resolves labels by xKey even when the tick index is thinned", () => {
    const startDate = Math.floor(Date.parse("2025-01-01T00:00:00Z") / 1000);
    const endDate = Math.floor(Date.parse("2026-08-10T00:00:00Z") / 1000);
    const points = buildUsageTrendChartData(
      [
        {
          date: "2025-01-01T12:00:00.000Z",
          totalInputTokens: 1,
          totalOutputTokens: 1,
          totalCacheCreationTokens: 0,
          totalCacheReadTokens: 0,
          totalCost: "0",
        },
        {
          date: "2025-04-27T12:00:00.000Z",
          totalInputTokens: 1,
          totalOutputTokens: 1,
          totalCacheCreationTokens: 0,
          totalCacheReadTokens: 0,
          totalCost: "0",
        },
        {
          date: "2026-04-27T12:00:00.000Z",
          totalInputTokens: 1,
          totalOutputTokens: 1,
          totalCacheCreationTokens: 0,
          totalCacheReadTokens: 0,
          totalCost: "0",
        },
      ],
      { isHourly: false, dateLocale: "en-US", startDate, endDate },
    );

    // Simulate Recharts passing a later category as the only visible tick
    // (filtered index 0 would wrongly map to the first chart row).
    const last = points[2];
    expect(formatUsageTrendTickLabel(last.xKey, points)).toBe(last.label);
    expect(formatUsageTrendTickLabel(last.xKey, points)).not.toBe(
      points[0].label,
    );
  });
});

describe("formatUsageTrendTokenTickLabel", () => {
  it("follows the chosen token unit for large token axis ticks", () => {
    expect(formatUsageTrendTokenTickLabel(600_000_000, "zh", "zh-CN")).toBe(
      "6亿",
    );
    expect(formatUsageTrendTokenTickLabel(1_950_000_000, "zh", "zh-CN")).toBe(
      "19.5亿",
    );
    expect(formatUsageTrendTokenTickLabel(65_000_000, "zh", "zh-TW")).toBe(
      "6500萬",
    );
    expect(formatUsageTrendTokenTickLabel(600_000_000, "intl", "en-US")).toBe(
      "600M",
    );
  });

  it("keeps the international unit even when the UI is Chinese", () => {
    expect(formatUsageTrendTokenTickLabel(600_000_000, "intl", "zh-CN")).toBe(
      "600M",
    );
    expect(formatUsageTrendTokenTickLabel(65_000_000, "intl", "zh-TW")).toBe(
      "65M",
    );
  });

  it("keeps zero and small-thousand token ticks readable", () => {
    expect(formatUsageTrendTokenTickLabel(0, "zh", "zh-CN")).toBe("0");
    expect(formatUsageTrendTokenTickLabel(1500, "intl", "en-US")).toBe("1.5K");
    expect(formatUsageTrendTokenTickLabel(null, "intl", "en-US")).toBe("--");
  });
});

describe("buildUsageTrendTokenRows", () => {
  const point = {
    tooltipLabel: "2026/09/30",
    cacheReadTokens: 768,
    inputTokens: 13104,
    cacheCreationTokens: 0,
    outputTokens: 1703,
  };

  it("lists the four token rows with full integers and stable colors", () => {
    const rows = buildUsageTrendTokenRows(
      {
        ...point,
        cacheCreationTokens: 256,
      },
      true,
    );
    expect(rows.map((row) => row.value)).toEqual([768, 13104, 256, 1703]);
    expect(rows.map((row) => row.color)).toEqual([
      "#93C5FD",
      "#3B82F6",
      "#2563EB",
      "#1E40AF",
    ]);
    expect(rows.map((row) => row.labelKey)).toEqual([
      "usage.trend.tokenHit",
      "usage.trend.tokenMiss",
      "usage.trend.tokenWrite",
      "usage.trend.tokenOutput",
    ]);
  });

  it("hides the cache-write row when the whole series has no cache creation", () => {
    const rows = buildUsageTrendTokenRows(point, false);
    expect(rows.map((row) => row.key)).toEqual([
      "cacheRead",
      "input",
      "output",
    ]);
  });

  it("returns no rows without a point", () => {
    expect(buildUsageTrendTokenRows(undefined, true)).toEqual([]);
  });
});

describe("buildUsageTrendModelRows", () => {
  const models = [
    { model: "claude-sonnet-4", totalTokens: 5000 },
    { model: "gpt-5", totalTokens: 4000 },
    { model: "gemini-2.5-pro", totalTokens: 3000 },
    { model: "deepseek-v3", totalTokens: 2000 },
    { model: "qwen3-max", totalTokens: 1000 },
    { model: "kimi-k2", totalTokens: 500 },
    { model: "glm-4.6", totalTokens: 100 },
  ];

  it("returns every model when under the default limit", () => {
    const rows = buildUsageTrendModelRows(models);
    expect(rows).toHaveLength(7);
    expect(rows?.every((row) => row.model != null)).toBe(true);
  });

  it("keeps the limit and aggregates the rest into an others row", () => {
    const rows = buildUsageTrendModelRows(models, 6);
    expect(rows).toHaveLength(6);
    expect(rows?.slice(0, 5).map((row) => row.model)).toEqual([
      "claude-sonnet-4",
      "gpt-5",
      "gemini-2.5-pro",
      "deepseek-v3",
      "qwen3-max",
    ]);
    const others = rows?.[5];
    expect(others?.model).toBeNull();
    expect(others?.count).toBe(2);
    expect(others?.totalTokens).toBe(600);
  });

  it("returns all rows when under the limit", () => {
    const rows = buildUsageTrendModelRows(models.slice(0, 3));
    expect(rows).toHaveLength(3);
    expect(rows?.every((row) => row.model != null)).toBe(true);
    expect(rows?.map((row) => row.totalTokens)).toEqual([5000, 4000, 3000]);
  });

  it("gives each model a stable color derived from its name", () => {
    const rows = buildUsageTrendModelRows(models.slice(0, 2));
    const again = buildUsageTrendModelRows(models.slice(0, 2));
    expect(rows?.[0].color).toBe(again?.[0].color);
    expect(rows?.[0].color).not.toBe(rows?.[1].color);
  });

  it("returns null without model data", () => {
    expect(buildUsageTrendModelRows(undefined)).toBeNull();
    expect(buildUsageTrendModelRows([])).toBeNull();
  });
});

describe("buildUsageTrendModelSeries", () => {
  const startDate = Math.floor(Date.parse("2026-09-01T00:00:00Z") / 1000);
  const endDate = Math.floor(Date.parse("2026-09-30T00:00:00Z") / 1000);
  const chartData = buildUsageTrendChartData(
    [
      {
        ...day("2026-09-01"),
        models: [
          { model: "alpha", totalTokens: 100 },
          { model: "beta", totalTokens: 50 },
        ],
      },
      {
        ...day("2026-09-02"),
        models: [
          { model: "alpha", totalTokens: 20 },
          { model: "gamma", totalTokens: 30 },
        ],
      },
    ],
    { isHourly: false, dateLocale: "en-US", startDate, endDate },
  );

  it("orders models by total and fills missing days with zero", () => {
    const series = buildUsageTrendModelSeries(chartData);
    expect(series.map((entry) => entry.model)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(series.map((entry) => entry.totalTokens)).toEqual([120, 50, 30]);
    expect(new Set(series.map((entry) => entry.color)).size).toBe(3);

    const rows = attachUsageTrendModelValues(chartData, series);
    expect(rows[0].modelValues).toMatchObject({
      "model-0": 100,
      "model-1": 50,
      "model-2": 0,
    });
    expect(rows[1].modelValues).toMatchObject({
      "model-0": 20,
      "model-1": 0,
      "model-2": 30,
    });
  });

  it("uses a custom limit and aggregates the tail into an others series", () => {
    const many = buildUsageTrendChartData(
      [
        {
          ...day("2026-09-03"),
          models: Array.from({ length: 12 }, (_, index) => ({
            model: `model-${index}`,
            totalTokens: 1000 - index * 10,
          })),
        },
      ],
      { isHourly: false, dateLocale: "en-US", startDate, endDate },
    );
    const series = buildUsageTrendModelSeries(many, 3);
    expect(series).toHaveLength(3);
    expect(series[0].model).toBe("model-0");
    expect(series[1].model).toBe("model-1");
    expect(series[2].model).toBeNull();
    expect(series[2].count).toBe(10);
    expect(series[2].totalTokens).toBe(
      Array.from({ length: 10 }, (_, index) => 980 - index * 10).reduce(
        (sum, value) => sum + value,
        0,
      ),
    );

    const rows = attachUsageTrendModelValues(many, series);
    expect(rows[0].modelValues["model-other"]).toBe(series[2].totalTokens);
  });

  it("returns no series when the backend omits the breakdown", () => {
    const plain = buildUsageTrendChartData([day("2026-09-04")], {
      isHourly: false,
      dateLocale: "en-US",
      startDate,
      endDate,
    });
    expect(buildUsageTrendModelSeries(plain)).toEqual([]);
  });
});

describe("buildUsageTrendChartData models mapping", () => {
  it("maps the per-model breakdown into chart points", () => {
    const startDate = Math.floor(Date.parse("2026-09-01T00:00:00Z") / 1000);
    const endDate = Math.floor(Date.parse("2026-09-30T00:00:00Z") / 1000);
    const points = buildUsageTrendChartData(
      [
        {
          date: "2026-09-30T12:00:00.000Z",
          totalInputTokens: 100,
          totalOutputTokens: 50,
          totalCacheCreationTokens: 0,
          totalCacheReadTokens: 0,
          totalCost: "0.01",
          models: [
            { model: "gpt-5", totalTokens: 100 },
            { model: "claude-sonnet-4", totalTokens: 50 },
          ],
        },
      ],
      { isHourly: false, dateLocale: "en-US", startDate, endDate },
    );

    expect(points[0].models).toEqual([
      { model: "gpt-5", totalTokens: 100 },
      { model: "claude-sonnet-4", totalTokens: 50 },
    ]);
  });

  it("leaves models undefined when the backend omits the breakdown", () => {
    const startDate = Math.floor(Date.parse("2026-09-01T00:00:00Z") / 1000);
    const endDate = Math.floor(Date.parse("2026-09-30T00:00:00Z") / 1000);
    const points = buildUsageTrendChartData([day("2026-09-15")], {
      isHourly: false,
      dateLocale: "en-US",
      startDate,
      endDate,
    });

    expect(points[0].models).toBeUndefined();
  });
});

describe("buildUsageTrendChartData granularity labels", () => {
  // 用本地时间构造，避免测试机时区影响「时:分」
  const at = (hour: number, minute: number) => ({
    date: new Date(2026, 8, 30, hour, minute).toISOString(),
    totalInputTokens: 1,
    totalOutputTokens: 1,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    totalCost: "0",
  });
  const startDate = Math.floor(new Date(2026, 8, 30).getTime() / 1000);
  const endDate = startDate + 24 * 60 * 60;

  it("shows hour:minute for sub-day buckets (10m / 30m / 1h / 12h)", () => {
    const points = buildUsageTrendChartData([at(10, 10), at(10, 30)], {
      isHourly: true,
      dateLocale: "en-GB",
      startDate,
      endDate,
    });

    expect(points[0].label).toContain("10:10");
    expect(points[1].label).toContain("10:30");
    expect(points[0].tooltipLabel).toContain("10:10");
    expect(points[0].tooltipLabel).toMatch(/2026/);
  });

  it("shows only the date for 1d buckets", () => {
    const points = buildUsageTrendChartData([at(0, 0)], {
      isHourly: false,
      dateLocale: "en-GB",
      startDate,
      endDate,
    });

    expect(points[0].label).toBe("30/09");
    expect(points[0].label).not.toMatch(/:/);
    expect(points[0].tooltipLabel).not.toMatch(/:/);
  });
});
