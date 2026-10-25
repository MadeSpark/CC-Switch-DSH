import type { ReactElement } from "react";
import { createElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "i18next";
import zhLocale from "@/i18n/locales/zh.json";
import type { CustomApp } from "@/lib/api/customApps";

vi.mock("@/lib/api/customApps", () => ({
  customAppsApi: {
    listCustomApps: vi.fn(),
    createCustomApp: vi.fn(),
    updateCustomApp: vi.fn(),
    deleteCustomApp: vi.fn(),
    regenerateCustomAppKey: vi.fn(),
    listCustomAppModels: vi.fn(),
  },
}));

vi.mock("@/lib/query/proxy", () => ({
  useProxyStatusQuery: vi.fn(),
}));

vi.mock("@/lib/clipboard", () => ({
  copyText: vi.fn().mockResolvedValue(undefined),
}));

import {
  CustomAppsPage,
  useCustomAppAddress,
} from "@/components/custom-apps/CustomAppsPage";
import { customAppsApi } from "@/lib/api/customApps";
import { useProxyStatusQuery } from "@/lib/query/proxy";
import { copyText } from "@/lib/clipboard";
import { toast } from "@/lib/toast";

// 用真实 zh 资源，断言中文文案
beforeAll(() => {
  i18n.addResourceBundle("zh", "translation", zhLocale, true, true);
});

vi.mock("@/lib/toast", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/toast")>();
  return {
    ...actual,
    toast: {
      ...actual.toast,
      success: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
    },
  };
});

const app = (overrides: Partial<CustomApp> = {}): CustomApp => ({
  id: "app-1",
  name: "聚合入口",
  icon: "openai",
  iconColor: null,
  apiKey: "sk-custom-abcdef123456",
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
  ...overrides,
});

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(CustomAppsPage),
    ),
  );
}

beforeEach(() => {
  vi.mocked(useProxyStatusQuery).mockReturnValue({
    data: { running: true, port: 8117 },
  } as never);
  vi.mocked(customAppsApi.listCustomApps).mockResolvedValue([app()]);
  vi.mocked(customAppsApi.listCustomAppModels).mockResolvedValue([
    {
      id: "claude-sonnet-4-providerA",
      upstreamModel: "claude-sonnet-4",
      providerId: "providerA",
      providerName: "供应商A",
      appType: "claude",
    },
  ]);
});

describe("CustomAppsPage 列表展示", () => {
  it("渲染应用卡片：名称和打码后的 API Key", async () => {
    renderPage();
    expect(await screen.findByText("聚合入口")).toBeInTheDocument();
    // Key 打码展示：先展开卡片
    await userEvent.click(screen.getByRole("button", { name: /聚合入口/ }));
    expect(await screen.findByText(/sk-cus••••••/)).toBeInTheDocument();
    expect(screen.queryByText(/abcdef/)).not.toBeInTheDocument();
  });

  it("空列表时显示空态文案", async () => {
    vi.mocked(customAppsApi.listCustomApps).mockResolvedValue([]);
    renderPage();
    expect(
      await screen.findByText(
        "还没有自定义应用。点右上角「添加应用」创建一个。",
      ),
    ).toBeInTheDocument();
  });

  it("路由未运行时 API 地址显示占位提示", async () => {
    vi.mocked(useProxyStatusQuery).mockReturnValue({
      data: { running: false, port: 0 },
    } as never);
    renderPage();
    await screen.findByText("聚合入口");
    const toggle = screen.getByRole("button", { name: /聚合入口/ });
    await userEvent.click(toggle);
    expect(await screen.findByText("先启动本地路由")).toBeInTheDocument();
  });

  it("展开卡片显示按当前端口拼出的 API 地址和聚合模型", async () => {
    renderPage();
    await screen.findByText("聚合入口");
    await userEvent.click(screen.getByRole("button", { name: /聚合入口/ }));
    const address = await screen.findByText(
      "http://127.0.0.1:8117/custom/app-1/v1",
    );
    expect(address).toBeInTheDocument();
    expect(
      await screen.findByText("claude-sonnet-4-providerA"),
    ).toBeInTheDocument();
    expect(await screen.findByText("聚合模型（1）")).toBeInTheDocument();
  });

  it("复制 API 地址调用剪贴板并弹成功 toast", async () => {
    renderPage();
    await screen.findByText("聚合入口");
    await userEvent.click(screen.getByRole("button", { name: /聚合入口/ }));
    const copyBtn = await screen.findByRole("button", {
      name: "复制 API 地址",
    });
    await userEvent.click(copyBtn);
    await waitFor(() => {
      expect(copyText).toHaveBeenCalledWith(
        "http://127.0.0.1:8117/custom/app-1/v1",
      );
      expect(toast.success).toHaveBeenCalledWith("API 地址已复制");
    });
  });

  it("复制 API Key 调用剪贴板（完整值，不传打码值）", async () => {
    renderPage();
    await screen.findByText("聚合入口");
    await userEvent.click(screen.getByRole("button", { name: /聚合入口/ }));
    const copyBtn = await screen.findByRole("button", { name: "复制 API Key" });
    await userEvent.click(copyBtn);
    await waitFor(() => {
      expect(copyText).toHaveBeenCalledWith("sk-custom-abcdef123456");
      expect(toast.success).toHaveBeenCalledWith("API Key 已复制");
    });
  });
});

