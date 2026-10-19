import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useTokenFormat } from "@/hooks/useTokenFormat";
import type { Settings } from "@/types";
import { createTestQueryClient } from "../utils/testQueryClient";

const renderWithSettings = (settings: Partial<Settings>) => {
  const client = createTestQueryClient();
  client.setQueryData(["settings"], settings);
  return renderHook(() => useTokenFormat(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  }).result.current;
};

describe("useTokenFormat", () => {
  it("falls back to international abbreviations when nothing is saved", () => {
    const fmt = renderWithSettings({});
    expect(fmt.tokenUnit).toBe("intl");
    expect(fmt.tokens(1_610_000_000, "zh-CN")).toBe("1.61B");
    expect(fmt.tokensShort(48_210, "zh-CN")).toBe("48.2K");
  });

  it("follows the saved Chinese unit", () => {
    const fmt = renderWithSettings({ usageDisplay: { tokenUnit: "zh" } });
    expect(fmt.tokenUnit).toBe("zh");
    expect(fmt.tokens(1_610_000_000, "zh-CN")).toBe("16.1亿");
    expect(fmt.tokensShort(48_210, "zh-CN")).toBe("4.82万");
    // 繁体界面写繁体单位
    expect(fmt.tokens(12_345, "zh-TW")).toBe("1.23萬");
    // 选的是单位系统：英文界面也照用中文单位
    expect(fmt.tokens(48_210, "en-US")).toBe("4.82万");
  });

  it("keeps the international unit when the setting says so", () => {
    const fmt = renderWithSettings({ usageDisplay: { tokenUnit: "intl" } });
    expect(fmt.tokenUnit).toBe("intl");
    expect(fmt.tokens(1_610_000_000, "zh-CN")).toBe("1.61B");
  });
});
