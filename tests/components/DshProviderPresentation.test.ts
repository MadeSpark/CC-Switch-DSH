import { describe, expect, it, vi } from "vitest";
import type { Provider } from "@/types";
import { buildAdditiveSections } from "@/components/providers/presentation";

const provider = (id: string, name = id): Provider => ({
  id,
  name,
  settingsConfig: {
    models: [
      { id: `${id}-fast`, name: "Fast" },
      { id: `${id}-reasoning`, name: "Reasoning" },
    ],
  },
  category: "custom",
  createdAt: 1,
});

const translate = ((key: string, options?: { count?: number }) =>
  options?.count == null ? key : `${key}:${options.count}`) as never;

describe("DeepSeek Harness provider presentation", () => {
  it("renders live membership with add and remove actions", () => {
    const add = vi.fn();
    const remove = vi.fn();
    const setDefault = vi.fn();
    const current = provider("current", "Current");
    const available = provider("available", "Available");
    const sections = buildAdditiveSections({
      app: "deepseek-harness",
      t: translate,
      providers: [current, available],
      isInConfig: (item) => item.id === current.id,
      dshCurrent: { providerId: current.id, model: "current-fast" },
      dshModels: (item) =>
        (item.settingsConfig.models as { id: string; name: string }[]).map(
          (model) => ({ id: model.id, name: model.name }),
        ),
      actions: {
        add,
        remove,
        disableOmo: vi.fn(),
        setDefault,
      },
    });

    const added = sections.find((section) => section.key === "added")!;
    const availableSection = sections.find(
      (section) => section.key === "available",
    )!;
    expect(added.items).toHaveLength(1);
    expect(availableSection.items).toHaveLength(1);
    expect(added.items[0].presentation.status?.label).toBe(
      "providerCard.status.current",
    );
    expect(added.items[0].presentation.buttons[0].key).toBe("remove");
    expect(added.items[0].presentation.buttons[0].disabledReason).toBe(
      "providerCard.reason.currentCannotRemove",
    );

    availableSection.items[0].presentation.buttons[0].onClick();
    expect(add).toHaveBeenCalledWith(available);
  });

  it("offers DSH default model selection for a live non-current provider", () => {
    const setDefault = vi.fn();
    const current = provider("current");
    const other = provider("other");
    const sections = buildAdditiveSections({
      app: "deepseek-harness",
      t: translate,
      providers: [current, other],
      isInConfig: () => true,
      dshCurrent: { providerId: current.id, model: "current-fast" },
      dshModels: (item) =>
        (item.settingsConfig.models as { id: string; name: string }[]).map(
          (model) => ({ id: model.id, name: model.name }),
        ),
      actions: {
        add: vi.fn(),
        remove: vi.fn(),
        disableOmo: vi.fn(),
        setDefault,
      },
    });

    const otherItem = sections.find((section) => section.key === "added")!
      .items[1];
    const defaultButton = otherItem.presentation.buttons.find(
      (button) => button.key === "setDshDefault",
    )!;
    expect(defaultButton.menu?.options).toHaveLength(2);
    defaultButton.onClick();
    expect(setDefault).toHaveBeenCalledWith(other, "other-fast");
    defaultButton.menu!.options[1].onSelect();
    expect(setDefault).toHaveBeenLastCalledWith(other, "other-reasoning");
  });
});
