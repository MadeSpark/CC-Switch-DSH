import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageDashboard } from "@/components/usage/UsageDashboard";
import type { AppTypeFilter } from "@/types/usage";

/**
 * 「按应用筛选」分段控件里的自定义应用按钮：
 * 按钮、选中态、点击后 usage 查询带上的 appType=custom-{uuid}、应用被删后的回落。
 */

const usageApiMock = vi.hoisted(() => ({
  getUsageSummary: vi.fn(),
  getUsageSummaryByApp: vi.fn(),
  getUsageTrends: vi.fn(),
  getProviderStats: vi.fn(),
  getModelStats: vi.fn(),
  getRequestLogs: vi.fn(),
  getRequestDetail: vi.fn(),
  getModelPricing: vi.fn(),
  getModelsDevSyncConfig: vi.fn(),
  saveModelsDevSyncConfig: vi.fn(),
  syncSessionUsage: vi.fn(),
  getSessionUsageLastSync: vi.fn().mockResolvedValue(null),
  rebuildCodexUsage: vi.fn(),
}));

const useCustomAppsQueryMock = vi.hoisted(() => vi.fn());

const i18nMock = vi.hoisted(() => ({
  // t 要稳定：真实的 i18next 也只在切语言时换 t，组件里有依赖 t 的 effect
  t: (key: string) => key,
  i18n: { resolvedLanguage: "zh", language: "zh" },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => i18nMock,
}));

vi.mock("@/lib/api/usage", () => ({ usageApi: usageApiMock }));

vi.mock("@/lib/query/customApps", () => ({
  useCustomAppsQuery: () => useCustomAppsQueryMock(),
}));

vi.mock("@/lib/api/proxy", () => ({
  proxyApi: {
    getPricingModelSource: vi.fn().mockResolvedValue("response"),
    setPricingModelSource: vi.fn().mockResolvedValue(undefined),
  },
}));

const summary = {
  totalRequests: 12,
  totalCost: "1.2",
  totalInputTokens: 10_000,
  totalOutputTokens: 4_000,
  totalCacheCreationTokens: 0,
  totalCacheReadTokens: 0,
  successRate: 100,
  realTotalTokens: 14_000,
  cacheHitRate: 0,
};

const customApp = {
  id: "custom-8fa21cfe-eb70-4103-bd89-d9ee1cf36254",
  name: "爱丽",
  icon: "claude",
  iconColor: null,
  apiKey: "sk-test",
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_000,
};

const emptyLogsPage = { data: [], total: 0, page: 0, pageSize: 20 };

function renderDashboard(
  props?: Parameters<typeof UsageDashboard>[0],
): ReturnType<typeof render> & { rerender: () => void } {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // rerender 复用同一棵树（同一个 QueryClient），让 mocked 的 useCustomAppsQuery
  // 在下一次渲染时返回新值（比如自定义应用被删后的空列表）
  const tree = () => (
    <QueryClientProvider client={client}>
      <UsageDashboard {...props} />
    </QueryClientProvider>
  );
  const view = render(tree());
  return { ...view, rerender: () => view.rerender(tree()) };
}

describe("UsageDashboard 自定义应用筛选", () => {
  beforeEach(() => {
    usageApiMock.getUsageSummary.mockResolvedValue(summary);
    usageApiMock.getUsageSummaryByApp.mockResolvedValue([
      { appType: "claude", summary },
    ]);
    usageApiMock.getUsageTrends.mockResolvedValue([]);
    usageApiMock.getProviderStats.mockResolvedValue([]);
    usageApiMock.getModelStats.mockResolvedValue([]);
    usageApiMock.getRequestLogs.mockResolvedValue(emptyLogsPage);
    usageApiMock.getModelPricing.mockResolvedValue([]);
    usageApiMock.getModelsDevSyncConfig.mockResolvedValue({
      configPath: "/tmp/model-pricing.json",
      config: {
        autoSyncEnabled: false,
        includeCommonModels: true,
        selectedModelKeys: [],
        excludedCommonModelKeys: [],
        lastSyncAt: null,
        lastSyncError: null,
      },
    });
    usageApiMock.syncSessionUsage.mockResolvedValue({
      imported: 0,
      skipped: 0,
      filesScanned: 0,
      suspectedDuplicates: 0,
      deferredFiles: 0,
      errors: [],
    });
    useCustomAppsQueryMock.mockReturnValue({ data: [customApp] });
  });

  afterEach(() => {
    cleanup();
  });

  it("为每个自定义应用渲染一个同名 aria-label 的图标按钮", async () => {
    renderDashboard();
    const button = await screen.findByRole("button", { name: "爱丽" });
    expect(button).toHaveAttribute("aria-pressed", "false");
  });

  it("点击自定义应用按钮后，usage 查询带 appType=custom-{uuid}", async () => {
    const user = userEvent.setup();
    renderDashboard();

    await user.click(await screen.findByRole("button", { name: "爱丽" }));

    await waitFor(() => {
      expect(usageApiMock.getProviderStats).toHaveBeenLastCalledWith(
        expect.any(Number),
        expect.any(Number),
        customApp.id,
        undefined,
        undefined,
      );
    });
    expect(usageApiMock.getModelStats).toHaveBeenLastCalledWith(
      expect.any(Number),
      expect.any(Number),
      customApp.id,
      undefined,
      undefined,
    );
    const logsFilter =
      usageApiMock.getRequestLogs.mock.lastCall?.[0] ?? undefined;
    expect(logsFilter).toMatchObject({ appType: customApp.id });
    expect(screen.getByRole("button", { name: "爱丽" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("选中的自定义应用被删除后回落到「全部」", async () => {
    const user = userEvent.setup();
    const { rerender } = renderDashboard();

    await user.click(await screen.findByRole("button", { name: "爱丽" }));
    await waitFor(() => {
      expect(usageApiMock.getProviderStats).toHaveBeenLastCalledWith(
        expect.any(Number),
        expect.any(Number),
        customApp.id,
        undefined,
        undefined,
      );
    });

    // 模拟应用被删：自定义应用列表变空，再渲染一次让 hook 拿到新数据
    useCustomAppsQueryMock.mockReturnValue({ data: [] });
    rerender();

    await waitFor(() => {
      expect(usageApiMock.getProviderStats).toHaveBeenLastCalledWith(
        expect.any(Number),
        expect.any(Number),
        undefined,
        undefined,
        undefined,
      );
    });
    expect(
      screen.getByRole("button", { name: "usage.appFilter.all" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("initialAppType 指向已删除的自定义应用时同样回落到「全部」", async () => {
    useCustomAppsQueryMock.mockReturnValue({ data: [] });
    renderDashboard({ initialAppType: customApp.id as AppTypeFilter });

    await waitFor(() => {
      expect(usageApiMock.getProviderStats).toHaveBeenLastCalledWith(
        expect.any(Number),
        expect.any(Number),
        undefined,
        undefined,
        undefined,
      );
    });
    expect(
      screen.getByRole("button", { name: "usage.appFilter.all" }),
    ).toHaveAttribute("aria-pressed", "true");
  });
});
