import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModelPricingSection } from "@/components/settings/sections/ModelPricingSection";
import { SETTINGS_SECTIONS, normalizeSettingsSection } from "@/lib/navigation";

vi.mock("@/components/usage/PricingConfigPanel", () => ({
  PricingConfigPanel: () => <div data-testid="pricing-config-panel" />,
}));

describe("model pricing settings entry", () => {
  it("is part of the settings directory and survives stored-view normalization", () => {
    expect(SETTINGS_SECTIONS).toContain("modelPricing");
    expect(normalizeSettingsSection("modelPricing")).toBe("modelPricing");
  });

  it("reuses the existing pricing editor", () => {
    render(<ModelPricingSection />);

    expect(screen.getByTestId("pricing-config-panel")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        level: 2,
        name: "settings.modelPricing.title",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "settings.modelPricing.title" }),
    ).toBeInTheDocument();
  });
});
