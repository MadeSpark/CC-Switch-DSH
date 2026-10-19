import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DshRelayNotice } from "@/components/providers/DshRelayNotice";
import type { DshRelayStatus } from "@/lib/api/dsh";

const mocks = vi.hoisted(() => ({
  status: undefined as DshRelayStatus | undefined,
  pending: false,
  mutateAsync: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/query/dsh", () => ({
  relayedCount: (status: DshRelayStatus) =>
    status.providers.filter((provider) => provider.relayed).length,
  useDshRelayStatus: () => ({ data: mocks.status }),
  useSetDshRelay: () => ({
    mutateAsync: mocks.mutateAsync,
    isPending: mocks.pending,
  }),
}));
vi.mock("@/lib/toast", () => ({
  toast: {
    success: mocks.success,
    warning: mocks.warning,
    error: mocks.error,
  },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

const relayed = (id: string): DshRelayStatus["providers"][number] => ({
  providerId: id,
  name: id,
  originalBaseUrl: "https://api.example.com/v1",
  relayBaseUrl: "http://127.0.0.1:15721/dsh/" + id,
  relayed: true,
});

const direct = (id: string): DshRelayStatus["providers"][number] => ({
  providerId: id,
  name: id,
  originalBaseUrl: "https://api.example.com/v1",
  relayBaseUrl: null,
  relayed: false,
});

const status = (
  attached: boolean,
  providers: DshRelayStatus["providers"],
): DshRelayStatus => ({
  relayEnabled: attached,
  restoreOnExit: true,
  attached,
  baseUrl: attached ? "http://127.0.0.1:15721" : null,
  providers,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pending = false;
  // 正在走中转，用户点「直連」要求切回来
  mocks.status = status(true, [relayed("gateway")]);
});

describe("DshRelayNotice", () => {
  it("reports a clean restore when every address is back on direct", async () => {
    mocks.mutateAsync.mockResolvedValue(status(false, [direct("gateway")]));

    render(<DshRelayNotice view="direct" />);
    fireEvent.click(
      screen.getByRole("button", { name: "mode.activate.direct" }),
    );

    await waitFor(() => expect(mocks.success).toHaveBeenCalledTimes(1));
    expect(mocks.success).toHaveBeenCalledWith("dshRelay.relayDisabled");
    expect(mocks.warning).not.toHaveBeenCalled();
  });

  it("warns instead of claiming success when addresses are still relayed", async () => {
    mocks.mutateAsync.mockResolvedValue(status(true, [relayed("gateway")]));

    render(<DshRelayNotice view="direct" />);
    fireEvent.click(
      screen.getByRole("button", { name: "mode.activate.direct" }),
    );

    await waitFor(() => expect(mocks.warning).toHaveBeenCalledTimes(1));
    expect(mocks.warning).toHaveBeenCalledWith(
      'dshRelay.restoreIncomplete:{"count":1}',
      { duration: 6000 },
    );
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it("keeps the failure message when the command itself rejects", async () => {
    mocks.mutateAsync.mockRejectedValue(
      new Error("原子替换失败: os error 1175"),
    );

    render(<DshRelayNotice view="direct" />);
    fireEvent.click(
      screen.getByRole("button", { name: "mode.activate.direct" }),
    );

    await waitFor(() => expect(mocks.error).toHaveBeenCalledTimes(1));
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.warning).not.toHaveBeenCalled();
  });

  it("stays hidden while the viewed mode is the active one", () => {
    render(<DshRelayNotice view="route" />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
