import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SelectiveConfigPanel } from "@/components/settings/selective-config/SelectiveConfigPanel";
import { SelectiveConfigSection } from "@/components/settings/selective-config/SelectiveConfigSection";
import type {
  SelectiveCatalog,
  SelectiveSelection,
} from "@/lib/api/selectiveConfig";
import {
  countSelected,
  buildCatalogGroups,
} from "@/components/settings/selective-config/selectionLogic";

const tMock = vi.fn((key: string) => key);
const invokeMock = vi.fn();

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: tMock }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// FullScreenPanel 简化为直接渲染 children，便于断言内部内容
vi.mock("@/components/common/FullScreenPanel", () => ({
  FullScreenPanel: ({
    children,
    title,
  }: {
    children: ReactNode;
    title: string;
  }) => (
    <div>
      <h1>{title}</h1>
      {children}
    </div>
  ),
}));

function makeCatalog(): SelectiveCatalog {
  return {
    providers: [
      {
        appType: "claude",
        items: [
          { id: "p1", name: "Provider One", detail: "https://a.com" },
          { id: "p2", name: "Provider Two", detail: null, exists: true },
        ],
      },
    ],
    customApps: [
      {
        id: "custom-1",
        name: "爱丽",
        icon: null,
        iconColor: null,
        providers: [{ id: "cp1", name: "Custom Provider", detail: null }],
        exists: true,
      },
    ],
    modelPricing: [{ id: "m1", name: "Model One" }],
    modelPresets: [{ id: "preset1", name: "Preset One", detail: "gpt-4" }],
    hasGenericPreset: true,
  };
}

function makeSelection(catalog: SelectiveCatalog): SelectiveSelection {
  return {
    providers: catalog.providers.length
      ? { claude: catalog.providers[0].items.map((i) => i.id) }
      : {},
    customApps: catalog.customApps.map((a) => a.id),
    modelPricing: catalog.modelPricing.map((i) => i.id),
    modelPresets: catalog.modelPresets.map((i) => i.id),
    genericPreset: true,
  };
}

function makePanelProps(overrides: Record<string, unknown> = {}) {
  const catalog = makeCatalog();
  const props = {
    mode: "export" as const,
    catalog,
    selection: makeSelection(catalog),
    busy: false,
    importing: false,
    importFile: null,
    importMode: "append" as const,
    summary: null,
    onSelectionChange: vi.fn(),
    onImportModeChange: vi.fn(),
    onExport: vi.fn(),
    onImport: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  return props;
}

function renderPanel(overrides: Record<string, unknown> = {}) {
  const props = makePanelProps(overrides);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SelectiveConfigPanel {...props} />
    </QueryClientProvider>,
  );
  return props;
}

