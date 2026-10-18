import { useTranslation } from "react-i18next";
import { V7Dialog } from "@/components/mcp/formBits";
import { Button } from "@/components/ui/button";
import { DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  describePresetParams,
  type ModelPresetApplySource,
  type ModelPresetParams,
} from "@/lib/modelPresets";

export interface ModelPresetPromptDialogProps {
  open: boolean;
  /** 刚添加 / 修改的模型 id，用于在正文里点明「给哪个模型用」。 */
  modelId: string;
  source: ModelPresetApplySource;
  /** source 为 "preset" 时命中的预设名。 */
  presetName?: string;
  params: ModelPresetParams;
  onApply: () => void;
  onSkip: () => void;
}

/**
 * 添加模型时询问「是否套用预设参数」的弹窗。
 * 纯展示组件，开关和回调由 `useModelPresetPrompt` 管。
 */
export function ModelPresetPromptDialog({
  open,
  modelId,
  source,
  presetName,
  params,
  onApply,
  onSkip,
}: ModelPresetPromptDialogProps) {
  const { t } = useTranslation();
  const isPreset = source === "preset";
  const rows = describePresetParams(params, t);

  return (
    <V7Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onSkip();
      }}
    >
      <div className="flex flex-col gap-1.5">
        <DialogTitle className="text-section [overflow-wrap:anywhere]">
          {t("modelPresets.prompt.title")}
        </DialogTitle>
        <DialogDescription className="text-body text-fg-2 [overflow-wrap:anywhere]">
          {isPreset
            ? t("modelPresets.prompt.matchBody", {
                model: modelId,
                preset: presetName ?? "",
              })
            : t("modelPresets.prompt.genericBody", { model: modelId })}
        </DialogDescription>
      </div>

      {rows.length > 0 && (
        <ul className="m-0 list-none space-y-1 rounded-panel border border-border bg-subtle px-3 py-2 text-body text-fg-1">
          {rows.map((row) => (
            <li key={row} className="[overflow-wrap:anywhere]">
              {row}
            </li>
          ))}
        </ul>
      )}

      <p className="m-0 text-caption text-fg-3">
        {t("modelPresets.prompt.note")}
      </p>

      <div className="flex flex-wrap justify-end gap-2 pt-1">
        <Button
          type="button"
          variant="neutral"
          size="regular"
          autoFocus
          onClick={onSkip}
        >
          {t("modelPresets.prompt.skip")}
        </Button>
        <Button type="button" variant="solid" size="regular" onClick={onApply}>
          {isPreset
            ? t("modelPresets.prompt.applyPreset")
            : t("modelPresets.prompt.applyGeneric")}
        </Button>
      </div>
    </V7Dialog>
  );
}
