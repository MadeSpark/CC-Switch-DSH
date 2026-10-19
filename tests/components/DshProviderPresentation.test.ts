import { describe, expect, it, vi } from "vitest";
import type { Provider } from "@/types";
import { buildAdditiveSections } from "@/components/providers/presentation";

const provider = (id: string, name = id): Provider => ({
  id,
  name,
  settingsConfig: {},
  category: "custom",
  createdAt: 1,
});

const translate = ((key: string, options?: { count?: number }) =>
  options?.count == null ? key : `${key}:${options.count}`) as never;

/** DSH 卡片上不该再出现「設為預設」这类动作（additive 应用只有加入 / 移除）。 */
function actionKeys(item: { presentation: { buttons: { key: string }[] } }) {
  return item.presentation.buttons.map((button) => button.key);
}

describe("DeepSeek Harness provider presentation", () => {
  it("renders live membership with add and remove actions only", () => {
    const add = vi.fn();
    const remove = vi.fn();
    const setDefault = vi.fn();
    const current = provider("current", "Current");
    const addedOther = provider("added-other", "Added Other");
    const available = provider("available", "Available");
    const sections = buildAdditiveSections({
      app: "deepseek-harness",
      t: translate,
      providers: [current, addedOther, available],
      isInConfig: (item) => item.id !== available.id,
      dshCurrent: { providerId: current.id, model: "current-fast" },
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
    expect(added.items).toHaveLength(2);
    expect(availableSection.items).toHaveLength(1);

    // 当前生效的那家：只读展示「目前」+ 当前模型 chip，且不能移除。
    const currentItem = added.items[0];
    expect(currentItem.provider.id).toBe(current.id);
    expect(currentItem.presentation.status?.label).toBe(
      "providerCard.status.current",
    );
    expect(currentItem.presentation.chips.map((chip) => chip.key)).toContain(
      "dshCurrentModel",
    );
    expect(actionKeys(currentItem)).toEqual(["remove"]);
    expect(currentItem.presentation.buttons[0].disabledReason).toBe(
      "providerCard.reason.currentCannotRemove",
    );

    // 已加入但不是当前的那家：同样只有「移除」，没有「設為預設」。
    const otherItem = added.items[1];
    expect(otherItem.provider.id).toBe(addedOther.id);
    expect(otherItem.presentation.status).toBeUndefined();
    expect(actionKeys(otherItem)).toEqual(["remove"]);
    expect(actionKeys(otherItem)).not.toContain("setDshDefault");
    expect(
      actionKeys(otherItem).some((key) => key.startsWith("setDshDefault")),
    ).toBe(false);

    // 未加入的那家：只有「加入」。
    const availableItem = availableSection.items[0];
    expect(actionKeys(availableItem)[0]).toBe("add");
    expect(actionKeys(availableItem)).not.toContain("setDshDefault");
    expect(setDefault).not.toHaveBeenCalled();

    availableItem.presentation.buttons[0].onClick();
    expect(add).toHaveBeenCalledWith(available);
  });
});
