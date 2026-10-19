import { useMemo } from "react";
import {
  formatTokensCompact,
  formatTokensShort,
  resolveTokenUnit,
} from "@/components/usage/format";
import { useSettingsQuery } from "@/lib/query";

/**
 * 用量 Token 数量的统一出口：用量面板、侧栏「今日」、会话阅读页都经这里。
 * 单位制（K/M/B ↔ 千/万/亿）跟着设置走；没设置或存了认不出的值时按国际缩写，
 * 独立渲染的组件测试因此还是老样子。
 */
export function useTokenFormat() {
  const { data: settings } = useSettingsQuery();
  const tokenUnit = resolveTokenUnit(settings?.usageDisplay);

  return useMemo(
    () => ({
      tokenUnit,
      /** 表格和指标卡：最多 3 位有效数字，精确值自己放进 title */
      tokens: (value: unknown, locale?: string) =>
        formatTokensCompact(value, locale, tokenUnit),
      /** 图表轴、悬停卡：不补零，0 和非法值写「0」 */
      tokensShort: (value: number, lang: string) =>
        formatTokensShort(value, lang, tokenUnit),
    }),
    [tokenUnit],
  );
}
