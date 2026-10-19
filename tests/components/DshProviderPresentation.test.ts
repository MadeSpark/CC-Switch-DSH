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

  /** 路由视图用例的公共壳：只有「已添加」那组的卡片才带 status / tone。 */
  function addedItems(input: {
    providers: Provider[];
    current?: { providerId: string | null; model: string | null } | null;
    relay?: { providerIds: string[] };
  }) {
    const sections = buildAdditiveSections({
      app: "deepseek-harness",
      t: translate,
      providers: input.providers,
      isInConfig: () => true,
      dshCurrent: input.current ?? null,
      dshRelay: input.relay,
      actions: {
        add: vi.fn(),
        remove: vi.fn(),
        disableOmo: vi.fn(),
        setDefault: vi.fn(),
      },
    });
    return sections.find((section) => section.key === "added")!.items;
  }

  it("marks a relayed current provider as routing and keeps its model chip", () => {
    const spacetime = provider("spacetimeai", "Spacetime");
    const items = addedItems({
      providers: [spacetime],
      current: { providerId: spacetime.id, model: "gpt-5" },
      relay: { providerIds: [spacetime.id] },
    });

    const card = items[0].presentation;
    expect(card.status?.label).toBe("providerCard.status.routing");
    expect(card.status?.dot).toBe("route");
    expect(card.tone).toBe("route");
    expect(card.chips.map((chip) => chip.key)).toContain("dshCurrentModel");
    expect(actionKeys(items[0])).toEqual(["remove"]);
    expect(items[0].presentation.buttons[0].disabledReason).toBe(
      "providerCard.reason.currentCannotRemove",
    );
  });

  it("marks a relayed non-current provider as routing without the model chip", () => {
    const current = provider("current", "Current");
    const relayed = provider("relayed", "Relayed");
    const items = addedItems({
      providers: [current, relayed],
      current: { providerId: current.id, model: "current-fast" },
      relay: { providerIds: [relayed.id] },
    });

    const relayedCard = items.find(
      (item) => item.provider.id === relayed.id,
    )!.presentation;
    expect(relayedCard.status?.label).toBe("providerCard.status.routing");
    expect(relayedCard.status?.dot).toBe("route");
    expect(relayedCard.tone).toBe("route");
    expect(relayedCard.chips.map((chip) => chip.key)).not.toContain(
      "dshCurrentModel",
    );

    // 当前但没被接管的那家仍然是「目前」+ 灰卡
    const currentCard = items.find(
      (item) => item.provider.id === current.id,
    )!.presentation;
    expect(currentCard.status?.label).toBe("providerCard.status.current");
    expect(currentCard.tone).toBe("neutral");
  });

  it("keeps the plain current status when nothing is relayed", () => {
    const current = provider("current", "Current");
    const other = provider("other", "Other");
    const items = addedItems({
      providers: [current, other],
      current: { providerId: current.id, model: "current-fast" },
      relay: { providerIds: [] },
    });

    const currentCard = items.find(
      (item) => item.provider.id === current.id,
    )!.presentation;
    expect(currentCard.status?.label).toBe("providerCard.status.current");
    expect(currentCard.status?.dot).toBe("muted");
    expect(currentCard.tone).toBe("neutral");

    const otherCard = items.find(
      (item) => item.provider.id === other.id,
    )!.presentation;
    expect(otherCard.status).toBeUndefined();
    expect(otherCard.tone).toBeUndefined();
  });

  it("matches the old output when dshRelay is not passed", () => {
    const current = provider("current", "Current");
    const other = provider("other", "Other");
    const items = addedItems({
      providers: [current, other],
      current: { providerId: current.id, model: "current-fast" },
    });

    expect(
      items.map((item) => ({
        status: item.presentation.status,
        tone: item.presentation.tone,
        chips: item.presentation.chips.map((chip) => chip.key),
        buttons: actionKeys(item),
      })),
    ).toEqual([
      {
        status: { label: "providerCard.status.current", dot: "muted" },
        tone: "neutral",
        chips: ["dshCurrentModel"],
        buttons: ["remove"],
      },
      {
        status: undefined,
        tone: undefined,
        chips: [],
        buttons: ["remove"],
      },
    ]);
  });
});
