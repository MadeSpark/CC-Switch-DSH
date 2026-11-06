import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAppNameResolver } from "@/components/usage/useAppNameResolver";
import type { CustomApp } from "@/lib/api/customApps";

const useCustomAppsQueryMock = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { resolvedLanguage: "en", language: "en" },
  }),
}));

vi.mock("@/lib/query/customApps", () => ({
  useCustomAppsQuery: () => useCustomAppsQueryMock(),
}));

const app = (overrides: Partial<CustomApp> = {}): CustomApp => ({
  id: "custom-8fa21cfe-1111-2222-3333-444455556666",
  name: "爱丽",
  icon: "claude",
  iconColor: null,
  apiKey: "sk-test",
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_000,
  ...overrides,
});

describe("useAppNameResolver", () => {
  it("maps a custom app id to its name", async () => {
    const customApp = app();
    useCustomAppsQueryMock.mockReturnValue({ data: [customApp] });

    const { result } = renderHook(() => useAppNameResolver());

    await waitFor(() => {
      expect(result.current.displayName(customApp.id)).toBe("爱丽");
    });
    expect(result.current.shortName(customApp.id)).toBe("爱丽");
    expect(result.current.customApp(customApp.id)).toBe(customApp);
  });

  it("falls back to the raw id when the custom app is unknown or list not loaded", () => {
    useCustomAppsQueryMock.mockReturnValue({ data: undefined });

    const { result } = renderHook(() => useAppNameResolver());
    const unknownId = "custom-does-not-exist";

    expect(result.current.displayName(unknownId)).toBe(unknownId);
    expect(result.current.shortName(unknownId)).toBe(unknownId);
    expect(result.current.customApp(unknownId)).toBeUndefined();
  });

  it("leaves built-in app types unchanged", async () => {
    useCustomAppsQueryMock.mockReturnValue({ data: [app()] });

    const { result } = renderHook(() => useAppNameResolver());

    await waitFor(() => {
      expect(result.current.displayName("claude")).toBe("Claude Code");
    });
    expect(result.current.shortName("claude")).toBe("Claude");
    expect(result.current.displayName("dsh")).toBe("DeepSeek Harness");
    expect(result.current.customApp("claude")).toBeUndefined();
  });
});
