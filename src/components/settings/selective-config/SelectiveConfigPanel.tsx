import { useTranslation } from "react-i18next";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { FullScreenPanel } from "@/components/common/FullScreenPanel";
import type {
  SectionResult,
  SelectiveImportMode,
  SelectiveImportSummary,
  SelectiveSelection,
} from "@/lib/api/selectiveConfig";
import { buildCatalogGroups, countSelected } from "./selectionLogic";
import { SelectionTree } from "./SelectionTree";
import type { ImportFileMeta, PanelMode } from "./useSelectiveConfig";

interface SelectiveConfigPanelProps {
  mode: PanelMode;
  catalog: NonNullable<Parameters<typeof buildCatalogGroups>[0]>;
  selection: SelectiveSelection | null;
  busy: boolean;
  importing: boolean;
  importFile: ImportFileMeta | null;
  importMode: SelectiveImportMode;
  summary: SelectiveImportSummary | null;
  onSelectionChange: (next: SelectiveSelection) => void;
  onImportModeChange: (mode: SelectiveImportMode) => void;
  onExport: (selection: SelectiveSelection) => void;
  onImport: (selection: SelectiveSelection) => void;
  onClose: () => void;
}

function sectionLabel(
  result: SectionResult,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  const { section } = result;
  if (section.startsWith("providers:")) {
    const appType = section.slice("providers:".length);
    return t("settings.selectiveConfig.sectionProviders", { appType });
  }
  if (section.startsWith("customApp:")) {
    return t("settings.selectiveConfig.sectionCustomApp", {
      appId: section.slice("customApp:".length),
    });
  }
  if (section === "modelPricing") {
    return t("settings.selectiveConfig.groupModelPricing");
  }
  if (section === "modelPresets") {
    return t("settings.selectiveConfig.groupModelPresets");
  }
  return t("settings.selectiveConfig.groupGenericPreset");
}

function SummaryView({
  summary,
  onClose,
}: {
  summary: SelectiveImportSummary;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <div className="space-y-2 rounded-xl border border-border-strong bg-subtle p-4 text-sm leading-relaxed text-fg-1">
        {summary.sections.map((result) => (
          <div
            key={result.section}
            className="flex flex-wrap items-center gap-x-3 gap-y-1"
          >
            <span className="font-medium">{sectionLabel(result, t)}</span>
            <span className="text-fg-2">
              {t("settings.selectiveConfig.summaryAdded", {
                count: result.added,
              })}
            </span>
            <span className="text-fg-2">
              {t("settings.selectiveConfig.summaryOverwritten", {
                count: result.overwritten,
              })}
            </span>
            <span className="text-fg-2">
              {t("settings.selectiveConfig.summarySkipped", {
                count: result.skipped,
              })}
            </span>
            {result.renamed > 0 ? (
              <span className="text-fg-2">
                {t("settings.selectiveConfig.summaryRenamed", {
                  count: result.renamed,
                })}
              </span>
            ) : null}
          </div>
        ))}
        {summary.backupId ? (
          <p className="text-fg-2">
            {t("settings.selectiveConfig.summaryBackup", {
              backupId: summary.backupId,
            })}
          </p>
        ) : null}
        {summary.warning ? (
          <p className="flex items-start gap-2 text-warning-text">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>{summary.warning}</span>
          </p>
        ) : null}
      </div>
      <div className="flex justify-end">
        <Button variant="solid" size="regular" onClick={onClose}>
          {t("settings.selectiveConfig.done")}
        </Button>
      </div>
    </div>
  );
}

export function SelectiveConfigPanel({
  mode,
  catalog,
  selection,
  busy,
  importing,
  importFile,
  importMode,
  summary,
  onSelectionChange,
  onImportModeChange,
  onExport,
  onImport,
  onClose,
}: SelectiveConfigPanelProps) {
  const { t } = useTranslation();
  const groupsData = buildCatalogGroups(catalog);
  const hasSelection =
    selection !== null && countSelected(groupsData.groups, selection) > 0;
  const title =
    mode === "export"
      ? t("settings.selectiveConfig.exportTitle")
      : t("settings.selectiveConfig.importTitle");

  return (
    <FullScreenPanel
      isOpen
      title={title}
      onClose={onClose}
      backLabel={t("common.back")}
      contentClassName="max-w-3xl"
    >
      {summary ? (
        <SummaryView summary={summary} onClose={onClose} />
      ) : (
        <div className="space-y-4">
          {mode === "import" && importFile ? (
            <p className="min-w-0 truncate text-sm text-fg-2">
              {t("settings.selectiveConfig.importFileLabel", {
                fileName: importFile.fileName,
              })}
            </p>
          ) : null}
          {mode === "export" ? (
            <p className="flex items-start gap-2 text-sm text-warning-text">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>{t("settings.selectiveConfig.exportApiKeyWarning")}</span>
            </p>
          ) : null}
          <div className="space-y-4 rounded-lg border border-border bg-subtle p-6">
            {selection ? (
              <SelectionTree
                groupsData={groupsData}
                selection={selection}
                onSelectionChange={onSelectionChange}
                showExists={mode === "import"}
              />
            ) : (
              <div className="flex items-center justify-center py-8 text-fg-2">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            )}
          </div>
          {mode === "import" ? (
            <div className="space-y-2">
              <p className="text-sm font-medium text-fg-1">
                {t("settings.selectiveConfig.importModeLabel")}
              </p>
              <SegmentedControl<SelectiveImportMode>
                aria-label={t("settings.selectiveConfig.importModeLabel")}
                size="sm"
                value={importMode}
                onValueChange={onImportModeChange}
                items={[
                  {
                    value: "append",
                    label: t("settings.selectiveConfig.modeAppend"),
                  },
                  {
                    value: "overwrite",
                    label: t("settings.selectiveConfig.modeOverwrite"),
                  },
                ]}
              />
              <p className="text-xs leading-relaxed text-fg-2">
                {importMode === "append"
                  ? t("settings.selectiveConfig.modeAppendHint")
                  : t("settings.selectiveConfig.modeOverwriteHint")}
              </p>
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-4">
            <Button
              variant="neutral"
              size="regular"
              onClick={onClose}
              disabled={busy || importing}
            >
              {t("common.cancel")}
            </Button>
            {mode === "export" ? (
              <Button
                variant="solid"
                size="regular"
                disabled={!hasSelection || busy}
                onClick={() => selection && onExport(selection)}
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  t("settings.selectiveConfig.exportButton")
                )}
              </Button>
            ) : (
              <Button
                variant="solid"
                size="regular"
                disabled={!hasSelection || importing}
                onClick={() => selection && onImport(selection)}
              >
                {importing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  t("settings.selectiveConfig.importButton")
                )}
              </Button>
            )}
          </div>
        </div>
      )}
    </FullScreenPanel>
  );
}
