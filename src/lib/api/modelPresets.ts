import { invoke } from "@tauri-apps/api/core";
import type { ModelPresetSettings } from "@/lib/modelPresets";

export type {
  ModelPreset,
  ModelPresetParams,
  ModelPresetSettings,
} from "@/lib/modelPresets";

/**
 * 模型预设的后端接口（Rust 的 `get_model_presets` / `save_model_presets`）。
 * 保存是整份覆盖：预设列表 + 通用参数一起传。
 */
export const modelPresetsApi = {
  get(): Promise<ModelPresetSettings> {
    return invoke<ModelPresetSettings>("get_model_presets");
  },

  save(payload: ModelPresetSettings): Promise<ModelPresetSettings> {
    return invoke<ModelPresetSettings>("save_model_presets", { payload });
  },
};
