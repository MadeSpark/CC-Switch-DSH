import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageGranularity, UsageRangeSelection } from "@/types/usage";

const core = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => core);

import { usageApi } from "@/lib/api/usage";
import { usageKeys, useUsageTrends } from "@/lib/query/usage";
import {
  USAGE_GRANULARITIES,
  USAGE_GRANULARITY_SECONDS,
  getDefaultUsageGranularity,
  getUsageGranularitySeconds,
  isSubDayUsageGranularity,
} from "@/lib/usageRange";

const DAY = 24 * 60 * 60;

describe("usage granularity mapping", () => {
  it("lists the four options from fine to coarse with their bucket seconds", () => {
    expect(USAGE_GRANULARITIES).toEqual(["10m", "30m", "1h", "1d"]);
    expect(USAGE_GRANULARITY_SECONDS).toEqual({
      "10m": 600,
      "30m": 1800,
      "1h": 3600,
      "1d": 86400,
    });
    expect(USAGE_GRANULARITIES.map(getUsageGranularitySeconds)).toEqual([
      600, 1800, 3600, 86400,
    ]);
    expect(USAGE_GRANULARITIES.map(isSubDayUsageGranularity)).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it.each([
    ["today", "30m"],
    ["1d", "1h"],
    ["7d", "1h"],
    ["14d", "1d"],
    ["30d", "1d"],
  ] as const)("defaults %s to %s", (preset, expected) => {
    expect(getDefaultUsageGranularity({ preset })).toBe(expected);
  });

  it("uses 1d for custom spans longer than 7 days and 1h otherwise", () => {
    const start = 1_700_000_000;
    const custom = (span: number): UsageRangeSelection => ({
      preset: "custom",
      customStartDate: start,
      customEndDate: start + span,
    });
    const now = (start + 30 * DAY) * 1000;

    expect(getDefaultUsageGranularity(custom(DAY), now)).toBe("1h");
    expect(getDefaultUsageGranularity(custom(7 * DAY), now)).toBe("1h");
    expect(getDefaultUsageGranularity(custom(7 * DAY + 1), now)).toBe("1d");
    expect(getDefaultUsageGranularity(custom(20 * DAY), now)).toBe("1d");
  });
});

describe("usageApi.getUsageTrends", () => {
  beforeEach(() => {
    core.invoke.mockReset().mockResolvedValue([]);
  });

  it("sends bucketSeconds to get_usage_trends", async () => {
    await usageApi.getUsageTrends(100, 200, "claude", "DeepSeek", "m1", 600);

    expect(core.invoke).toHaveBeenCalledWith("get_usage_trends", {
      startDate: 100,
      endDate: 200,
      appType: "claude",
      providerName: "DeepSeek",
      model: "m1",
      bucketSeconds: 600,
    });
  });

  it("leaves bucketSeconds undefined for legacy callers", async () => {
    await usageApi.getUsageTrends(100, 200);

    expect(core.invoke).toHaveBeenCalledWith(
      "get_usage_trends",
      expect.objectContaining({ bucketSeconds: undefined }),
    );
  });
});

describe("useUsageTrends granularity", () => {
  beforeEach(() => {
    core.invoke.mockReset().mockResolvedValue([]);
  });

  const createWrapper = () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    return Wrapper;
  };

  const trendCalls = () =>
    core.invoke.mock.calls.filter(
      ([command]) => command === "get_usage_trends",
    );

  it("includes the granularity in the query key", () => {
    const key = (granularity?: UsageGranularity) =>
      usageKeys.trends("7d", undefined, undefined, {}, undefined, granularity);

    expect(key("1h")).toContain("1h");
    expect(key("10m")).toContain("10m");
    expect(key("1h")).not.toEqual(key("10m"));
    expect(key()).not.toEqual(key("1h"));
  });

  it("refetches with the new bucketSeconds when the granularity changes", async () => {
    const range: UsageRangeSelection = { preset: "7d" };
    const { rerender } = renderHook(
      ({ granularity }: { granularity: UsageGranularity }) =>
        useUsageTrends(range, undefined, { granularity }),
      { wrapper: createWrapper(), initialProps: { granularity: "1h" } },
    );

    await waitFor(() => expect(trendCalls()).toHaveLength(1));
    expect(trendCalls()[0][1]).toMatchObject({ bucketSeconds: 3600 });

    rerender({ granularity: "10m" });
    await waitFor(() => expect(trendCalls()).toHaveLength(2));
    expect(trendCalls()[1][1]).toMatchObject({ bucketSeconds: 600 });

    rerender({ granularity: "1d" });
    await waitFor(() => expect(trendCalls()).toHaveLength(3));
    expect(trendCalls()[2][1]).toMatchObject({ bucketSeconds: 86400 });
  });

  it("omits bucketSeconds when no granularity is given (heatmap)", async () => {
    renderHook(() => useUsageTrends({ preset: "30d" }), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(trendCalls()).toHaveLength(1));
    expect(trendCalls()[0][1]).toMatchObject({ bucketSeconds: undefined });
  });
});

describe("usage.granularity locale keys", () => {
  const locales = ["zh", "zh-TW", "en", "ja", "tr"] as const;
  const expected = ["10m", "1d", "1h", "30m", "label", "title"];

  it.each(locales)("%s parses and has every granularity key", (locale) => {
    const file = path.resolve(
      __dirname,
      `../../src/i18n/locales/${locale}.json`,
    );
    const json = JSON.parse(readFileSync(file, "utf8"));
    const granularity = json.usage?.granularity as Record<string, unknown>;

    expect(Object.keys(granularity).sort()).toEqual(expected);
    for (const key of expected) {
      expect(typeof granularity[key]).toBe("string");
      expect((granularity[key] as string).trim()).not.toBe("");
    }
  });
});
