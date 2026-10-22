import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  UsageDashboard,
  resetUsageSyncClockForTests,
} from "@/components/usage/UsageDashboard";
import type { UsageRangeSelection } from "@/types/usage";

const trendChartMock = vi.hoisted(() => vi.fn());
const usageApiMock = vi.hoisted(() => ({
  getUsageSummary: vi.fn(),
  syncSessionUsage: vi.fn(),
  getSessionUsageLastSync: vi.fn(),
  rebuildCodexUsage: vi.fn(),
}));

const DAY = 24 * 60 * 60;
const CUSTOM_START = 1_700_000_000;

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: unknown) => {
      if (typeof options === "string") return options;
      if (options && typeof options === "object") {
        const values = Object.entries(options as Record<string, unknown>)
          .filter(([name]) => name !== "defaultValue")
          .map(([, value]) => String(value));
        return values.length ? `${key}:${values.join(",")}` : key;
      }
      return key;
    },
    i18n: { resolvedLanguage: "en", language: "en" },
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

vi.mock("@/hooks/useUsageEventBridge", () => ({
  useUsageEventBridge: () => {},
}));

vi.mock("@/lib/api/usage", () => ({ usageApi: usageApiMock }));

vi.mock("@/lib/query/usage", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/query/usage")>(
      "@/lib/query/usage",
    );
  return {
    ...actual,
    useProviderStats: () => ({ data: [] }),
    useModelStats: () => ({ data: [] }),
    useUsageSummaryByApp: () => ({ data: [] }),
  };
});

vi.mock("@/components/usage/UsageHero", () => ({
  UsageHero: () => <div data-testid="usage-hero" />,
}));

vi.mock("@/components/usage/UsageTrendChart", () => ({
  UsageTrendChart: (props: unknown) => {
    trendChartMock(props);
    return <div data-testid="usage-trend" />;
  },
}));

vi.mock("@/components/usage/UsageHeatmap", () => ({
  UsageHeatmap: () => <div data-testid="usage-heatmap" />,
}));

vi.mock("@/components/usage/RequestLogTable", () => ({
  RequestLogTable: () => <div data-testid="request-log-table" />,
}));

vi.mock("@/components/usage/RequestDetailPanel", () => ({
  RequestDetailPanel: () => null,
}));

vi.mock("@/components/usage/ProviderStatsTable", () => ({
  ProviderStatsTable: () => <div data-testid="provider-stats-table" />,
}));

vi.mock("@/components/usage/ModelStatsTable", () => ({
  ModelStatsTable: () => <div data-testid="model-stats-table" />,
}));

vi.mock("@/components/usage/PricingConfigPanel", () => ({
  PricingConfigPanel: () => <div data-testid="pricing-config-panel" />,
}));

vi.mock("@/components/usage/UsageDateRangePicker", () => ({
  UsageDateRangePicker: ({
    triggerLabel,
    onApply,
  }: {
    triggerLabel: string;
    onApply: (selection: UsageRangeSelection) => void;
  }) => (
    <>
      <button type="button" data-testid="range-trigger">
        {triggerLabel}
      </button>
      {(["today", "1d", "7d", "14d", "30d", "all"] as const).map((preset) => (
        <button key={preset} type="button" onClick={() => onApply({ preset })}>
          {`pick-${preset}`}
        </button>
      ))}
      <button
        type="button"
        onClick={() =>
          onApply({
            preset: "custom",
            customStartDate: CUSTOM_START,
            customEndDate: CUSTOM_START + 3 * DAY,
          })
        }
      >
        pick-custom-short
      </button>
      <button
        type="button"
        onClick={() =>
          onApply({
            preset: "custom",
            customStartDate: CUSTOM_START,
            customEndDate: CUSTOM_START + 10 * DAY,
          })
        }
      >
        pick-custom-long
      </button>
    </>
  ),
}));

vi.mock("@/lib/query/proxy", () => ({
  useGlobalProxyConfig: () => ({
    data: { enableLogging: true },
    isLoading: false,
  }),
}));

const renderDashboard = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <UsageDashboard />
    </QueryClientProvider>,
  );
};

