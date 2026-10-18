// DSH 中转设置页的行为测试：
// 1) 后端状态读不到时降级成「状态不可用」，两个开关都锁住（不能盲切）
// 2) 成功切换：调 dsh_set_relay 的 payload 正确、toast 提示、缓存被写回、开关翻面
// 3) 切换失败：toast 报错，开关保持原状，缓存不被污染
// 4) 两把开关各自独立 pending，一个在飞不该连带禁用另一个
// 5) 已接管但 provider 列表为空：给告警文案，不能伪装成「还没到时候」
// 6) 有 provider 但未接管：显示原始地址 +「直连」，不是空列表
//
// 注意：测试环境里 i18n 资源是空的，t(key) 直接返回 key，
// 所以断言文案直接用 i18n key 字符串。
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DshSection } from "@/components/settings/sections/DshSection";
import type { DshRelayStatus } from "@/lib/api/dsh";
import { dshKeys } from "@/lib/query/dsh";

const { invokeMock, toastSuccess, toastError } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("sonner", () => ({
  toast: {
    success: toastSuccess,
    error: toastError,
  },
}));

const baseStatus: DshRelayStatus = {
  relayEnabled: false,
  restoreOnExit: true,
  attached: false,
  baseUrl: null,
  providers: [
    {
      providerId: "deepseek",
      name: "DeepSeek",
      originalBaseUrl: "https://api.deepseek.com/v1",
      relayBaseUrl: null,
      relayed: false,
    },
  ],
};

const relayedStatus: DshRelayStatus = {
  relayEnabled: true,
  restoreOnExit: true,
  attached: true,
  baseUrl: "http://127.0.0.1:15721",
  providers: [
    {
      providerId: "deepseek",
      name: "DeepSeek",
      originalBaseUrl: "https://api.deepseek.com/v1",
      relayBaseUrl: "http://127.0.0.1:15721",
      relayed: true,
    },
  ],
};

/** 接管了但一条 provider 都没写进去：后端 P1-1 语义修好前的旧快照可能长这样 */
const attachedEmptyStatus: DshRelayStatus = {
  ...relayedStatus,
  providers: [],
};

/** 有 provider 但没接管（relayed=false）：应该显示原始地址 + 直连 */
const directStatus: DshRelayStatus = {
  relayEnabled: false,
  restoreOnExit: true,
  attached: false,
  baseUrl: null,
  providers: [
    {
      providerId: "anthropic",
      name: "Anthropic",
      originalBaseUrl: "https://api.anthropic.com",
      relayBaseUrl: null,
      relayed: false,
    },
  ],
};

function renderSection() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <DshSection />
    </QueryClientProvider>,
  );
  return { client, ...view };
}

/** 状态查询读成功，写命令按用例自定义 */
function mockStatusThen(setRelay: (enabled: boolean) => Promise<unknown>) {
  invokeMock.mockImplementation((command: string) => {
    if (command === "dsh_relay_status") return Promise.resolve(baseStatus);
    if (command === "dsh_set_relay") return setRelay(true);
    if (command === "dsh_set_restore_on_exit") {
      return Promise.resolve({ ...baseStatus, restoreOnExit: true });
    }
    return Promise.reject(new Error(`unexpected command: ${command}`));
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
});

describe("DshSection", () => {
  it("状态读不到时显示不可用提示并锁住两个开关", async () => {
    invokeMock.mockRejectedValue(new Error("dsh_relay_status not ready"));

    renderSection();

    // 页头下方那行应用名确实用了 dshRelay.title，不是留着的死键
    expect(screen.getByText("dshRelay.title")).toBeInTheDocument();

    expect(
      await screen.findByText("dshRelay.statusUnavailableHint"),
    ).toBeInTheDocument();
    expect(screen.getByText("dshRelay.statusUnavailable")).toBeInTheDocument();

    const switches = screen.getAllByRole("switch");
    expect(switches).toHaveLength(2);
    expect(switches[0]).toBeDisabled();
    expect(switches[1]).toBeDisabled();
    // 没读到状态就不要乱发写命令
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("dsh_relay_status");
  });

  it("打开接管：调用 dsh_set_relay、提示成功、写回缓存并把开关打开", async () => {
    mockStatusThen(() => Promise.resolve(relayedStatus));

    const { client } = renderSection();
    const switches = await screen.findAllByRole("switch");
    await waitFor(() => expect(switches[0]).toBeEnabled());
    expect(switches[0]).not.toBeChecked();

    fireEvent.click(switches[0]);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("dsh_set_relay", {
        enabled: true,
      }),
    );
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("dshRelay.relayEnabled"),
    );

    expect(client.getQueryData(dshKeys.relayStatus)).toEqual(relayedStatus);
    await waitFor(() => expect(screen.getAllByRole("switch")[0]).toBeChecked());
  });

  it("切换失败：toast 报错，开关与缓存都保持原状", async () => {
    mockStatusThen(() => Promise.reject(new Error("relay blocked")));

    const { client } = renderSection();
    const switches = await screen.findAllByRole("switch");
    await waitFor(() => expect(switches[0]).toBeEnabled());
    expect(switches[0]).not.toBeChecked();

    fireEvent.click(switches[0]);

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("dshRelay.relayFailed"),
    );
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(screen.getAllByRole("switch")[0]).not.toBeChecked();
    expect(client.getQueryData(dshKeys.relayStatus)).toEqual(baseStatus);
  });

  it("一个开关在请求中不连带禁用另一个", async () => {
    let resolveRelay: (status: DshRelayStatus) => void = () => {};
    const pendingRelay = new Promise<DshRelayStatus>((resolve) => {
      resolveRelay = resolve;
    });
    mockStatusThen(() => pendingRelay);

    renderSection();
    const switches = await screen.findAllByRole("switch");
    await waitFor(() => expect(switches[0]).toBeEnabled());

    fireEvent.click(switches[0]);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("dsh_set_relay", {
        enabled: true,
      }),
    );

    expect(switches[0]).toBeDisabled();
    expect(switches[1]).toBeEnabled();

    resolveRelay(relayedStatus);
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
  });

  it("已接管但 provider 为空时给告警，而不是中性空列表文案", async () => {
    invokeMock.mockResolvedValue(attachedEmptyStatus);

    renderSection();

    expect(
      await screen.findByText("dshRelay.noProvidersAttached"),
    ).toBeInTheDocument();
    // 中性文案「接管开启后会显示」在这里会误导，必须不出现
    expect(screen.queryByText("dshRelay.noProviders")).not.toBeInTheDocument();
    // 接管状态本身仍是「已指向中转」
    expect(screen.getByText("dshRelay.attached")).toBeInTheDocument();
  });

  it("未接管的 provider 显示原始地址与「直连」，不是空列表", async () => {
    invokeMock.mockResolvedValue(directStatus);

    renderSection();

    expect(await screen.findByText("dshRelay.direct")).toBeInTheDocument();
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(
      screen.getByText(/https:\/\/api\.anthropic\.com/),
    ).toBeInTheDocument();
    expect(screen.queryByText("dshRelay.noProviders")).not.toBeInTheDocument();
    expect(
      screen.queryByText("dshRelay.noProvidersAttached"),
    ).not.toBeInTheDocument();
  });
});
