import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Provider } from "@/types";
import { useDshCurrentState, useDshRelayStatus } from "@/lib/query/dsh";
import { ModeTabs } from "./mode/ModeTabs";
import { DshRelaySheet } from "./DshRelaySheet";

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
  const [settingsOpen, setSettingsOpen] = useState(false);
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

  return (
    <>
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
        onOpenRouteSettings={
          modeView === "route" && active === "route"
            ? () => setSettingsOpen(true)
            : undefined
        }
        scope="dsh-mode"
      />
      <DshRelaySheet open={settingsOpen} onOpenChange={setSettingsOpen} />
    </>
  );
}
