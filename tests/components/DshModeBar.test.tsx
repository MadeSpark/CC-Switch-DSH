import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DshModeBar } from "@/components/providers/DshModeBar";
import { DshRelayNotice } from "@/components/providers/DshRelayNotice";
import type { DshRelayStatus } from "@/lib/api/dsh";

const mocks = vi.hoisted(() => ({
  relay: undefined as DshRelayStatus | undefined,
  pending: false,
  mutateAsync: vi.fn(),
  restoreAsync: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/query/dsh", () => ({
  relayedCount: (status: DshRelayStatus) =>
    status.providers.filter((provider) => provider.relayed).length,
  useDshRelayStatus: () => ({
    data: mocks.relay,
    refetch: vi.fn(),
    isLoading: false,
    isFetching: false,
  }),
  useDshCurrentState: () => ({
    data: { currentProviderId: "gateway", currentModel: "model-a" },
  }),
  useSetDshRelay: () => ({
    mutateAsync: mocks.mutateAsync,
    isPending: mocks.pending,
  }),
  useSetDshRestoreOnExit: () => ({
    mutateAsync: mocks.restoreAsync,
    isPending: false,
  }),
}));
vi.mock("sonner", () => ({
  toast: {
    success: mocks.success,
    warning: mocks.warning,
    error: mocks.error,
  },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      (
        ({
          "mode.routeSettings": "路由設定",
          "dshRelay.settingsTitle": "路由設定",
          "dshRelay.restoreLabel": "退出 CC Switch 時自動還原直連位址",
        }) as Record<string, string>
      )[key] ?? key,
  }),
}));

const directStatus: DshRelayStatus = {
  relayEnabled: false,
  restoreOnExit: true,
  attached: false,
  baseUrl: null,
  providers: [],
};
const routeStatus: DshRelayStatus = {
  ...directStatus,
  relayEnabled: true,
  attached: true,
  baseUrl: "http://127.0.0.1:15721",
  providers: [
    {
      providerId: "gateway",
      name: "Gateway",
      originalBaseUrl: "https://api.example.com/v1",
      relayBaseUrl: "http://127.0.0.1:15721/dsh/gateway",
      relayed: true,
    },
  ],
};

beforeEach(() => {
  mocks.relay = directStatus;
  mocks.pending = false;
  mocks.mutateAsync.mockReset().mockResolvedValue(routeStatus);
  mocks.restoreAsync.mockReset().mockResolvedValue(routeStatus);
  mocks.success.mockReset();
  mocks.warning.mockReset();
  mocks.error.mockReset();
});

function renderBar(view: "providers" | "dshRelay" = "providers") {
  const onViewChange = vi.fn();
  const element = (next: "providers" | "dshRelay") => (
    <DshModeBar view={next} onViewChange={onViewChange} />
  );
  const result = render(element(view));
  return {
    ...result,
    onViewChange,
    changeView: (next: "providers" | "dshRelay") =>
      result.rerender(element(next)),
  };
}