describe("SelectiveConfigPanel", () => {
  beforeEach(() => {
    tMock.mockImplementation((key: string) => key);
    invokeMock.mockReset();
  });

  it("renders groups with select-all and selected count", () => {
    renderPanel();
    expect(
      screen.getByText("settings.selectiveConfig.exportTitle"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("settings.selectiveConfig.selectAll"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("settings.selectiveConfig.selectedCount"),
    ).toBeInTheDocument();
    // 组名（应用品牌名来自 APP_DISPLAY_NAME，非 i18n）
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText("爱丽")).toBeInTheDocument();
    expect(
      screen.getByText("settings.selectiveConfig.groupModelPricing"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("settings.selectiveConfig.groupModelPresets"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("settings.selectiveConfig.groupGenericPreset"),
    ).toBeInTheDocument();
  });

  it("unchecking one group updates count and tri-state select-all", () => {
    const props = renderPanel();
    // 取消模型定价组
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "settings.selectiveConfig.groupModelPricing",
      }),
    );
    expect(props.onSelectionChange).toHaveBeenCalledTimes(1);
    const next = props.onSelectionChange.mock.calls[0][0] as SelectiveSelection;
    expect(next.modelPricing).toEqual([]);
    // 其余组保持全选
    expect(next.providers.claude).toEqual(["p1", "p2"]);
    expect(next.genericPreset).toBe(true);
  });

  it("export button passes selection to onExport and is disabled when empty", () => {
    const props = renderPanel();
    const exportButton = screen.getByRole("button", {
      name: "settings.selectiveConfig.exportButton",
    });
    expect(exportButton).toBeEnabled();
    fireEvent.click(exportButton);
    expect(props.onExport).toHaveBeenCalledTimes(1);

    // 空选择 → 禁用
    const catalog = makeCatalog();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SelectiveConfigPanel
          {...props}
          key="empty"
          selection={{
            providers: {},
            customApps: [],
            modelPricing: [],
            modelPresets: [],
            genericPreset: false,
          }}
          catalog={catalog}
        />
      </QueryClientProvider>,
    );
    const buttons = screen.getAllByRole("button", {
      name: "settings.selectiveConfig.exportButton",
    });
    expect(buttons[1]).toBeDisabled();
  });

  it("import mode shows exists badge, file name and mode control", () => {
    const catalog = makeCatalog();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SelectiveConfigPanel
          mode="import"
          catalog={catalog}
          selection={makeSelection(catalog)}
          busy={false}
          importing={false}
          importFile={{
            filePath: "C:/tmp/export.json",
            fileName: "export.json",
            appVersion: null,
            exportedAt: null,
          }}
          importMode="append"
          summary={null}
          onSelectionChange={vi.fn()}
          onImportModeChange={vi.fn()}
          onExport={vi.fn()}
          onImport={vi.fn()}
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    );
    for (const btn of screen.getAllByRole("button", {
      name: "settings.selectiveConfig.expandGroup",
    })) {
      fireEvent.click(btn);
    }
    expect(
      screen.getAllByText("settings.selectiveConfig.existsBadge").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByText("settings.selectiveConfig.importFileLabel"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("settings.selectiveConfig.importModeLabel"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("settings.selectiveConfig.modeAppend"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("settings.selectiveConfig.modeOverwrite"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "settings.selectiveConfig.importButton",
      }),
    ).toBeEnabled();
  });

  it("clicking append/overwrite mode buttons calls onImportModeChange", () => {
    const props = { onImportModeChange: vi.fn() };
    const catalog = makeCatalog();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SelectiveConfigPanel
          mode="import"
          catalog={catalog}
          selection={makeSelection(catalog)}
          busy={false}
          importing={false}
          importFile={null}
          importMode="append"
          summary={null}
          onSelectionChange={vi.fn()}
          onImportModeChange={props.onImportModeChange}
          onExport={vi.fn()}
          onImport={vi.fn()}
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByText("settings.selectiveConfig.modeOverwrite"));
    expect(props.onImportModeChange).toHaveBeenCalledWith("overwrite");
  });

  it("summary view shows per-section results, backup id, warning and done button", () => {
    const onClose = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SelectiveConfigPanel
          mode="import"
          catalog={makeCatalog()}
          selection={null}
          busy={false}
          importing={false}
          importFile={null}
          importMode="append"
          summary={{
            sections: [
              {
                section: "providers:claude",
                added: 1,
                overwritten: 2,
                skipped: 3,
                renamed: 4,
              },
              {
                section: "modelPricing",
                added: 0,
                overwritten: 0,
                skipped: 1,
                renamed: 0,
              },
            ],
            backupId: "backup-123",
            warning: "some warning",
          }}
          onSelectionChange={vi.fn()}
          onImportModeChange={vi.fn()}
          onExport={vi.fn()}
          onImport={vi.fn()}
          onClose={onClose}
        />
      </QueryClientProvider>,
    );
    expect(
      screen.getByText("settings.selectiveConfig.sectionProviders"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("settings.selectiveConfig.summaryBackup"),
    ).toBeInTheDocument();
    expect(screen.getByText("some warning")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "settings.selectiveConfig.done" }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("SelectiveConfigSection + useSelectiveConfig (mocked invoke)", () => {
  beforeEach(() => {
    tMock.mockImplementation((key: string) => key);
    invokeMock.mockReset();
  });

  it("export flow: catalog load, dialog, export command with selection", async () => {
    const catalog = makeCatalog();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "get_selective_export_catalog")
        return Promise.resolve(catalog);
      if (cmd === "save_json_file_dialog")
        return Promise.resolve("C:/tmp/out.json");
      if (cmd === "export_selective_config")
        return Promise.resolve({ filePath: "C:/tmp/out.json", total: 8 });
      return Promise.resolve(null);
    });

    render(
      <QueryClientProvider client={new QueryClient()}>
        <SelectiveConfigSection />
      </QueryClientProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "settings.selectiveConfig.exportButton",
      }),
    );

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_selective_export_catalog");
    });
    await waitFor(() => {
      expect(
        screen.getByText("settings.selectiveConfig.selectAll"),
      ).toBeInTheDocument();
    });
    // 面板里的导出按钮
    fireEvent.click(
      screen.getAllByRole("button", {
        name: "settings.selectiveConfig.exportButton",
      })[1],
    );
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("save_json_file_dialog", {
        defaultName: expect.stringMatching(
          /^cc-switch-config-\d{8}-\d{4}\.json$/,
        ),
      });
    });
    const exportCall = invokeMock.mock.calls.find(
      (call) => call[0] === "export_selective_config",
    );
    expect(exportCall).toBeDefined();
    expect(exportCall![1]).toEqual({
      filePath: "C:/tmp/out.json",
      selection: {
        providers: { claude: ["p1", "p2"] },
        customApps: ["custom-1"],
        modelPricing: ["m1"],
        modelPresets: ["preset1"],
        genericPreset: true,
      },
    });
  });

  it("import flow: open dialog cancel closes nothing; preview shows exists badge and default append mode", async () => {
    const catalog = makeCatalog();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "open_json_file_dialog")
        return Promise.resolve("C:/tmp/in.json");
      if (cmd === "read_selective_import_file")
        return Promise.resolve({
          catalog,
          appVersion: "4.0.14",
          exportedAt: null,
        });
      if (cmd === "import_selective_config")
        return Promise.resolve({
          sections: [],
          backupId: "b1",
          warning: null,
        });
      return Promise.resolve(null);
    });

    render(
      <QueryClientProvider client={new QueryClient()}>
        <SelectiveConfigSection />
      </QueryClientProvider>,
    );

    fireEvent.click(
      screen.getAllByRole("button", {
        name: "settings.selectiveConfig.importButton",
      })[0],
    );
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("open_json_file_dialog");
    });
    await waitFor(() => {
      expect(
        screen.getAllByRole("button", {
          name: "settings.selectiveConfig.expandGroup",
        }).length,
      ).toBeGreaterThan(0);
    });
    for (const btn of screen.getAllByRole("button", {
      name: "settings.selectiveConfig.expandGroup",
    })) {
      fireEvent.click(btn);
    }
    expect(
      screen.getAllByText("settings.selectiveConfig.existsBadge").length,
    ).toBeGreaterThan(0);
    // 默认新增模式：hint 显示 append
    expect(
      screen.getByText("settings.selectiveConfig.modeAppendHint"),
    ).toBeInTheDocument();
    // 切换覆盖模式后点导入
    fireEvent.click(screen.getByText("settings.selectiveConfig.modeOverwrite"));
    // 面板 footer 的导入按钮（与外层卡片的触发按钮同名，取第二个）
    fireEvent.click(
      screen.getAllByRole("button", {
        name: "settings.selectiveConfig.importButton",
      })[1],
    );
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("import_selective_config", {
        filePath: "C:/tmp/in.json",
        selection: {
          providers: { claude: ["p1", "p2"] },
          customApps: ["custom-1"],
          modelPricing: ["m1"],
          modelPresets: ["preset1"],
          genericPreset: true,
        },
        mode: "overwrite",
      });
    });
  });

  it("default selection checks every group and select-all is fully checked", () => {
    renderPanel();
    const selectAll = screen.getByRole("checkbox", {
      name: "settings.selectiveConfig.selectAll",
    });
    expect(selectAll).toHaveAttribute("aria-checked", "true");
    for (const name of [
      "Claude Code",
      "爱丽",
      "settings.selectiveConfig.groupModelPricing",
      "settings.selectiveConfig.groupModelPresets",
      "settings.selectiveConfig.groupGenericPreset",
    ]) {
      expect(screen.getByRole("checkbox", { name })).toHaveAttribute(
        "aria-checked",
        "true",
      );
    }
  });

  it("clicking a checked group empties its selection and select-all becomes mixed", () => {
    const props = renderPanel();
    const customCheckbox = screen.getByRole("checkbox", { name: "爱丽" });
    expect(customCheckbox).toHaveAttribute("aria-checked", "true");
    fireEvent.click(customCheckbox);
    expect(props.onSelectionChange).toHaveBeenCalledTimes(1);
    const next = props.onSelectionChange.mock.calls[0][0] as SelectiveSelection;
    expect(next.customApps).toEqual([]);
    // 其余组保持全选
    expect(next.providers.claude).toEqual(["p1", "p2"]);
    expect(next.genericPreset).toBe(true);
  });

  it("unchecking everything via select-all leaves count 0 and disables export", () => {
    const catalog = makeCatalog();
    const emptySelection: SelectiveSelection = {
      providers: {},
      customApps: [],
      modelPricing: [],
      modelPresets: [],
      genericPreset: false,
    };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SelectiveConfigPanel
          {...makePanelProps({ selection: emptySelection, catalog })}
        />
      </QueryClientProvider>,
    );
    const selectAll = screen.getByRole("checkbox", {
      name: "settings.selectiveConfig.selectAll",
    });
    expect(selectAll).toHaveAttribute("aria-checked", "false");
    // 面板单独渲染时只有一个导出按钮
    const exportButton = screen.getAllByRole("button", {
      name: "settings.selectiveConfig.exportButton",
    })[0];
    expect(exportButton).toBeDisabled();
  });

  it("indeterminate select-all click selects everything (mapped true, not the emitted false)", () => {
    const catalog = makeCatalog();
    const partial: SelectiveSelection = {
      providers: { claude: ["p1"] },
      customApps: ["custom-1"],
      modelPricing: ["m1"],
      modelPresets: ["preset1"],
      genericPreset: true,
    };
    const props = renderPanel({ selection: partial, catalog });
    const selectAll = screen.getByRole("checkbox", {
      name: "settings.selectiveConfig.selectAll",
    });
    expect(selectAll).toHaveAttribute("aria-checked", "mixed");
    fireEvent.click(selectAll);
    expect(props.onSelectionChange).toHaveBeenCalledTimes(1);
    // 半选态点击必须全选，而不是采用 input 发出的 false
    const next = props.onSelectionChange.mock.calls[0][0] as SelectiveSelection;
    expect(next).toEqual(makeSelection(catalog));
  });

  it("fully checked select-all click deselects everything", () => {
    const catalog = makeCatalog();
    const props = renderPanel({ catalog });
    const selectAll = screen.getByRole("checkbox", {
      name: "settings.selectiveConfig.selectAll",
    });
    expect(selectAll).toHaveAttribute("aria-checked", "true");
    fireEvent.click(selectAll);
    expect(props.onSelectionChange).toHaveBeenCalledTimes(1);
    const next = props.onSelectionChange.mock.calls[0][0] as SelectiveSelection;
    // 全不选：每个组内没有选中项，计数为 0
    expect(countSelected(buildCatalogGroups(catalog).groups, next)).toBe(0);
    expect(next.genericPreset).toBe(false);
    expect(next.customApps).toEqual([]);
    expect(next.modelPricing).toEqual([]);
    expect(next.modelPresets).toEqual([]);
    expect(next.providers.claude ?? []).toEqual([]);
  });

  it("custom-app-only catalog still exports with customApps selection", () => {
    const catalog = makeCatalog();
    catalog.providers = [];
    // 选择必须基于裁剪后的目录构建，providers 才会是空对象
    const props = renderPanel({ catalog, selection: makeSelection(catalog) });
    const exportButton = screen.getAllByRole("button", {
      name: "settings.selectiveConfig.exportButton",
    })[0];
    expect(exportButton).toBeEnabled();
    fireEvent.click(exportButton);
    expect(props.onExport).toHaveBeenCalledWith({
      providers: {},
      customApps: ["custom-1"],
      modelPricing: ["m1"],
      modelPresets: ["preset1"],
      genericPreset: true,
    });
  });

  it("import mode shows exists badge on the non-expandable custom app group row", () => {
    const catalog = makeCatalog();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SelectiveConfigPanel
          {...makePanelProps({
            mode: "import" as const,
            catalog,
            selection: makeSelection(catalog),
          })}
        />
      </QueryClientProvider>,
    );
    const rows = screen.getAllByText("爱丽");
    expect(rows.length).toBeGreaterThan(0);
    // provider 组仍可展开（存在 expand 按钮）
    expect(
      screen.getAllByRole("button", {
        name: "settings.selectiveConfig.expandGroup",
      }).length,
    ).toBeGreaterThan(0);
    // 组行徽标存在（导入预览模式下自定义应用 exists=true）
    expect(
      screen.getAllByText("settings.selectiveConfig.existsBadge").length,
    ).toBeGreaterThan(0);
  });
});
