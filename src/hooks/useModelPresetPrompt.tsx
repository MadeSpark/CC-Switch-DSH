import { useCallback, useMemo, useState, type ReactNode } from "react";
import { ModelPresetPromptDialog } from "@/components/model-presets/ModelPresetPromptDialog";
import { useModelPresets } from "@/hooks/useModelPresets";
import {
  hasPresetParams,
  matchModelPreset,
  pickPresetParams,
  readGenericPromptEnabled,
  type ModelPreset,
  type ModelPresetApplySource,
  type ModelPresetParams,
} from "@/lib/modelPresets";

export type { ModelPresetApplySource } from "@/lib/modelPresets";

/**
 * 用户点「套用」时回调：
 * - params：可套用的参数（不含 id / name / modelId，已过滤无效字段）
 * - source：命中预设是 "preset"，套用通用参数是 "generic"
 * - preset：source 为 "preset" 时对应的预设
 */
export type ModelPresetApplyHandler = (
  params: ModelPresetParams,
  source: ModelPresetApplySource,
  preset?: ModelPreset,
) => void;

interface PendingPrompt {
  modelId: string;
  source: ModelPresetApplySource;
  preset?: ModelPreset;
  onApply: ModelPresetApplyHandler;
}

export interface UseModelPresetPromptResult {
  /**
   * 添加 / 修改模型 id 后调用：命中预设（或通用参数且开关打开）就弹询问框，返回是否弹了。
   * 数据还没加载完时返回 false，加载完后再调用一次即可。
   */
  offerPresetForModel: (
    modelId: string,
    onApply: ModelPresetApplyHandler,
  ) => boolean;
  /** offerPresetForModel 的短别名。 */
  offer: (modelId: string, onApply: ModelPresetApplyHandler) => boolean;
  /** 需要渲染在表单 JSX 里的询问弹窗；没有要问的内容时是 null。 */
  dialog: ReactNode;
  /** 是否正显示询问弹窗。 */
  isPending: boolean;
  isLoading: boolean;
}

/**
 * 添加模型时询问是否套用预设（或通用参数）。
 *
 * 用法（T5 在供应商表单里接入）：
 * ```tsx
 * const { offerPresetForModel, dialog } = useModelPresetPrompt();
 * // 用户填好 model id 之后（例如 onBlur 或点添加时）：
 * offerPresetForModel(modelId, (params, source, preset) => {
 *   applyPresetParams(params); // 写进表单字段
 * });
 * // JSX 末尾渲染：
 * {dialog}
 * ```
 */
export function useModelPresetPrompt(): UseModelPresetPromptResult {
  const { presets, generic, isLoading } = useModelPresets();
  const [pending, setPending] = useState<PendingPrompt | null>(null);

  const offerPresetForModel = useCallback(
    (modelId: string, onApply: ModelPresetApplyHandler): boolean => {
      const trimmed = modelId.trim();
      if (!trimmed || isLoading) return false;
      // 同一个模型已经弹着询问框时不重复弹
      if (pending && pending.modelId === trimmed) return true;

      const preset = matchModelPreset(trimmed, presets);
      if (preset) {
        if (!hasPresetParams(preset)) return false;
        setPending({
          modelId: trimmed,
          source: "preset",
          preset,
          onApply,
        });
        return true;
      }

      if (readGenericPromptEnabled() && hasPresetParams(generic)) {
        setPending({ modelId: trimmed, source: "generic", onApply });
        return true;
      }

      return false;
    },
    [generic, isLoading, pending, presets],
  );

  const close = useCallback(() => setPending(null), []);

  const params = useMemo<ModelPresetParams>(() => {
    if (!pending) return {};
    if (pending.source === "preset" && pending.preset) {
      return pickPresetParams(pending.preset);
    }
    return pickPresetParams(generic);
  }, [generic, pending]);

  const handleApply = useCallback(() => {
    if (!pending) return;
    const applied =
      pending.source === "preset" && pending.preset
        ? pickPresetParams(pending.preset)
        : pickPresetParams(generic);
    const { onApply, source, preset } = pending;
    setPending(null);
    onApply(applied, source, preset);
  }, [generic, pending]);

  const dialog = (
    <ModelPresetPromptDialog
      open={pending !== null}
      modelId={pending?.modelId ?? ""}
      source={pending?.source ?? "preset"}
      presetName={pending?.preset?.name}
      params={params}
      onApply={handleApply}
      onSkip={close}
    />
  );

  return {
    offerPresetForModel,
    offer: offerPresetForModel,
    dialog,
    isPending: pending !== null,
    isLoading,
  };
}
