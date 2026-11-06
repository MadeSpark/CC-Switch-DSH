import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { SelectiveConfigPanel } from "./SelectiveConfigPanel";
import { useSelectiveConfig } from "./useSelectiveConfig";

/**
 * 设置页「选择性导出 / 导入」卡片：两个入口按钮 + 全屏选择面板。
 * 挂载点在 SettingsPage 的「数据管理」SettingsBlock 内、ImportExportSection 卡片之后。
 */
export function SelectiveConfigSection() {
  const { t } = useTranslation();
  const [panelOpen, setPanelOpen] = useState(false);
  const [pendingMode, setPendingMode] = useState<"export" | "import">("export");

  const {
    mode,
    catalog,
    selection,
    setSelection,
    busy,
    importing,
    importFile,
    importMode,
    setImportMode,
    summary,
    openExport,
    openImport,
    doExport,
    doImport,
    close,
  } = useSelectiveConfig(() => setPanelOpen(false));

  const openPanel = async (kind: "export" | "import") => {
    setPendingMode(kind);
    setPanelOpen(true);
    if (kind === "export") {
      await openExport();
    } else {
      await openImport();
    }
  };

  return (
    <section className="space-y-4">
      <h3 className="text-base font-semibold text-fg-1">
        {t("settings.selectiveConfig.title")}
      </h3>
      <p className="text-sm text-fg-2">
        {t("settings.selectiveConfig.description")}
      </p>
      <div className="grid grid-cols-2 gap-4">
        <Button
          variant="neutral"
          size="regular"
          onClick={() => void openPanel("export")}
        >
          {t("settings.selectiveConfig.exportButton")}
        </Button>
        <Button
          variant="neutral"
          size="regular"
          onClick={() => void openPanel("import")}
        >
          {t("settings.selectiveConfig.importButton")}
        </Button>
      </div>
      {panelOpen && catalog ? (
        <SelectiveConfigPanel
          mode={pendingMode === "import" ? "import" : mode}
          catalog={catalog}
          selection={selection}
          busy={busy}
          importing={importing}
          importFile={importFile}
          importMode={importMode}
          summary={summary}
          onSelectionChange={setSelection}
          onImportModeChange={setImportMode}
          onExport={(next) => void doExport(next)}
          onImport={(next) => void doImport(next)}
          onClose={close}
        />
      ) : null}
    </section>
  );
}
