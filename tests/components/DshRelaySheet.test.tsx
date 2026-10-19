import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DshRelaySheet } from "@/components/providers/DshRelaySheet";
import type { DshRelayStatus } from "@/lib/api/dsh";

const mocks = vi.hoisted(() => ({
  status: undefined as DshRelayStatus | undefined,
  isLoading: false,
  isFetching: false,
  pending: false,
  refetch: vi.fn(),
  mutateAsync: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/lib/query/dsh", () => ({
  useDshRelayStatus: () => ({
    data: mocks.status,
    isLoading: mocks.isLoading,
    isFetching: mocks.isFetching,
    refetch: mocks.refetch,
  }),
  useSetDshRestoreOnExit: () => ({
    mutateAsync: mocks.mutateAsync,
    isPending: mocks.pending,
  }),
}));
vi.mock("sonner", () => ({
  toast: { success: mocks.success, error: mocks.error },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      (
        ({
          "dshRelay.settingsTitle": "路由設定",
          "dshRelay.restoreLabel": "退出 CC Switch 時自動還原直連位址",
          "dshRelay.statusUnavailable": "状态不可用",
        }) as Record<string, string>
      )[key] ?? key,
  }),
}));

const routeStatus: DshRelayStatus = {
  relayEnabled: true,
  restoreOnExit: true,
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
  mocks.status = routeStatus;
  mocks.isLoading = false;
  mocks.isFetching = false;
  mocks.pending = false;
  mocks.refetch.mockReset();
  mocks.mutateAsync.mockReset().mockResolvedValue(routeStatus);
  mocks.success.mockReset();
  mocks.error.mockReset();
});

function renderSheet() {
  return render(<DshRelaySheet open onOpenChange={vi.fn()} />);
}

describe("DshRelaySheet", () => {
  it("renders a titled settings sheet with its description and only the restore switch", () => {
    renderSheet();
    const sheet = screen.getByRole("dialog", { name: "路由設定" });
    expect(
      within(sheet).getByRole("heading", { name: "路由設定" }),
    ).toBeInTheDocument();
    expect(
      within(sheet).getByText("dshRelay.relayDescription"),
    ).toBeInTheDocument();
    const switches = within(sheet).getAllByRole("switch");
    expect(switches).toHaveLength(1);
    expect(switches[0]).toHaveAccessibleName(
      "退出 CC Switch 時自動還原直連位址",
    );
    expect(switches[0]).not.toHaveAccessibleName(
      "使用 CC Switch 中轉 DSH 請求",
    );
    expect(within(sheet).getByText("dshRelay.restoreHint")).toBeInTheDocument();
  });

  it("updates restore-on-exit and reports its successful state", async () => {
    renderSheet();
    fireEvent.click(
      screen.getByRole("switch", { name: "退出 CC Switch 時自動還原直連位址" }),
    );
    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledWith(false));
    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith("dshRelay.restoreDisabled"),
    );
  });

  it("shows attached address and provider mappings", () => {
    renderSheet();
    expect(screen.getByText("dshRelay.attached")).toBeInTheDocument();
    expect(screen.getByText("http://127.0.0.1:15721")).toBeInTheDocument();
    expect(screen.getByText("dshRelay.providersTitle")).toBeInTheDocument();
    const row = screen.getByRole("listitem");
    expect(row).toHaveTextContent("Gateway");
    expect(row).toHaveTextContent("https://api.example.com/v1");
    expect(row).toHaveTextContent("http://127.0.0.1:15721/dsh/gateway");
    expect(within(row).getByText("dshRelay.relayed")).toBeInTheDocument();
    expect(screen.getByText("dshRelay.relayHelp")).toBeInTheDocument();
  });

  it("shows detached status without a local relay address", () => {
    mocks.status = {
      ...routeStatus,
      attached: false,
      relayEnabled: false,
      baseUrl: null,
      providers: [],
    };
    renderSheet();
    expect(screen.getByText("dshRelay.notAttached")).toBeInTheDocument();
    expect(screen.getByText("dshRelay.baseUrlNotRelayed")).toBeInTheDocument();
    expect(screen.queryByText(/127\.0\.0\.1/)).not.toBeInTheDocument();
  });

  it("keeps direct provider addresses visible without a missing-target arrow", () => {
    mocks.status = {
      ...routeStatus,
      attached: false,
      relayEnabled: false,
      baseUrl: null,
      providers: [
        { ...routeStatus.providers[0], relayBaseUrl: null, relayed: false },
      ],
    };
    renderSheet();
    const row = screen.getByRole("listitem");
    expect(row).toHaveTextContent("Gateway");
    expect(row).toHaveTextContent("https://api.example.com/v1");
    expect(row).not.toHaveTextContent("→");
    expect(within(row).getByText("dshRelay.direct")).toBeInTheDocument();
  });

  it("warns when attached without providers", () => {
    mocks.status = { ...routeStatus, providers: [] };
    renderSheet();
    expect(
      screen.getByText("dshRelay.noProvidersAttached"),
    ).toBeInTheDocument();
    expect(screen.queryByText("dshRelay.noProviders")).not.toBeInTheDocument();
  });

  it("shows unavailable status and disables restore when status cannot be read", () => {
    mocks.status = undefined;
    renderSheet();
    expect(screen.getByText("状态不可用")).toBeInTheDocument();
    expect(
      screen.getByText("dshRelay.statusUnavailableHint"),
    ).toBeInTheDocument();
    expect(screen.getByRole("switch")).toBeDisabled();
  });

  it("refreshes status on request and locks refresh while fetching", () => {
    const result = renderSheet();
    fireEvent.click(screen.getByRole("button", { name: "dshRelay.refresh" }));
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
    mocks.isFetching = true;
    result.rerender(<DshRelaySheet open onOpenChange={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: "dshRelay.refresh" }),
    ).toBeDisabled();
  });

  it("reports restore errors and preserves the existing setting", async () => {
    mocks.mutateAsync.mockRejectedValue(new Error("blocked"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      renderSheet();
      fireEvent.click(screen.getByRole("switch"));
      await waitFor(() =>
        expect(mocks.error).toHaveBeenCalledWith("dshRelay.restoreFailed"),
      );
      expect(mocks.success).not.toHaveBeenCalled();
      expect(screen.getByRole("switch")).toBeChecked();
    } finally {
      error.mockRestore();
    }
  });
});
