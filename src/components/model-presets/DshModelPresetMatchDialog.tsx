import { useState } from "react";
import { useTranslation } from "react-i18next";
import { V7Dialog } from "@/components/mcp/formBits";
import { Button } from "@/components/ui/button";
import { DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useModelPresets } from "@/hooks/useModelPresets";
import { applyPresetToDshModel } from "@/lib/dshModelPresets";
import {
  describePresetParams,
  hasPresetParams,
  matchModelPreset,
  type ModelPresetParams,
} from "@/lib/modelPresets";
import type { DshModel } from "@/components/providers/forms/helpers/deepseekHarnessFormUtils";

const NONE = "__unmatched__";
const GENERIC = "__generic__";
const presetValue = (id: string) => `preset:${id}`;

interface DshModelPresetMatchDialogProps {
  models: DshModel[];
  onApply: (models: DshModel[]) => void;
  onClose: () => void;
}

/** Mounted only while open, so opening the model editor alone never fetches presets. */
export function DshModelPresetMatchDialog({
  models,
  onApply,
  onClose,
}: DshModelPresetMatchDialogProps) {
  const { t } = useTranslation();
  const { presets, generic, isLoading, isError, refetch } = useModelPresets();
  const [overrides, setOverrides] = useState<Record<number, string>>({});
  const ready = !isLoading && !isError;

  const rows = models.map((model, index) => {
    const match = matchModelPreset(model.id, presets);
    const selected = overrides[index] ?? (match ? presetValue(match.id) : NONE);
    const params: ModelPresetParams | undefined =
      selected === GENERIC
        ? generic
        : presets.find((preset) => presetValue(preset.id) === selected);
    return {
      model,
      index,
      selected,
      params,
      applicable: !!model.id.trim() && hasPresetParams(params),
    };
  });
  const selectedCount = rows.filter((row) => row.applicable).length;
  const apply = () => {
    if (!ready || selectedCount === 0) return;
    onApply(
      rows.map(({ model, params, applicable }) =>
        applicable && params ? applyPresetToDshModel(model, params) : model,
      ),
    );
    onClose();
  };

  return (
    <V7Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      width={800}
      className="min-h-0 overflow-hidden"
    >
      <div className="space-y-1.5">
        <DialogTitle className="text-section">
          {t("modelPresets.match.title", { defaultValue: "一键匹配预设" })}
        </DialogTitle>
        <DialogDescription className="text-body text-fg-2">
          {t("modelPresets.match.description", {
            defaultValue:
              "按模型 ID 自动匹配预设；未匹配的模型可手动选择其他预设或通用预设。确认后更新当前表单，保存供应商后生效。",
          })}
        </DialogDescription>
      </div>

      {isLoading ? (
        <p role="status" className="text-body text-fg-2">
          {t("modelPresets.match.loading", {
            defaultValue: "正在读取模型预设…",
          })}
        </p>
      ) : isError ? (
        <div className="space-y-2" role="alert">
          <p className="text-body text-danger-text">
            {t("modelPresets.match.loadFailed", {
              defaultValue: "读取模型预设失败，请重试。",
            })}
          </p>
          <Button
            type="button"
            variant="neutral"
            size="compact"
            onClick={refetch}
          >
            {t("modelPresets.match.retry", { defaultValue: "重试" })}
          </Button>
        </div>
      ) : (
        <div className="min-h-0 max-h-[55vh] space-y-3 overflow-y-auto">
          {presets.length === 0 && (
            <p className="text-caption text-fg-3">
              {t("modelPresets.match.noPresets", {
                defaultValue:
                  "尚无模型预设，可先在模型预设页面导入或新增，也可在此选择已配置的通用预设。",
              })}
            </p>
          )}
          {rows.length === 0 ? (
            <p className="text-body text-fg-2">
              {t("modelPresets.match.noModels", {
                defaultValue: "暂无可匹配的模型。",
              })}
            </p>
          ) : (
            <div className="overflow-hidden rounded-panel border border-border">
              <div className="sticky top-0 z-10 grid grid-cols-2 gap-4 border-b border-border bg-surface px-3 py-2 text-caption font-medium text-fg-2">
                <span>
                  {t("modelPresets.match.modelId", { defaultValue: "模型 ID" })}
                </span>
                <span>
                  {t("modelPresets.match.preset", { defaultValue: "匹配预设" })}
                </span>
              </div>
              {rows.map(({ model, index, selected, params }) => (
                <div
                  key={model.rowKey ?? index}
                  className="grid grid-cols-2 items-start gap-4 border-b border-border px-3 py-3 last:border-b-0"
                >
                  <code
                    className="min-w-0 break-all py-1.5 font-mono text-body"
                    title={model.id}
                  >
                    {model.id ||
                      t("modelPresets.match.blankModel", {
                        defaultValue: "空模型 ID（跳过）",
                      })}
                  </code>
                  <div className="min-w-0 space-y-1.5">
                    <Select
                      value={selected}
                      disabled={!model.id.trim()}
                      onValueChange={(value) =>
                        setOverrides((current) => ({
                          ...current,
                          [index]: value,
                        }))
                      }
                    >
                      <SelectTrigger
                        className="w-full min-w-0"
                        aria-label={t("modelPresets.match.selectFor", {
                          defaultValue: "为 {{model}} 选择预设",
                          model: model.id || String(index + 1),
                        })}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="max-w-[min(600px,calc(100vw-48px))]">
                        <SelectItem value={NONE}>
                          {t("modelPresets.match.unmatched", {
                            defaultValue: "未匹配（不应用）",
                          })}
                        </SelectItem>
                        <SelectItem
                          value={GENERIC}
                          disabled={!hasPresetParams(generic)}
                        >
                          {hasPresetParams(generic)
                            ? t("modelPresets.match.generic", {
                                defaultValue: "使用通用预设",
                              })
                            : t("modelPresets.match.genericEmpty", {
                                defaultValue: "通用预设（尚未配置参数）",
                              })}
                        </SelectItem>
                        {presets.map((preset) => (
                          <SelectItem
                            key={preset.id}
                            value={presetValue(preset.id)}
                            disabled={!hasPresetParams(preset)}
                            title={`${preset.name} (${preset.modelId})`}
                          >
                            <span className="block max-w-full truncate">
                              {preset.name} ({preset.modelId})
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {params && (
                      <p
                        className="m-0 line-clamp-2 break-all text-caption text-fg-3"
                        title={describePresetParams(params, t).join(" · ")}
                      >
                        {describePresetParams(params, t).join(" · ") ||
                          t("modelPresets.match.emptyParams", {
                            defaultValue: "该预设未配置参数。",
                          })}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <span className="text-caption text-fg-3">
          {t("modelPresets.match.selectedCount", {
            defaultValue: "将为 {{count}} 个模型应用预设",
            count: ready ? selectedCount : 0,
          })}
        </span>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="neutral"
            size="regular"
            onClick={onClose}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            variant="solid"
            size="regular"
            onClick={apply}
            disabled={!ready || selectedCount === 0}
          >
            {t("modelPresets.match.apply", { defaultValue: "应用所选预设" })}
          </Button>
        </div>
      </div>
    </V7Dialog>
  );
}
