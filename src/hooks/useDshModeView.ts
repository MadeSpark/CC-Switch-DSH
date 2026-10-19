import { useEffect, useState } from "react";
import { useDshRelayStatus } from "@/lib/query/dsh";

export type DshModeView = "direct" | "route";

export interface DshModeViewState {
  /** 当前该看哪一面：默认跟着中转状态走 */
  view: DshModeView;
  /** 手动点了直連 / 路由：只在本会话生效，换应用回来还在 */
  setView: (view: DshModeView) => void;
}

/**
 * DSH 的「直連 / 路由」是页内视图，不是一整页。
 *
 * 它必须由中转是否接着推导：以前把它塞进 `currentView`，切去别的应用再切回来会被
 * selectApp / 应用页归属校验打回 `providers`，于是明明接着中转却显示「直連」。
 * 这里单独存一份临时选择，只在会话内有效；中转状态自己变了（接上 / 断开）就丢掉它，
 * 避免界面停在一个已经不成立的看法上。
 */
export function useDshModeView(): DshModeViewState {
  const { data } = useDshRelayStatus();
  const attached = data?.attached === true;
  const [override, setOverride] = useState<DshModeView | null>(null);

  useEffect(() => {
    setOverride(null);
  }, [attached]);

  return {
    view: override ?? (attached ? "route" : "direct"),
    setView: setOverride,
  };
}
