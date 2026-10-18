import { useTranslation } from "react-i18next";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  SettingsBlock,
  SettingsCard,
  SettingsRow,
  SettingsSwitchRow,
} from "@/components/settings/SettingsLayout";
import {
  useDshRelayStatus,
  useSetDshRelay,
  useSetDshRestoreOnExit,
} from "@/lib/query/dsh";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

/**
 * 设置 → DeepSeek Harness：是否让 DSH 的请求走 CC Switch 的本机中转，
 * 以及退出 CC Switch 时是否自动把 DSH 的 API 地址还原成直连。
 */
export function DshSection() {
  const { t } = useTranslation();
  const { data: status, isLoading, isFetching, refetch } = useDshRelayStatus();
  const setRelay = useSetDshRelay();
  const setRestoreOnExit = useSetDshRestoreOnExit();

  // 后端状态没读到（命令未就绪 / 读取失败）时，两个开关先不给碰：
  // 盲切可能把地址写坏，也不知道当前到底是开还是关。
  const statusReady = Boolean(status);
  const providers = status?.providers ?? [];

  const handleRelayChange = async (enabled: boolean) => {
    try {
      await setRelay.mutateAsync(enabled);
      toast.success(
        enabled ? t("dshRelay.relayEnabled") : t("dshRelay.relayDisabled"),
      );
    } catch (error) {
      console.error("[DshSection] Failed to toggle DSH relay", error);
      toast.error(t("dshRelay.relayFailed", { detail: describeError(error) }));
    }
  };

  const handleRestoreChange = async (enabled: boolean) => {
    try {
      await setRestoreOnExit.mutateAsync(enabled);
      toast.success(
        enabled ? t("dshRelay.restoreEnabled") : t("dshRelay.restoreDisabled"),
      );
    } catch (error) {
      console.error("[DshSection] Failed to toggle DSH restore-on-exit", error);
      toast.error(
        t("dshRelay.restoreFailed", { detail: describeError(error) }),
      );
    }
  };

  return (
    <>
      <SettingsBlock>
        {/* 应用显示名：页标题是「DSH 中转」，这行点明配置的是哪个应用。
            说明文字复用 relayLabel，不为这一行新增 i18n 键。 */}
        <p className="text-caption text-fg-3">
          <span className="font-medium text-fg-1">{t("dshRelay.title")}</span>
          <span className="px-1.5">·</span>
          {t("dshRelay.relayLabel")}
        </p>
        <SettingsCard>
          <SettingsSwitchRow
            label={t("dshRelay.relayLabel")}
            help={{
              title: t("dshRelay.relayLabel"),
              body: t("dshRelay.relayDescription"),
            }}
            checked={status?.relayEnabled ?? false}
            disabled={!statusReady || setRelay.isPending}
            onCheckedChange={(enabled) => void handleRelayChange(enabled)}
          />
          <SettingsSwitchRow
            label={t("dshRelay.restoreLabel")}
            help={{
              title: t("dshRelay.restoreLabel"),
              body: t("dshRelay.restoreDescription"),
            }}
            // 开着的时候把「来不及还原会自愈」写出来，省得用户担心崩溃场景
            description={
              status?.restoreOnExit ? t("dshRelay.restoreHint") : undefined
            }
            checked={status?.restoreOnExit ?? false}
            disabled={!statusReady || setRestoreOnExit.isPending}
            onCheckedChange={(enabled) => void handleRestoreChange(enabled)}
          />
        </SettingsCard>
      </SettingsBlock>

      <SettingsBlock
        title={t("dshRelay.statusTitle")}
        actions={
          <Button
            variant="quiet"
            size="compact"
            disabled={isFetching}
            onClick={() => void refetch()}
          >
            {isFetching ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {t("dshRelay.refresh")}
          </Button>
        }
      >
        <SettingsCard>
          {isLoading ? (
            <SettingsRow
              label={
                <span className="inline-flex items-center gap-2 text-fg-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t("dshRelay.loading")}
                </span>
              }
            />
          ) : !status ? (
            <SettingsRow
              label={t("dshRelay.statusUnavailable")}
              description={t("dshRelay.statusUnavailableHint")}
            />
          ) : (
            <>
              <SettingsRow
                label={t("dshRelay.attachedLabel")}
                control={
                  <span
                    className={cn(
                      "text-caption font-medium",
                      status.attached ? "text-success-text" : "text-fg-3",
                    )}
                  >
                    {status.attached
                      ? t("dshRelay.attached")
                      : t("dshRelay.notAttached")}
                  </span>
                }
              />
              <SettingsRow
                label={t("dshRelay.baseUrlLabel")}
                control={
                  <code
                    className="max-w-[320px] truncate font-mono text-caption text-fg-2"
                    title={status.baseUrl ?? undefined}
                  >
                    {status.baseUrl ??
                      (status.attached
                        ? t("dshRelay.baseUrlUnknown")
                        : t("dshRelay.baseUrlNotRelayed"))}
                  </code>
                }
              />
              <div className="px-4 py-3">
                <div className="text-body font-medium text-fg-1">
                  {t("dshRelay.providersTitle")}
                </div>
                {providers.length === 0 ? (
                  // 已接管却一条 provider 都没写进去 = 故障，别用中性文案盖住；
                  // attached 只认严格的 true，加载中/undefined 不算故障态。
                  status?.attached === true ? (
                    <div className="mt-0.5 text-caption text-warning-text">
                      {t("dshRelay.noProvidersAttached")}
                    </div>
                  ) : (
                    <div className="mt-0.5 text-caption text-fg-2">
                      {t("dshRelay.noProviders")}
                    </div>
                  )
                ) : (
                  <ul className="mt-1.5 space-y-1">
                    {providers.map((provider) => {
                      const original = provider.originalBaseUrl ?? "—";
                      // 直连时只显示原始地址：不要再画一个「→ —」的箭头，
                      // 那看着像中转失败，实际只是没接管。
                      const line = provider.relayBaseUrl
                        ? `${provider.name}: ${original} → ${provider.relayBaseUrl}`
                        : `${provider.name}: ${original}`;
                      return (
                        <li
                          key={provider.providerId}
                          className="flex min-w-0 items-baseline gap-2"
                        >
                          <span
                            className="min-w-0 flex-1 truncate font-mono text-caption text-fg-2"
                            title={line}
                          >
                            <span className="font-sans font-medium text-fg-1">
                              {provider.name}
                            </span>
                            : {original}
                            {provider.relayBaseUrl
                              ? ` → ${provider.relayBaseUrl}`
                              : null}
                          </span>
                          <span
                            className={cn(
                              "shrink-0 text-caption",
                              provider.relayed
                                ? "text-success-text"
                                : "text-fg-3",
                            )}
                          >
                            {provider.relayed
                              ? t("dshRelay.relayed")
                              : t("dshRelay.direct")}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
              <p className="px-4 py-3 text-caption text-fg-3">
                {t("dshRelay.relayHelp")}
              </p>
            </>
          )}
        </SettingsCard>
      </SettingsBlock>
    </>
  );
}
