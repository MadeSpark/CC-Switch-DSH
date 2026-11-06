import { invoke } from "@tauri-apps/api/core";

/**
 * 选择性配置导出 / 导入 —— 与 .tmp-local/selective-config/spec.md 的接口约定一一对应。
 * 所有结构后端 serde rename_all = "camelCase"，JS 侧直接使用 camelCase 字段。
 */

/** 目录里的一条可选项 */
export interface CatalogItem {
  id: string;
  name: string;
  /** 供应商 = Base URL / 主要端点；预设 = modelId；定价 = null */
  detail?: string | null;
  /** 仅导入预览时有值：本机已有同 key 的项 */
  exists?: boolean | null;
}

/** 按内置应用分组的供应商目录 */
export interface CatalogAppGroup {
  appType: string;
  items: CatalogItem[];
}

/** 自定义应用（整体选择，不细到单个供应商） */
export interface CatalogCustomApp {
  id: string;
  name: string;
  icon?: string | null;
  iconColor?: string | null;
  providers: CatalogItem[];
  exists?: boolean | null;
}

/** 选择性导出 / 导入共用的目录 */
export interface SelectiveCatalog {
  providers: CatalogAppGroup[];
  customApps: CatalogCustomApp[];
  /** id = modelId, name = displayName */
  modelPricing: CatalogItem[];
  modelPresets: CatalogItem[];
  /** 导出目录：总为 true；导入预览：文件里 genericPreset 非 null */
  hasGenericPreset: boolean;
}

/** 用户勾选结果 */
export interface SelectiveSelection {
  /** appType -> provider ids */
  providers: Record<string, string[]>;
  /** custom app ids（整体） */
  customApps: string[];
  modelPricing: string[];
  modelPresets: string[];
  genericPreset: boolean;
}

export type SelectiveImportMode = "overwrite" | "append";

export interface SelectiveImportPreview {
  catalog: SelectiveCatalog;
  appVersion?: string | null;
  exportedAt?: string | null;
}

/** section 取值："providers:<appType>" | "customApp:<appId>" | "modelPricing" | "modelPresets" | "genericPreset" */
export interface SectionResult {
  section: string;
  added: number;
  overwritten: number;
  skipped: number;
  renamed: number;
}

export interface SelectiveImportSummary {
  sections: SectionResult[];
  backupId?: string | null;
  warning?: string | null;
}

export interface SelectiveExportResult {
  filePath: string;
  total: number;
}

/** 读取导出目录：本机有哪些可导出的项 */
export function getSelectiveExportCatalog(): Promise<SelectiveCatalog> {
  return invoke("get_selective_export_catalog");
}

/** 弹出保存对话框，返回所选路径；取消返回 null */
export function saveJsonFileDialog(
  defaultName: string,
): Promise<string | null> {
  return invoke("save_json_file_dialog", { defaultName });
}

/** 弹出打开对话框，返回所选路径；取消返回 null */
export function openJsonFileDialog(): Promise<string | null> {
  return invoke("open_json_file_dialog");
}

/** 导出选中的配置到 filePath */
export function exportSelectiveConfig(
  filePath: string,
  selection: SelectiveSelection,
): Promise<SelectiveExportResult> {
  return invoke("export_selective_config", { filePath, selection });
}

/** 只读解析导入文件，得到预览目录（不改任何数据） */
export function readSelectiveImportFile(
  filePath: string,
): Promise<SelectiveImportPreview> {
  return invoke("read_selective_import_file", { filePath });
}

/** 按选区和模式导入配置 */
export function importSelectiveConfig(
  filePath: string,
  selection: SelectiveSelection,
  mode: SelectiveImportMode,
): Promise<SelectiveImportSummary> {
  return invoke("import_selective_config", { filePath, selection, mode });
}

export const selectiveConfigApi = {
  getSelectiveExportCatalog,
  saveJsonFileDialog,
  openJsonFileDialog,
  exportSelectiveConfig,
  readSelectiveImportFile,
  importSelectiveConfig,
};
