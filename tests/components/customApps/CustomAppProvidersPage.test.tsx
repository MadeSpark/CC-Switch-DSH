import type { ReactElement } from "react";
import { createElement } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "i18next";
import zhLocale from "@/i18n/locales/zh.json";
import type { CustomApp } from "@/lib/api/customApps";
import type { Provider } from "@/types";

vi.mock("@/lib/api/customApps", () => ({
  customAppsApi: {
    listCustomApps: vi.fn(),
    createCustomApp: vi.fn(),
    updateCustomApp: vi.fn(),
    deleteCustomApp: vi.fn(),
    regenerateCustomAppKey: vi.fn(),
    listCustomAppModels: vi.fn(),
    listCustomAppProviders: vi.fn(),
    saveCustomAppProvider: vi.fn(),
    deleteCustomAppProvider: vi.fn(),
  },
}));

vi.mock("@/lib/query/proxy", () => ({
  useProxyStatusQuery: vi.fn(),
}));

vi.mock("@/lib/clipboard", () => ({
  copyText: vi.fn().mockResolvedValue(undefined),
}));

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

import { CustomAppProvidersPage } from "@/components/custom-apps/CustomAppProvidersPage";
import { customAppsApi } from "@/lib/api/customApps";
import { useProxyStatusQuery } from "@/lib/query/proxy";
import { copyText } from "@/lib/clipboard";
import { toast } from "@/lib/toast";

beforeAll(() => {
  i18n.addResourceBundle("zh", "translation", zhLocale, true, true);
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

const provider = (overrides: Partial<Provider> = {}): Provider =>
  ({
    id: "provider-a",
    name: "供应商A",
    settingsConfig: {
      authType: "api_key",
      baseURL: "https://api.example.com",
      apiKey: "sk-provider",
      models: [{ id: "gpt-4o", name: "GPT-4o" }],
    },
    icon: "openai",
    iconColor: null,
    category: "custom",
    ...overrides,
  }) as Provider;

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(CustomAppProvidersPage, { app: app() }),
    ),
  );
}

beforeEach(() => {
  vi.mocked(useProxyStatusQuery).mockReturnValue({
    data: { running: true, port: 8117 },
  } as never);
  vi.mocked(customAppsApi.listCustomAppProviders).mockResolvedValue({
    "provider-a": provider(),
  });
  vi.mocked(customAppsApi.listCustomAppModels).mockResolvedValue([
    {
      id: "claude-sonnet-4-provider-a",
      upstreamModel: "claude-sonnet-4",
      providerId: "provider-a",
      providerName: "供应商A",
      appType: "claude",
    },
  ]);
});

