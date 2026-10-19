import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DshModeBar } from "@/components/providers/DshModeBar";
import type { DshCurrentState, DshRelayStatus } from "@/lib/api/dsh";
import type { Provider } from "@/types";

const { invokeMock, toastSuccess, toastError } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: toastError },
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
const currentState: DshCurrentState = {
  providerIds: ["gateway"],
  currentProviderId: "gateway",
  currentModel: "model-a",
};

function mockState(relay = directStatus, current = currentState) {
  invokeMock.mockImplementation(
    (command: string, args?: { enabled: boolean }) => {
      if (command === "dsh_relay_status") return Promise.resolve(relay);
      if (command === "get_dsh_current_state") return Promise.resolve(current);
      if (command === "dsh_set_relay") {
        return Promise.resolve(args?.enabled ? routeStatus : directStatus);
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    },
  );
}

function renderBar(
  view: "providers" | "dshRelay" = "providers",
  providers?: Provider[],
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onViewChange = vi.fn();
  const element = (nextView: "providers" | "dshRelay") => (
    <QueryClientProvider client={client}>
      <DshModeBar
        providers={providers}
        view={nextView}
        onViewChange={onViewChange}
      />
    </QueryClientProvider>
  );
  const result = render(element(view));
  return {
    ...result,
    onViewChange,
    changeView: (nextView: "providers" | "dshRelay") =>
      result.rerender(element(nextView)),
  };
}

beforeEach(() => {
  invokeMock.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
  mockState();
});

describe("DshModeBar", () => {
  it("renders two segmented buttons with view selection and stable scope markers", () => {
    const { container, changeView } = renderBar();
    expect(
      container.querySelector('[data-scope="dsh-mode"]'),
    ).toBeInTheDocument();
    const group = screen.getByRole("group", { name: "mode.tabsLabel" });
    const direct = within(group).getByRole("button", {
      name: /mode.names.direct/,
    });
    const route = within(group).getByRole("button", {
      name: /mode.names.route/,
    });
    expect(within(group).getAllByRole("button")).toHaveLength(2);
    expect(direct).toHaveAttribute("data-mode", "direct");
    expect(route).toHaveAttribute("data-mode", "route");
    expect(direct).toHaveAttribute("aria-pressed", "true");
    expect(route).toHaveAttribute("aria-pressed", "false");
    changeView("dshRelay");
    expect(direct).toHaveAttribute("aria-pressed", "false");
    expect(route).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.queryByRole("button", { name: "mode.routeSettings" }),
    ).not.toBeInTheDocument();
  });

  it("changes the requested page when a segment is clicked", () => {
    const { onViewChange } = renderBar();
    fireEvent.click(screen.getByRole("button", { name: /mode.names.route/ }));
    expect(onViewChange).toHaveBeenCalledWith("dshRelay");
    fireEvent.click(screen.getByRole("button", { name: /mode.names.direct/ }));
    expect(onViewChange).toHaveBeenLastCalledWith("providers");
  });

  it("marks attached routing active independently of the view and shows status only in that view", async () => {
    mockState(routeStatus);
    const { changeView } = renderBar();
    const route = screen.getByRole("button", { name: /mode.names.route/ });
    await waitFor(() => expect(route).toHaveClass("text-route-text"));
    expect(
      within(route).getByRole("img", { name: "mode.active" }),
    ).toBeInTheDocument();
    expect(route).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByText("mode.status.routeLead")).not.toBeInTheDocument();
    changeView("dshRelay");
    expect(route).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("mode.status.routeLead")).toBeInTheDocument();
    expect(screen.getByText("→ Gateway")).toBeInTheDocument();
  });

  it("shows the direct provider and model using its display name", async () => {
    renderBar("providers", [
      { id: "gateway", name: "Company Gateway", settingsConfig: {} },
    ]);
    expect(
      await screen.findByText("Company Gateway · model-a"),
    ).toBeInTheDocument();
    expect(screen.getByText("mode.status.directLead")).toBeInTheDocument();
  });

  it("falls back to the provider id and omits a value when there is no current provider", async () => {
    const { unmount } = renderBar();
    expect(await screen.findByText("gateway · model-a")).toBeInTheDocument();
    unmount();
    mockState(directStatus, { ...currentState, currentProviderId: null });
    renderBar();
    await waitFor(() => expect(screen.getByRole("switch")).toBeEnabled());
    expect(screen.getByText("mode.status.directLead")).toBeInTheDocument();
    expect(screen.queryByText(/model-a/)).not.toBeInTheDocument();
  });

  it("uses the count label for multiple relayed providers and ids for unnamed providers", async () => {
    mockState({
      ...routeStatus,
      providers: [
        ...routeStatus.providers,
        { ...routeStatus.providers[0], providerId: "other", name: "Other" },
      ],
    });
    const { unmount } = renderBar("dshRelay");
    expect(
      await screen.findByText("→ dshRelay.modeStatus.routeValue"),
    ).toBeInTheDocument();
    unmount();
    mockState({
      ...routeStatus,
      providers: [{ ...routeStatus.providers[0], name: "" }],
    });
    renderBar("dshRelay");
    expect(await screen.findByText("→ gateway")).toBeInTheDocument();
  });

  it("enables routing through the shortcut switch and reports success", async () => {
    renderBar();
    const toggle = screen.getByRole("switch", { name: "dshRelay.relayLabel" });
    await waitFor(() => expect(toggle).toBeEnabled());
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("dsh_set_relay", {
        enabled: true,
      }),
    );
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("dshRelay.relayEnabled"),
    );
    expect(toggle).toBeChecked();
  });

  it("reports failed mutations and retains the previous switch value", async () => {
    const logError = vi.spyOn(console, "error").mockImplementation(() => {});
    invokeMock.mockImplementation((command: string) => {
      if (command === "dsh_relay_status") return Promise.resolve(directStatus);
      if (command === "get_dsh_current_state")
        return Promise.resolve(currentState);
      return Promise.reject(new Error("relay blocked"));
    });
    try {
      renderBar();
      const toggle = screen.getByRole("switch");
      await waitFor(() => expect(toggle).toBeEnabled());
      fireEvent.click(toggle);
      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith("dshRelay.relayFailed"),
      );
      expect(toastSuccess).not.toHaveBeenCalled();
      expect(toggle).not.toBeChecked();
    } finally {
      logError.mockRestore();
    }
  });

  it("disables the shortcut when relay status cannot be read", async () => {
    invokeMock.mockImplementation((command: string) =>
      command === "get_dsh_current_state"
        ? Promise.resolve(currentState)
        : Promise.reject(new Error("unavailable")),
    );
    renderBar();
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("dsh_relay_status"),
    );
    expect(screen.getByRole("switch")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /mode.names.direct/ }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(toastError).not.toHaveBeenCalled();
  });
});
