import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { dshApi, type DshRelayStatus } from "@/lib/api/dsh";

export const dshKeys = {
  all: ["dsh"] as const,
  currentState: ["dsh", "currentState"] as const,
  relayStatus: ["dsh", "relayStatus"] as const,
};

export const invalidateDshProviderCaches = async (queryClient: QueryClient) => {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: dshKeys.currentState }),
    queryClient.invalidateQueries({
      queryKey: ["providers", "deepseek-harness"],
    }),
  ]);
};

export function useDshCurrentState(enabled = true) {
  return useQuery({
    queryKey: dshKeys.currentState,
    queryFn: () => dshApi.getCurrentState(),
    enabled,
  });
}

/**
 * DSH 中转状态。命令未就绪（后端还没实现）或读取失败时保持静默：
 * 不重试、不弹错，由设置页降级成「状态不可用」。
 * 5s 内不重复读：设置页来回切换分区时不必每次都问后端。
 */
export function useDshRelayStatus(enabled = true) {
  return useQuery({
    queryKey: dshKeys.relayStatus,
    queryFn: () => dshApi.getRelayStatus(),
    enabled,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 5_000,
  });
}

function applyRelayStatus(
  queryClient: QueryClient,
  status: DshRelayStatus,
): void {
  queryClient.setQueryData(dshKeys.relayStatus, status);
  // 两个开关同时写进 settings.json，让设置查询过期以免别处读到旧值
  void queryClient.invalidateQueries({ queryKey: ["settings"] });
  // 开/关中转会改写各 provider 的 baseURL，列表里的地址必须跟着刷新
  void invalidateDshProviderCaches(queryClient);
}

/**
 * 切换后仍有多少 provider 指着中转地址。
 *
 * 后端可能只换回了一部分（文件被 Harness 占着等），这时不能对外说「已还原为直连」，
 * 界面要照实显示还在走中转，并提示下次重试。
 */
export const relayedCount = (status: DshRelayStatus): number =>
  status.providers.filter((provider) => provider.relayed).length;

/** 开/关「使用 CC Switch 中转 DSH 请求」。 */
export function useSetDshRelay() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => dshApi.setRelay(enabled),
    onSuccess: (status) => applyRelayStatus(queryClient, status),
  });
}

/** 开/关「退出 CC Switch 时自动还原直连地址」。 */
export function useSetDshRestoreOnExit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => dshApi.setRestoreOnExit(enabled),
    onSuccess: (status) => applyRelayStatus(queryClient, status),
  });
}
