import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Boxes, Copy, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { AppPageHeader } from "@/components/shell/AppPageHeader";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ProviderIconBox } from "@/components/ProviderIconBox";
import { copyText } from "@/lib/clipboard";
import { toast } from "@/lib/toast";
import type { CustomApp } from "@/lib/api/customApps";
import type { Provider } from "@/types";
import {
  useCustomAppModelsQuery,
  useCustomAppProvidersQuery,
  useDeleteCustomAppProviderMutation,
  useSaveCustomAppProviderMutation,
} from "@/lib/query/customApps";
import { useCustomAppAddress } from "./CustomAppsPage";
import { CustomProviderDialog } from "./CustomProviderDialog";

interface CustomAppProvidersPageProps {
  app: CustomApp;
}

function maskKey(key: string): string {
  return key.length > 6 ? `${key.slice(0, 6)}••••••` : "••••••";
}

function providerBaseUrl(provider: Provider): string {
  const value = provider.settingsConfig?.baseURL;
  return typeof value === "string" ? value : "";
}

function providerModelCount(
  provider: Provider,
  models: { providerId: string }[],
): number {
  return models.filter((model) => model.providerId === provider.id).length;
}

export function CustomAppProvidersPage({ app }: CustomAppProvidersPageProps) {
  const { t } = useTranslation();
  const [dialogProvider, setDialogProvider] = useState<Provider | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [deleteProvider, setDeleteProvider] = useState<Provider | null>(null);
  const address = useCustomAppAddress(app.id);
  const { data: providers = {}, isLoading } = useCustomAppProvidersQuery(
    app.id,
  );
  const { data: models = [] } = useCustomAppModelsQuery(app.id);
  const saveMutation = useSaveCustomAppProviderMutation(app.id);
  const deleteMutation = useDeleteCustomAppProviderMutation(app.id);
  const providerList = useMemo(() => Object.values(providers), [providers]);
  const pending = saveMutation.isPending || deleteMutation.isPending;

  const copy = async (text: string) => {
    try {
      await copyText(text);
      toast.success(t("customApps.toast.addressCopied"));
    } catch {
      toast.error(t("customApps.toast.createFailed", { error: "" }));
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AppPageHeader
        icon={<Boxes className="h-[18px] w-[18px]" strokeWidth={2} />}
        title={app.name}
        subtitle={t("customApps.dialog.routingNote")}
        actions={
          <Button
            variant="solid"
            size="regular"
            onClick={() => {
              setDialogProvider(null);
              setIsCreateOpen(true);
            }}
          >
            <Plus className="h-4 w-4" />
            {t("provider.addProvider")}
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto scroll-stable">
        <div className="mx-auto max-w-4xl space-y-4 px-6 pb-10 pt-4">
          <div className="rounded-lg border border-border bg-subtle px-4 py-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="text-fg-3">{t("customApps.apiAddress")}</span>
              <span className="min-w-0 truncate font-mono text-caption text-fg-2">
                {address ?? t("customApps.proxyNotRunning")}
              </span>
              {address && (
                <Button
                  variant="quiet"
                  size="icon-compact"
                  aria-label={t("customApps.copyAddress")}
                  onClick={() => void copy(address)}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              )}
            </div>
            <div className="mt-2 flex items-center justify-between gap-3">
              <span className="text-fg-3">{t("customApps.apiKey")}</span>
              <span className="min-w-0 truncate font-mono text-caption text-fg-2">
                {maskKey(app.apiKey)}
              </span>
              <Button
                variant="quiet"
                size="icon-compact"
                aria-label={t("customApps.copyKey")}
                onClick={() => void copy(app.apiKey)}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <h3 className="text-strong font-semibold text-fg-1">
              {t("usage.provider")}
            </h3>
            <span className="text-caption text-fg-3">
              {t("customApps.modelsTitle", { count: models.length })}
            </span>
          </div>

          {isLoading ? (
            <div className="flex justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-fg-3" />
            </div>
          ) : providerList.length === 0 ? (
            <div className="rounded-lg border border-border bg-subtle px-6 py-10 text-center text-sm text-fg-3">
              {t("customApps.modelsEmpty")}
            </div>
          ) : (
            <div className="space-y-2">
              {providerList.map((provider) => (
                <div
                  key={provider.id}
                  className="flex items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3"
                >
                  <ProviderIconBox
                    icon={provider.icon}
                    name={provider.name}
                    color={provider.iconColor}
                    className="h-9 w-9"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-fg-1">
                      {provider.name}
                    </div>
                    <div className="truncate font-mono text-caption text-fg-3">
                      {provider.id} · {providerBaseUrl(provider)}
                    </div>
                  </div>
                  <span className="text-caption text-fg-3">
                    {t("customApps.modelsTitle", {
                      count: providerModelCount(provider, models),
                    })}
                  </span>
                  <Button
                    variant="quiet"
                    size="icon-compact"
                    aria-label={t("common.edit")}
                    onClick={() => setDialogProvider(provider)}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="quiet"
                    size="icon-compact"
                    aria-label={t("common.delete")}
                    onClick={() => setDeleteProvider(provider)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <CustomProviderDialog
        isOpen={isCreateOpen || dialogProvider !== null}
        provider={dialogProvider}
        pending={pending}
        onCancel={() => {
          setIsCreateOpen(false);
          setDialogProvider(null);
        }}
        onConfirm={(provider) =>
          saveMutation.mutate(provider, {
            onSuccess: () => {
              setIsCreateOpen(false);
              setDialogProvider(null);
            },
          })
        }
      />
      <ConfirmDialog
        isOpen={deleteProvider !== null}
        title={t("customApps.deleteTitle", {
          name: deleteProvider?.name ?? "",
        })}
        message={t("customApps.deleteBody", {
          name: deleteProvider?.name ?? "",
        })}
        confirmText={t("common.delete")}
        onCancel={() => setDeleteProvider(null)}
        onConfirm={() => {
          if (!deleteProvider) return;
          deleteMutation.mutate(deleteProvider.id, {
            onSuccess: () => setDeleteProvider(null),
          });
        }}
      />
    </div>
  );
}
