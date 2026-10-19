import { useTranslation } from "react-i18next";
import { Waypoints } from "lucide-react";
import type { Provider } from "@/types";
import {
  useDshCurrentState,
  useDshRelayStatus,
  useSetDshRelay,
} from "@/lib/query/dsh";
import { toast } from "@/lib/toast";
import { extractErrorMessage } from "@/utils/errorUtils";
import { ModeTabs } from "./mode/ModeTabs";

type DshView = "providers" | "dshRelay";

interface DshModeBarProps {
  providers?: Provider[];
  view: DshView;
  onViewChange: (view: DshView) => void;
}

export function DshModeBar({
  providers = [],
  view,
  onViewChange,
}: DshModeBarProps) {
  const { t } = useTranslation();
  const { data: relay } = useDshRelayStatus();
  const { data: current } = useDshCurrentState();
  const setRelay = useSetDshRelay();
  const modeView = view === "dshRelay" ? "route" : "direct";
  const active = relay?.attached ? "route" : "direct";

  const relayedProviders = (relay?.providers ?? []).filter(
    (provider) => provider.relayed,
  );
  const routeTarget =
    relayedProviders.length === 1
      ? relayedProviders[0].name || relayedProviders[0].providerId
      : t("dshRelay.modeStatus.routeValue", { count: relayedProviders.length });
  const currentProviderId = current?.currentProviderId;
  const currentName = currentProviderId
    ? providers.find((provider) => provider.id === currentProviderId)?.name ||
      currentProviderId
    : "";
  const directTarget = currentName
    ? current?.currentModel
      ? `${currentName} · ${current.currentModel}`
      : currentName
    : "";
  const status =
    modeView !== active
      ? undefined
      : active === "route"
        ? { lead: t("mode.status.routeLead"), value: `→ ${routeTarget}` }
        : { lead: t("mode.status.directLead"), value: directTarget };

  const handleRelayChange = async (enabled: boolean) => {
    try {
      await setRelay.mutateAsync(enabled);
      toast.success(
        enabled ? t("dshRelay.relayEnabled") : t("dshRelay.relayDisabled"),
      );
    } catch (error) {
      console.error("[DshModeBar] Failed to toggle DSH relay", error);
      toast.error(
        t("dshRelay.relayFailed", { detail: extractErrorMessage(error) }),
      );
    }
  };

  return (
    <ModeTabs
      modes={["direct", "route"]}
      active={active}
      view={modeView}
      onView={(mode) =>
        onViewChange(mode === "route" ? "dshRelay" : "providers")
      }
      status={status}
      help={{
        title: t("dshRelay.help.title"),
        lines: [t("dshRelay.help.direct"), t("dshRelay.help.route")],
      }}
      toggle={{
        label: t("dshRelay.relayLabel"),
        icon: Waypoints,
        checked: Boolean(relay?.relayEnabled),
        disabled: !relay || setRelay.isPending,
        onChange: (enabled) => void handleRelayChange(enabled),
      }}
      scope="dsh-mode"
    />
  );
}
