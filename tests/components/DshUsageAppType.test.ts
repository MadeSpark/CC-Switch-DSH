import { describe, expect, it } from "vitest";
import {
  CACHE_INCLUSIVE_APP_TYPES,
  KNOWN_APP_TYPES,
  type AppType,
} from "@/types/usage";
import { APP_TYPE_BRAND, appTypeDisplayName } from "@/components/usage/appBrand";

/**
 * 用量面板的「应用」筛选按日志里的 `app_type` 取值。DeepSeek Harness 没有代理
 * 路由，用量来自会话日志导入，记作 `dsh`，而应用注册表的 id 是
 * `deepseek-harness` —— 差这一个名字，漏了就会在筛选栏渲染出空白图标。
 */
describe("usage app-type brand mapping", () => {
  it("offers DeepSeek Harness as a dashboard filter", () => {
    expect(KNOWN_APP_TYPES).toContain("dsh");
    expect(appTypeDisplayName("dsh")).toBe("DeepSeek Harness");
  });

  it("resolves every known app type to a real brand", () => {
    for (const appType of KNOWN_APP_TYPES) {
      expect(APP_TYPE_BRAND[appType]).toBeTruthy();
      expect(appTypeDisplayName(appType)).toMatch(/\S/);
    }
  });

  it("keeps DSH input tokens in fresh (not cache-inclusive) semantics", () => {
    // DSH 会话日志里 inputTokens 是「新增输入」，缓存命中单独记 cacheReadTokens，
    // 所以绝不能进 OpenAI 那套「输入已含缓存」的名单。
    expect(CACHE_INCLUSIVE_APP_TYPES.has("dsh" satisfies AppType)).toBe(false);
  });
});
