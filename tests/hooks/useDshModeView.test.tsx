import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDshModeView } from "@/hooks/useDshModeView";

// 中转是否接着：DSH 该看哪一面由它决定
const relay = vi.hoisted(() => ({ attached: false }));

vi.mock("@/lib/query/dsh", () => ({
  useDshRelayStatus: () => ({ data: { attached: relay.attached } }),
}));

beforeEach(() => {
  relay.attached = false;
});

describe("useDshModeView", () => {
  it("follows the relay state by default", () => {
    relay.attached = true;
    const route = renderHook(() => useDshModeView());
    expect(route.result.current.view).toBe("route");
    route.unmount();

    relay.attached = false;
    const direct = renderHook(() => useDshModeView());
    expect(direct.result.current.view).toBe("direct");
  });

  it("keeps the chosen view when the user leaves the DSH page and comes back", () => {
    relay.attached = true;
    const { result, rerender } = renderHook(() => useDshModeView());

    act(() => result.current.setView("direct"));
    expect(result.current.view).toBe("direct");

    // 切去别的应用再切回来：App 不会重挂，重渲染不能把选择打回默认
    rerender();
    rerender();
    expect(result.current.view).toBe("direct");

    act(() => result.current.setView("route"));
    rerender();
    expect(result.current.view).toBe("route");
  });

  it("drops the chosen view once the relay state itself changes", () => {
    const { result, rerender } = renderHook(() => useDshModeView());

    // 没接中转时先看「路由」：只是预览，不动配置
    act(() => result.current.setView("route"));
    expect(result.current.view).toBe("route");

    // 真正接上了：临时选择作废，跟着实际状态走
    relay.attached = true;
    rerender();
    expect(result.current.view).toBe("route");

    // 再断开：不会还停在「路由」
    relay.attached = false;
    rerender();
    expect(result.current.view).toBe("direct");
  });
});