const granularityButton = () =>
  screen.getByRole("button", { name: "usage.granularity.label" });

const lastChartGranularity = () =>
  (trendChartMock.mock.calls.at(-1)?.[0] as { granularity?: string })
    ?.granularity;

const pickGranularity = async (
  user: ReturnType<typeof userEvent.setup>,
  option: string,
) => {
  await user.click(granularityButton());
  await user.click(
    await screen.findByRole("menuitem", {
      name: `usage.granularity.${option}`,
    }),
  );
};

describe("UsageDashboard granularity", () => {
  beforeEach(() => {
    localStorage.clear();
    resetUsageSyncClockForTests();
    trendChartMock.mockReset();
    // 非空库：空库会换成空状态页，不渲染趋势图
    usageApiMock.getUsageSummary.mockResolvedValue({ totalRequests: 5 });
    usageApiMock.getSessionUsageLastSync.mockReset().mockResolvedValue(null);
    usageApiMock.syncSessionUsage.mockResolvedValue({
      imported: 0,
      skipped: 0,
      filesScanned: 0,
      suspectedDuplicates: 0,
      deferredFiles: 0,
      errors: [],
    });
  });

  it("renders the control right after the date range picker, defaulting today to 30m", async () => {
    renderDashboard();
    await screen.findByTestId("usage-trend");

    const button = granularityButton();
    expect(button).toHaveTextContent("usage.granularity.30m");
    expect(button).toHaveAttribute("title", "usage.granularity.title");
    const rangeTrigger = screen.getByTestId("range-trigger");
    expect(
      rangeTrigger.compareDocumentPosition(button) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(lastChartGranularity()).toBe("30m");
  });

  it.each([
    ["1d", "1h"],
    ["7d", "1h"],
    ["14d", "1d"],
    ["30d", "1d"],
    ["custom-short", "1h"],
    ["custom-long", "1d"],
  ])("resets to the default for %s (%s)", async (pick, expected) => {
    const user = userEvent.setup();
    renderDashboard();
    await screen.findByTestId("usage-trend");

    await user.click(screen.getByRole("button", { name: `pick-${pick}` }));

    expect(granularityButton()).toHaveTextContent(
      `usage.granularity.${expected}`,
    );
    expect(lastChartGranularity()).toBe(expected);
  });

  it("lists all four options and keeps a manual pick until the range changes", async () => {
    const user = userEvent.setup();
    renderDashboard();
    await screen.findByTestId("usage-trend");

    await user.click(granularityButton());
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "usage.granularity.10m",
      "usage.granularity.30m",
      "usage.granularity.1h",
      "usage.granularity.1d",
    ]);
    await user.click(items[0]);

    expect(granularityButton()).toHaveTextContent("usage.granularity.10m");
    expect(lastChartGranularity()).toBe("10m");

    // 改其他筛选不影响手动粒度
    await user.click(screen.getByRole("button", { name: "Pi" }));
    expect(granularityButton()).toHaveTextContent("usage.granularity.10m");
    expect(lastChartGranularity()).toBe("10m");

    // 切换时间范围才重置
    await user.click(screen.getByRole("button", { name: "pick-7d" }));
    expect(granularityButton()).toHaveTextContent("usage.granularity.1h");
    expect(lastChartGranularity()).toBe("1h");

    await pickGranularity(user, "1d");
    expect(lastChartGranularity()).toBe("1d");
    await user.click(screen.getByRole("button", { name: "pick-today" }));
    expect(lastChartGranularity()).toBe("30m");
  });

  it("hides the control on the all-time range and restores it afterwards", async () => {
    const user = userEvent.setup();
    renderDashboard();

    expect(await screen.findByTestId("usage-trend")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "pick-all" }));
    expect(
      screen.queryByRole("button", { name: "usage.granularity.label" }),
    ).not.toBeInTheDocument();
    expect(await screen.findByTestId("usage-heatmap")).toBeInTheDocument();
    expect(screen.queryByTestId("usage-trend")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "pick-14d" }));
    expect(granularityButton()).toHaveTextContent("usage.granularity.1d");
  });
});
