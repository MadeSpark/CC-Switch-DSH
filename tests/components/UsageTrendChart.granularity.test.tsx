import type { ComponentProps } from "react";
import { renderWithQueryClient as render } from "../utils/testQueryClient";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UsageTrendChart } from "@/components/usage/UsageTrendChart";
import type { UsageGranularity } from "@/types/usage";

const useUsageTrendsMock = vi.hoisted(() => vi.fn());

vi.mock("recharts", async (importOriginal) => {
  const recharts = await importOriginal<typeof import("recharts")>();
  return {
    ...recharts,
    // jsdom 没有布局，给容器固定尺寸让坐标轴刻度真正渲染出来
    ResponsiveContainer: (
      props: ComponentProps<typeof recharts.ResponsiveContainer>,
    ) => <recharts.ResponsiveContainer {...props} width={640} height={132} />,
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { resolvedLanguage: "en", language: "en" },
  }),
}));

vi.mock("@/lib/query/usage", () => ({
  useUsageTrends: (...args: unknown[]) => useUsageTrendsMock(...args),
}));

// 用本地时间构造，便于断言「时:分」
const point = (hour: number, minute: number) => ({
  date: new Date(2026, 8, 30, hour, minute).toISOString(),
  requestCount: 1,
  totalInputTokens: 10,
  totalOutputTokens: 5,
  totalCacheCreationTokens: 0,
  totalCacheReadTokens: 0,
  totalCost: "0.01",
});

const renderChart = (granularity: UsageGranularity) =>
  render(
    <UsageTrendChart
      range={{ preset: "7d" }}
      rangeLabel="7d"
      granularity={granularity}
      refreshIntervalMs={0}
    />,
  );

// recharts 3 把刻度文字渲染到独立的 z-index 图层，不在 .recharts-xAxis 下；
// tooltip 未激活时图里唯一的日期文字就是 X 轴刻度。
const axisTicks = (container: HTMLElement) =>
  [...container.querySelectorAll("svg text")]
    .map((node) => node.textContent ?? "")
    .filter((text) => text.includes("/"));

describe("UsageTrendChart granularity", () => {
  beforeEach(() => {
    useUsageTrendsMock.mockReset().mockReturnValue({
      data: [point(10, 10), point(10, 20)],
      isLoading: false,
    });
  });

  it("passes the granularity to useUsageTrends", () => {
    renderChart("30m");

    expect(useUsageTrendsMock).toHaveBeenLastCalledWith(
      { preset: "7d" },
      expect.anything(),
      expect.objectContaining({ granularity: "30m" }),
    );
  });

  it.each(["10m", "30m", "1h"] as const)(
    "renders hour:minute axis labels for %s",
    (granularity) => {
      const { container } = renderChart(granularity);
      const ticks = axisTicks(container);

      expect(ticks.length).toBeGreaterThan(0);
      expect(ticks.some((text) => text.includes("10:10"))).toBe(true);
    },
  );

  it("renders date-only axis labels for 1d", () => {
    useUsageTrendsMock.mockReturnValue({
      data: [point(0, 0)],
      isLoading: false,
    });
    const { container } = renderChart("1d");
    const ticks = axisTicks(container);

    expect(ticks).toContain("09/30");
    expect(ticks.some((text) => text.includes(":"))).toBe(false);
  });
});
