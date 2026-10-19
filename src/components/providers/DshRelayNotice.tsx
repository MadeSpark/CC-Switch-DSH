import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { APP_DISPLAY_NAME } from "@/components/shell/AppGlyph";
import {
  relayedCount,
  useDshRelayStatus,
  useSetDshRelay,
} from "@/lib/query/dsh";
import { toast } from "@/lib/toast";
import { extractErrorMessage } from "@/utils/errorUtils";

/** 浏览未生效的连接模式时，让用户明确启用所查看的模式。 */
export function DshRelayNotice({ view }: { view: "direct" | "route" }) {
  const { t } = useTranslation();
  const { data: relay } = useDshRelayStatus();
  const setRelay = useSetDshRelay();
  const active = relay?.attached ? "route" : "direct";
  if (!relay || view === active) return null;
  const enabling = view === "route";

  const handle = async (enabled: boolean) => {
    try {
      const status = await setRelay.mutateAsync(enabled);
      const left = relayedCount(status);
      if (!enabled && (left > 0 || status.attached)) {
        // 只换回了一部分（Harness 正占着配置文件等）：别谎报「已还原为直连」。
        toast.warning(t("dshRelay.restoreIncomplete", { count: left }), {
          duration: 6000,
        });
        return;
      }
      toast.success(
        enabled ? t("dshRelay.relayEnabled") : t("dshRelay.relayDisabled"),
      );
    } catch (error) {
      console.error(
        "[DshRelayNotice] Failed to change DSH connection mode",
        error,
      );
      toast.error(
        t("dshRelay.relayFailed", { detail: extractErrorMessage(error) }),
      );
    }
  };

  return (
    <Notice
      tone={enabling ? "route" : "direct"}
      title={t("mode.activate.viewing", {
        view: t(`mode.names.${view}`),
        app: APP_DISPLAY_NAME["deepseek-harness"],
        active: t(`mode.names.${active}`),
      })}
      actions={
        <Button
          variant={enabling ? "route" : "direct"}
          size="compact"
          disabled={setRelay.isPending}
          onClick={() => void handle(enabling)}
        >
          {t(enabling ? "mode.activate.route" : "mode.activate.direct")}
        </Button>
      }
    >
      {enabling
        ? t("dshRelay.relayDescription")
        : t("dshRelay.directNoticeHint")}
    </Notice>
  );
}
