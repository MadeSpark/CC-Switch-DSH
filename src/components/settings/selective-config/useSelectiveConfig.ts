import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "@/lib/toast";
import {
  exportSelectiveConfig,
  getSelectiveExportCatalog,
  importSelectiveConfig,
  openJsonFileDialog,
  readSelectiveImportFile,
  saveJsonFileDialog,
  type SelectiveCatalog,
  type SelectiveImportMode,
  type SelectiveImportSummary,
  type SelectiveSelection,
} from "@/lib/api/selectiveConfig";
import { customAppsKeys } from "@/lib/query/customApps";
import { usageKeys } from "@/lib/query/usage";
import { modelPresetQueryKey } from "@/hooks/useModelPresets";
import { defaultSelection } from "./selectionLogic";

/** 选择性导出 / 导入面板的状态机与副作用。 */
export type PanelMode = "export" | "import";

export interface ImportFileMeta {
  filePath: string;
  fileName: string;
  appVersion?: string | null;
  exportedAt?: string | null;
}

export function useSelectiveConfig(onClose: () => void) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [mode, setMode] = useState<PanelMode>("export");
  const [catalog, setCatalog] = useState<SelectiveCatalog | null>(null);
  const [selection, setSelection] = useState<SelectiveSelection | null>(null);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importFile, setImportFile] = useState<ImportFileMeta | null>(null);
  const [importMode, setImportMode] = useState<SelectiveImportMode>("append");
  const [summary, setSummary] = useState<SelectiveImportSummary | null>(null);

  /** 打开导出面板：拉目录，默认全选 */
  const openExport = useCallback(async () => {
    setMode("export");
    setSummary(null);
    setImportFile(null);
    setBusy(true);
    try {
      const nextCatalog = await getSelectiveExportCatalog();
      setCatalog(nextCatalog);
      setSelection(defaultSelection(nextCatalog));
    } catch (error) {
      console.error("get_selective_export_catalog failed:", error);
      toast.error(t("settings.selectiveConfig.catalogLoadFailed"));
    } finally {
      setBusy(false);
    }
  }, [t]);

  /** 打开导入面板：选文件 → 只读解析 → 预览目录，默认全选 + 新增模式 */
  const openImport = useCallback(async () => {
    setMode("import");
    setSummary(null);
    setBusy(true);
    try {
      const filePath = await openJsonFileDialog();
      if (!filePath) {
        onClose();
        return;
      }
      const preview = await readSelectiveImportFile(filePath);
      setImportFile({
        filePath,
        fileName: filePath.split(/[\\/]/).pop() ?? filePath,
        appVersion: preview.appVersion ?? null,
        exportedAt: preview.exportedAt ?? null,
      });
      setCatalog(preview.catalog);
      setSelection(defaultSelection(preview.catalog));
      setImportMode("append");
    } catch (error) {
      console.error("read_selective_import_file failed:", error);
      toast.error(t("settings.selectiveConfig.importReadFailed"));
      onClose();
    } finally {
      setBusy(false);
    }
  }, [t, onClose]);

  /** 导出：保存对话框 → 导出命令 → toast + 关面板 */
  const doExport = useCallback(
    async (currentSelection: SelectiveSelection) => {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const defaultName = `cc-switch-config-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.json`;
      const filePath = await saveJsonFileDialog(defaultName);
      if (!filePath) return;
      setBusy(true);
      try {
        const result = await exportSelectiveConfig(filePath, currentSelection);
        toast.success(
          t("settings.selectiveConfig.exportSuccess", {
            count: result.total,
          }),
        );
        onClose();
      } catch (error) {
        console.error("export_selective_config failed:", error);
        toast.error(t("settings.selectiveConfig.exportFailed"));
      } finally {
        setBusy(false);
      }
    },
    [t, onClose],
  );

  /** 导入：执行导入命令 → 存摘要 → invalidate 全部相关缓存 */
  const doImport = useCallback(
    async (currentSelection: SelectiveSelection) => {
      if (!importFile) return;
      setImporting(true);
      try {
        const result = await importSelectiveConfig(
          importFile.filePath,
          currentSelection,
          importMode,
        );
        setSummary(result);
        // 失效全部相关 react-query 缓存
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["providers"] }),
          queryClient.invalidateQueries({ queryKey: customAppsKeys.all }),
          queryClient.invalidateQueries({ queryKey: usageKeys.all }),
          queryClient.invalidateQueries({ queryKey: modelPresetQueryKey }),
          queryClient.invalidateQueries({ queryKey: ["settings"] }),
        ]);
      } catch (error) {
        console.error("import_selective_config failed:", error);
        toast.error(t("settings.selectiveConfig.importFailed"));
      } finally {
        setImporting(false);
      }
    },
    [importFile, importMode, queryClient, t],
  );

  const close = useCallback(() => {
    setCatalog(null);
    setSelection(null);
    setSummary(null);
    setImportFile(null);
    onClose();
  }, [onClose]);

  return {
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
  };
}
