import { describe, expect, it } from "vitest";
import {
  appPageBelongsTo,
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