describe("CustomAppsPage 新建与编辑", () => {
  it("新建：填名称后确认调用 createCustomApp", async () => {
    vi.mocked(customAppsApi.createCustomApp).mockResolvedValue(app());
    renderPage();
    await userEvent.click(
      await screen.findByRole("button", { name: /添加应用/ }),
    );
    const input = await screen.findByLabelText("名称");
    await userEvent.type(input, "新应用");
    await userEvent.click(screen.getByRole("button", { name: "确定" }));
    await waitFor(() => {
      expect(customAppsApi.createCustomApp).toHaveBeenCalledWith(
        "新应用",
        expect.any(String),
        null,
      );
    });
  });

  it("编辑：预填名称，保存调用 updateCustomApp", async () => {
    vi.mocked(customAppsApi.updateCustomApp).mockResolvedValue(app());
    renderPage();
    await screen.findByText("聚合入口");
    await userEvent.click(screen.getByRole("button", { name: "编辑" }));
    const input = await screen.findByLabelText("名称");
    expect(input).toHaveValue("聚合入口");
    await userEvent.clear(input);
    await userEvent.type(input, "改名");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      expect(customAppsApi.updateCustomApp).toHaveBeenCalledWith(
        "app-1",
        "改名",
        expect.any(String),
        null,
      );
    });
  });
});

describe("CustomAppsPage 删除与重置 Key", () => {
  it("删除：确认后调用 deleteCustomApp", async () => {
    vi.mocked(customAppsApi.deleteCustomApp).mockResolvedValue(true);
    renderPage();
    await screen.findByText("聚合入口");
    await userEvent.click(screen.getByRole("button", { name: "删除" }));
    // ConfirmDialog 弹出，标题含应用名
    expect(await screen.findByText("删除「聚合入口」")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "确定" }));
    await waitFor(() => {
      expect(customAppsApi.deleteCustomApp).toHaveBeenCalledWith("app-1");
    });
  });

  it("重置 API Key：按钮触发 regenerateCustomAppKey", async () => {
    vi.mocked(customAppsApi.regenerateCustomAppKey).mockResolvedValue(app());
    renderPage();
    await screen.findByText("聚合入口");
    await userEvent.click(screen.getByRole("button", { name: /聚合入口/ }));
    const resetBtn = await screen.findByRole("button", {
      name: "重置 API Key",
    });
    await userEvent.click(resetBtn);
    await waitFor(() => {
      expect(customAppsApi.regenerateCustomAppKey).toHaveBeenCalledWith(
        "app-1",
      );
    });
  });
});

describe("useCustomAppAddress", () => {
  it("路由运行时按端口拼地址", () => {
    let address: string | null = null;
    vi.mocked(useProxyStatusQuery).mockReturnValue({
      data: { running: true, port: 9000 },
    } as never);
    function Probe() {
      address = useCustomAppAddress("xyz");
      return null;
    }
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(Probe) as ReactElement,
      ),
    );
    expect(address).toBe("http://127.0.0.1:9000/custom/xyz/v1");
  });
});
