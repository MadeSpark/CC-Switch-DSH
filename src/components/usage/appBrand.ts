import { APP_DISPLAY_NAME } from "@/components/shell/AppGlyph";
import type { AppId } from "@/lib/api";
import type { AppType } from "@/types/usage";

/**
 * 用量日志里的 `app_type` 是后端口径，和「应用注册表」的 `AppId` 只差 DeepSeek
 * Harness 一个：它没有代理路由，用量全靠会话日志导入，记作 `dsh`。
 *
 * 用穷举 `Record` 兜住以后新增的应用类型 —— 漏映射会直接编译失败，而不是在界面上
 * 渲染出一个空白的图标或 `undefined`。
 */
export const APP_TYPE_BRAND: Record<AppType, AppId> = {
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
  grokbuild: "grokbuild",
  opencode: "opencode",
  pi: "pi",
  mcode: "mcode",
  dsh: "deepseek-harness",
};

/** 用量页里某个应用类型的品牌名（筛选 chip 的悬停提示、数据源说明共用）。 */
export function appTypeDisplayName(appType: AppType): string {
  return APP_DISPLAY_NAME[APP_TYPE_BRAND[appType]];
}