describe("DshModeBar", () => {
  it("switches the viewed pill without changing the connection mode", () => {
    const { onViewChange, changeView } = renderBar();
    const group = screen.getByRole("group", { name: "mode.tabsLabel" });
    const direct = within(group).getByRole("button", {
      name: /mode.names.direct/,
    });
    const route = within(group).getByRole("button", {
      name: /mode.names.route/,
    });
    expect(within(group).getAllByRole("button")).toHaveLength(2);
    expect(direct).toHaveAttribute("aria-pressed", "true");
    expect(route).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(route);
    expect(onViewChange).toHaveBeenCalledWith("dshRelay");
    changeView("dshRelay");
    expect(route).toHaveAttribute("aria-pressed", "true");
    expect(direct).toHaveAttribute("aria-pressed", "false");
    expect(mocks.mutateAsync).not.toHaveBeenCalled();
  });

  it("has stable mode markers and no switch in the mode row", () => {
    const { container } = renderBar();
    const row = container.querySelector('[data-scope="dsh-mode"]');
    expect(row).toBeInTheDocument();
    expect(row?.querySelector('[data-mode="direct"]')).toBeInTheDocument();
    expect(row?.querySelector('[data-mode="route"]')).toBeInTheDocument();
    expect(
      container.querySelector('[data-scope="dsh-mode"] [role="switch"]'),
    ).toBeNull();
  });

  it("shows active-route status only while viewing route", () => {
    mocks.relay = routeStatus;
    const { changeView } = renderBar("dshRelay");
    expect(screen.getByText("mode.status.routeLead")).toBeInTheDocument();
    expect(screen.getByText("→ Gateway")).toBeInTheDocument();
    changeView("providers");
    expect(screen.queryByText("mode.status.routeLead")).not.toBeInTheDocument();
    const route = screen.getByRole("button", { name: /mode.names.route/ });
    expect(route).toHaveClass("text-route-text");
    expect(route).toHaveAttribute("aria-pressed", "false");
  });

  it("does not offer routing settings in detached direct view", () => {
    renderBar();
    expect(
      screen.queryByRole("button", { name: "路由設定" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens routing settings and its only restore switch when route is active", () => {
    mocks.relay = routeStatus;
    const { container } = renderBar("dshRelay");
    fireEvent.click(screen.getByRole("button", { name: "路由設定" }));
    const sheet = screen.getByRole("dialog", { name: "路由設定" });
    expect(
      within(sheet).getByRole("heading", { name: "路由設定" }),
    ).toBeInTheDocument();
    expect(
      within(sheet).getByRole("switch", {
        name: "退出 CC Switch 時自動還原直連位址",
      }),
    ).toBeInTheDocument();
    expect(within(sheet).getAllByRole("switch")).toHaveLength(1);
    expect(
      container.querySelector('[data-scope="dsh-mode"] [role="switch"]'),
    ).toBeNull();
    expect(mocks.mutateAsync).not.toHaveBeenCalled();
  });

  it("offers DSH-specific question-mark help", () => {
    renderBar();
    fireEvent.click(
      screen.getByRole("button", { name: "dshRelay.help.title" }),
    );
    const help = screen.getByRole("tooltip");
    expect(within(help).getByText("dshRelay.help.direct")).toBeInTheDocument();
    expect(within(help).getByText("dshRelay.help.route")).toBeInTheDocument();
  });
});

describe("DshRelayNotice", () => {
  it("enables route from its notice without changing it from a pill", async () => {
    render(<DshRelayNotice view="route" />);
    expect(screen.getByText("dshRelay.relayDescription")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "mode.activate.route" }),
    );
    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledWith(true));
    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith("dshRelay.relayEnabled"),
    );
  });

  it("restores direct mode from its notice", async () => {
    mocks.relay = routeStatus;
    mocks.mutateAsync.mockResolvedValue(directStatus);
    render(<DshRelayNotice view="direct" />);
    expect(screen.getByText("dshRelay.directNoticeHint")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "mode.activate.direct" }),
    );
    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledWith(false));
    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith("dshRelay.relayDisabled"),
    );
  });

  it("does not offer activation for the active view or an unreadable status", () => {
    const { container, rerender } = render(<DshRelayNotice view="direct" />);
    expect(container).toBeEmptyDOMElement();
    mocks.relay = undefined;
    rerender(<DshRelayNotice view="route" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("disables activation while a mutation is pending", () => {
    mocks.pending = true;
    render(<DshRelayNotice view="route" />);
    expect(
      screen.getByRole("button", { name: "mode.activate.route" }),
    ).toBeDisabled();
  });

  it("reports activation errors without a success toast", async () => {
    mocks.mutateAsync.mockRejectedValue(new Error("relay blocked"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(<DshRelayNotice view="route" />);
      fireEvent.click(
        screen.getByRole("button", { name: "mode.activate.route" }),
      );
      await waitFor(() =>
        expect(mocks.error).toHaveBeenCalledWith("dshRelay.relayFailed"),
      );
      expect(mocks.success).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});
