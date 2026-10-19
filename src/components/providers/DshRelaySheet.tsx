import { useTranslation } from "react-i18next";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  SettingsBlock,
  SettingsCard,
  SettingsRow,
  SettingsSwitchRow,
} from "@/components/settings/SettingsLayout";
import { useDshRelayStatus, useSetDshRestoreOnExit } from "@/lib/query/dsh";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { extractErrorMessage } from "@/utils/errorUtils";

interface DshRelaySheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** 路由页签的设置抽屉：退出还原和当前中转状态。 */
export function DshRelaySheet({ open, onOpenChange }: DshRelaySheetProps) {
  const { t } = useTranslation();
  const { data: status, isLoading, isFetching, refetch } = useDshRelayStatus();
  const setRestoreOnExit = useSetDshRestoreOnExit();
  const statusReady = Boolean(status);
  const providers = status?.providers ?? [];

  const handleRestoreChange = async (enabled: boolean) => {
    try {
      await setRestoreOnExit.mutateAsync(enabled);
      toast.success(
        enabled ? t("dshRelay.restoreEnabled") : t("dshRelay.restoreDisabled"),
      );
    } catch (error) {
      console.error(
        "[DshRelaySheet] Failed to toggle DSH restore-on-exit",
        error,
      );
      toast.error(
        t("dshRelay.restoreFailed", { detail: extractErrorMessage(error) }),
      );
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent width={420} closeLabel={t("common.close")}>
        <SheetHeader>
          <SheetTitle>{t("dshRelay.settingsTitle")}</SheetTitle>
          <SheetDescription>{t("dshRelay.relayDescription")}</SheetDescription>
        </SheetHeader>
        <SheetBody className="space-y-7">
          <SettingsBlock>
            <SettingsCard>
              <SettingsSwitchRow
                label={t("dshRelay.restoreLabel")}
                help={{
                  title: t("dshRelay.restoreLabel"),
                  body: t("dshRelay.restoreDescription"),
                }}
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
                      status.attached === true ? (
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
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
