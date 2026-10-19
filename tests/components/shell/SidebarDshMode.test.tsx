import { QueryClientProvider } from "@tanstack/react-query";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "@/components/shell/Sidebar";
import { APP_DISPLAY_NAME } from "@/components/shell/AppGlyph";
import { useSidebarStatus } from "@/hooks/useSidebarStatus";
import type { Settings, VisibleApps } from "@/types";
import { createTestQueryClient } from "../../utils/testQueryClient";

// 侧栏要跟着 DSH 中转状态出「路由」标签：状态由这个开关驱动
const relay = vi.hoisted(() => ({ attached: true, running: true }));
const getAppMode = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { value?: string }) =>
      options?.value != null ? `${key}:${options.value}` : key,
    i18n: { resolvedLanguage: "en" },
  }),
}));

vi.mock("@/lib/query/dsh", () => ({
  useDshRelayStatus: () => ({
    data: {
      relayEnabled: relay.attached,
      restoreOnExit: true,
      attached: relay.attached,
      baseUrl: "http://127.0.0.1:15721/dsh/tx",
      providers: [],
    },
  }),
}));

vi.mock("@/lib/query/proxy", () => ({
  useProxyStatusQuery: () => ({ data: { running: relay.running } }),
}));

vi.mock("@/lib/query/usage", () => ({
  useUsageSummary: () => ({ data: undefined }),
}));

vi.mock("@/lib/api/auth", () => ({
  authGetStatus: vi.fn(async () => ({ accounts: [] })),
}));

vi.mock("@/lib/api/proxy", () => ({
  proxyApi: { getAppMode },
}));

const wrapperWithClient = () => {
  const client = createTestQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
};

const renderSidebar = (activeApp: "claude" | "deepseek-harness") => {
  const client = createTestQueryClient();
  // 只给侧栏用到的字段；不这样盖住设置查询会真的去 mock 后端重取
  client.setQueryDefaults(["settings"], { staleTime: Infinity });
  client.setQueryData(["settings"], {
    visibleApps: { claude: true, "deepseek-harness": true },
  } as unknown as Settings);
  render(
    <QueryClientProvider client={client}>
      <Sidebar
        activeApp={activeApp}
        view="providers"
        visibleApps={{ claude: true, "deepseek-harness": true } as VisibleApps}
        settingsSection="general"
        onSelectApp={vi.fn()}
        onSelectPage={vi.fn()}
        onSelectSettingsSection={vi.fn()}
        onExitSettings={vi.fn()}
      />
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  relay.attached = true;
  relay.running = true;
  getAppMode.mockReset();
  getAppMode.mockImplementation(async (app: string) => ({
    app,
    mode: "direct",
  }));
});

describe("DSH sidebar mode tag", () => {
  it("takes DSH's mode from the relay state, not from the mode queries", async () => {
    getAppMode.mockImplementation(async (app: string) => ({
      app,
      mode: app === "claude" ? "route" : "direct",
    }));
    const wrapperOf = () => {
      const client = createTestQueryClient();
      return {
        client,
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      };
    };

    const relayed = renderHook(() => useSidebarStatus(), {
      wrapper: wrapperOf().wrapper,
    });
    await waitFor(() =>
      expect(relayed.result.current.appStatus("claude").mode).toBe("route"),
    );
    // DSH 不在 MODE_APP_IDS 里，以前一律按直连处理
    expect(relayed.result.current.appStatus("deepseek-harness")).toEqual({
      mode: "route",
      alert: false,
    });

    relay.attached = false;
    const direct = renderHook(() => useSidebarStatus(), {
      wrapper: wrapperOf().wrapper,
    });
    await waitFor(() =>
      expect(direct.result.current.appStatus("deepseek-harness").mode).toBe(
        "direct",
      ),
    );
    // 别的应用照样走各自的模式查询
    await waitFor(() =>
      expect(direct.result.current.appStatus("claude").mode).toBe("route"),
    );
  });

  it("flags DSH when the relay is attached but the proxy is down", async () => {
    relay.running = false;
    const { wrapper } = wrapperWithClient();
    const { result } = renderHook(() => useSidebarStatus(), { wrapper });

    await waitFor(() =>
      expect(result.current.appStatus("deepseek-harness")).toEqual({
        mode: "route",
        alert: true,
      }),
    );
  });

  it("shows the route pill next to DSH while another app is selected", () => {
    renderSidebar("claude");
    expect(screen.getByText("nav.mode.route")).toBeInTheDocument();
  });

  it("shows no pill once the relay is off", () => {
    relay.attached = false;
    renderSidebar("claude");
    expect(screen.queryByText("nav.mode.route")).not.toBeInTheDocument();
  });

  it("still hides the pill on the selected row", () => {
    renderSidebar("deepseek-harness");
    expect(screen.queryByText("nav.mode.route")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: APP_DISPLAY_NAME["deepseek-harness"],
      }),
    ).toHaveAttribute("aria-current", "page");
  });
});
