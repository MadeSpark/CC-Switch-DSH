import { describe, expect, it } from "vitest";
import {
  SETTINGS_SECTIONS,
  appPageBelongsTo,
  normalizeSettingsSection,
  sharedFeatureAppOf,
  supportsMcp,
  supportsSkills,
} from "@/lib/navigation";

describe("DeepSeek Harness navigation capabilities", () => {
  it("keeps DSH on its own app page and shares no unsupported MCP/Skills entry", () => {
    expect(sharedFeatureAppOf("deepseek-harness")).toBe("deepseek-harness");
    expect(appPageBelongsTo("providers", "deepseek-harness")).toBe(true);
    expect(appPageBelongsTo("workspace", "deepseek-harness")).toBe(false);
    expect(supportsMcp("deepseek-harness")).toBe(false);
    expect(supportsSkills("deepseek-harness")).toBe(false);
  });

  it("keeps supported global capabilities for compatible applications", () => {
    expect(supportsMcp("claude")).toBe(true);
    expect(supportsSkills("claude")).toBe(true);
    expect(supportsMcp("pi")).toBe(false);
    expect(supportsSkills("openclaw")).toBe(false);
  });
});

describe("DSH relay lives on the DeepSeek Harness app page, not in settings", () => {
  it("only exposes the relay page on DeepSeek Harness", () => {
    expect(appPageBelongsTo("dshRelay", "deepseek-harness")).toBe(true);
    for (const app of ["claude", "codex", "openclaw", "hermes"] as const) {
      expect(appPageBelongsTo("dshRelay", app)).toBe(false);
    }
  });

  it("no longer lists a DSH relay entry in the settings directory", () => {
    expect(SETTINGS_SECTIONS.map((section) => String(section))).not.toContain(
      "dsh",
    );
  });

  it("falls back to the local routing section for the old stored tab", () => {
    expect(normalizeSettingsSection("dsh")).toBe("routing");
  });
});
