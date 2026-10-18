import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { modelPresetsApi } from "@/lib/api/modelPresets";
import {
  EMPTY_MODEL_PRESET_SETTINGS,
  type ModelPreset,
  type ModelPresetParams,
  type ModelPresetSettings,
} from "@/lib/modelPresets";

/** 模型预设的查询 key：设置页和添加模型时的询问弹窗共用同一份缓存。 */
export const modelPresetQueryKey = ["model-presets"] as const;

export interface UseModelPresetsResult {
  /** 后端返回的整体设置（未加载完成时是空预设 + 空通用参数）。 */
  data: ModelPresetSettings;
  presets: ModelPreset[];
  generic: ModelPresetParams;
  isLoading: boolean;
  isError: boolean;
  isSaving: boolean;
  /** 整份保存（预设列表 + 通用参数），成功后缓存里直接换上后端返回值。 */
  save: (payload: ModelPresetSettings) => Promise<ModelPresetSettings>;
  refetch: () => void;
}

/**
 * 读 / 写模型预设。设置页编辑预设、通用参数、以及表单里的「是否套用」都由它取数据，
 * 保证只发一次 `get_model_presets`。
 */
export function useModelPresets(): UseModelPresetsResult {
  const queryClient = useQueryClient();

  const query = useQuery<ModelPresetSettings>({
    queryKey: modelPresetQueryKey,
    queryFn: () => modelPresetsApi.get(),
  });

  const mutation = useMutation<
    ModelPresetSettings,
    unknown,
    ModelPresetSettings
  >({
    mutationFn: (payload) => modelPresetsApi.save(payload),
    onSuccess: (saved, payload) => {
      // 后端个别版本可能不回内容；兜底用刚提交的 payload，避免缓存变 undefined
      queryClient.setQueryData<ModelPresetSettings>(
        modelPresetQueryKey,
        saved ?? payload,
      );
    },
  });

  const data = query.data ?? EMPTY_MODEL_PRESET_SETTINGS;

  return {
    data,
    presets: data.presets ?? [],
    generic: data.generic ?? {},
    isLoading: query.isLoading,
    isError: query.isError,
    isSaving: mutation.isPending,
    save: mutation.mutateAsync,
    refetch: () => {
      void query.refetch();
    },
  };
}