describe("CustomAppProvidersPage 供应商列表", () => {
  it("渲染应用头部与供应商卡片", async () => {
    renderPage();
    expect(
      await screen.findByText("自定义应用固定走聚合路由：模型来自启用的供应商，不支持直连单个供应商。"),
    ).toBeInTheDocument();
    expect(await screen.findByText("供应商A")).toBeInTheDocument();
    expect(screen.getByText(/provider-a/)).toBeInTheDocument();
    expect(screen.getByText(/api\.example\.com/)).toBeInTheDocument();
    expect(screen.getAllByText("聚合模型（1）").length).toBeGreaterThan(0);
  });

  it("显示打码的 API Key，不出现完整 Key", async () => {
    renderPage();
    expect(await screen.findByText(/sk-cus••••••/)).toBeInTheDocument();
    expect(screen.queryByText(/abcdef/)).not.toBeInTheDocument();
  });

  it("空列表显示空态文案", async () => {
    vi.mocked(customAppsApi.listCustomAppProviders).mockResolvedValue({});
    renderPage();
    expect(
      await screen.findByText(
        "没有可聚合的模型：先在供应商页启用并配置模型。",
      ),
    ).toBeInTheDocument();
  });

  it("复制 API 地址调用剪贴板并弹成功 toast", async () => {
    renderPage();
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
});

describe("CustomAppProvidersPage 新建供应商", () => {
  it("点击添加供应商打开弹窗，slug 自动派生且转为小写", async () => {
    renderPage();
    await userEvent.click(
      await screen.findByRole("button", { name: "添加供应商" }),
    );
    const nameInput = await screen.findByLabelText("供应商名称");
    await userEvent.type(nameInput, "My Provider");
    const idInput = screen.getByLabelText("供应商标识");
    await waitFor(() => expect(idInput).toHaveValue("my-provider"));
  });

  it("手动编辑标识后不再自动派生", async () => {
    renderPage();
    await userEvent.click(
      await screen.findByRole("button", { name: "添加供应商" }),
    );
    const idInput = await screen.findByLabelText("供应商标识");
    await userEvent.type(idInput, "fixed-id");
    const nameInput = screen.getByLabelText("供应商名称");
    await userEvent.type(nameInput, "另一个");
    await waitFor(() => expect(idInput).toHaveValue("fixed-id"));
  });

  it("大写标识阻止提交", async () => {
    renderPage();
    await userEvent.click(
      await screen.findByRole("button", { name: "添加供应商" }),
    );
    await userEvent.type(
      screen.getByLabelText("供应商标识"),
      "Uppercase-Id",
    );
    await userEvent.type(
      screen.getByLabelText("供应商名称"),
      "供应商X",
    );
    await userEvent.type(
      screen.getByLabelText("Base URL"),
      "https://api.example.com",
    );
    const confirm = screen.getByRole("button", { name: "保存" });
    expect(confirm).toBeDisabled();
  });

  it("完整表单提交调用 saveCustomAppProvider", async () => {
    vi.mocked(customAppsApi.saveCustomAppProvider).mockResolvedValue(
      {} as Record<string, Provider>,
    );
    renderPage();
    await userEvent.click(
      await screen.findByRole("button", { name: "添加供应商" }),
    );
    await userEvent.type(
      screen.getByLabelText("供应商名称"),
      "供应商X",
    );
    await userEvent.type(
      screen.getByLabelText("Base URL"),
      "https://api.example.com",
    );
    await userEvent.type(
      screen.getByLabelText("API Key"),
      "sk-new",
    );
    await userEvent.type(
      screen.getByPlaceholderText("模型 ID"),
      "gpt-4o",
    );
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      expect(customAppsApi.saveCustomAppProvider).toHaveBeenCalledWith(
        "app-1",
        expect.objectContaining({
          id: expect.stringMatching(/^[a-z0-9][a-z0-9-]*$/),
          name: "供应商X",
        }),
      );
    });
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalled();
    });
  });
});

describe("CustomAppProvidersPage 编辑与删除", () => {
  it("编辑：弹窗预填并保存调用 saveCustomAppProvider", async () => {
    vi.mocked(customAppsApi.saveCustomAppProvider).mockResolvedValue(
      {} as Record<string, Provider>,
    );
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "编辑" }));
    const idInput = await screen.findByLabelText("供应商标识");
    expect(idInput).toHaveValue("provider-a");
    expect(idInput).toBeDisabled();
    const nameInput = screen.getByLabelText("供应商名称");
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "供应商A改");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      expect(customAppsApi.saveCustomAppProvider).toHaveBeenCalledWith(
        "app-1",
        expect.objectContaining({ id: "provider-a", name: "供应商A改" }),
      );
    });
  });

  it("删除：确认后调用 deleteCustomAppProvider", async () => {
    vi.mocked(customAppsApi.deleteCustomAppProvider).mockResolvedValue(true as never);
    renderPage();
    expect(await screen.findByText("供应商A")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(await screen.findByText("删除「供应商A」")).toBeInTheDocument();
    const dialog = screen.getByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "删除" }),
    );
    await waitFor(() => {
      expect(customAppsApi.deleteCustomAppProvider).toHaveBeenCalledWith(
        "app-1",
        "provider-a",
      );
    });
  });
});
