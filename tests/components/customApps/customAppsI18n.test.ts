import { describe, expect, it } from "vitest";
import zh from "@/i18n/locales/zh.json";
import zhTW from "@/i18n/locales/zh-TW.json";
import en from "@/i18n/locales/en.json";
import ja from "@/i18n/locales/ja.json";
import tr from "@/i18n/locales/tr.json";

const locales = { zh, "zh-TW": zhTW, en, ja, tr } as unknown as Record<
  string,
  typeof zh
>;

/** customApps 命名空间要求全语言键结构一致（键集合相同）。 */
function collectKeys(obj: unknown, prefix = ""): string[] {
  if (typeof obj !== "object" || obj === null) return [prefix];
  return Object.entries(obj).flatMap(([key, value]) =>
    collectKeys(value, prefix ? `${prefix}.${key}` : key),
  );
}

describe("customApps i18n 键完整性", () => {
  it("五个语言都有 nav.customApps 和 customApps 命名空间", () => {
    for (const [name, data] of Object.entries(locales)) {
      expect(data.nav, name).toHaveProperty("customApps");
      expect(data.customApps, name).toBeDefined();
    }
  });

  it("五个语言的 customApps 键结构与 zh 完全一致", () => {
    const zhKeys = collectKeys(zh.customApps).sort();
    for (const [name, data] of Object.entries(locales)) {
      expect(collectKeys(data.customApps).sort(), name).toEqual(zhKeys);
    }
  });

  it("导航入口键在五语言里都是非空字符串", () => {
    for (const [name, data] of Object.entries(locales)) {
      expect(typeof data.nav.customApps, name).toBe("string");
      expect((data.nav.customApps as string).length, name).toBeGreaterThan(0);
    }
  });
});

describe("customApps 导航注册", () => {
  it("customApps 是合法的 GlobalPage", async () => {
    const nav = await import("@/lib/navigation");
    // GLOBAL_PAGES 未导出；isGlobalPage / parseView 以它为准
    expect(nav.isGlobalPage("customApps")).toBe(true);
    expect(nav.parseView("customApps")).toBe("customApps");
  });
});
