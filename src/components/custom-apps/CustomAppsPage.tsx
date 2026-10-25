import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Boxes,
  ChevronDown,
  ChevronRight,
  Copy,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { AppPageHeader } from "@/components/shell/AppPageHeader";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ProviderIconBox } from "@/components/ProviderIconBox";
import { HoverTip } from "@/components/ui/hover-tip";
import {
  useCustomAppModelsQuery,
  useCustomAppsQuery,
  useCreateCustomAppMutation,
  useDeleteCustomAppMutation,
  useRegenerateCustomAppKeyMutation,
  useUpdateCustomAppMutation,
} from "@/lib/query/customApps";
import { useProxyStatusQuery } from "@/lib/query/proxy";
import { copyText } from "@/lib/clipboard";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import type { CustomApp } from "@/lib/api/customApps";
import { CustomAppDialog } from "./CustomAppDialog";

type DialogState = { mode: "create" } | { mode: "edit"; app: CustomApp } | null;

/**
 * 自定义应用（聚合路由）全局页：每个应用一张卡片 —— 图标、名称、API 地址、
 * 打码的 API Key、聚合模型预览。API 地址按当前代理端口现拼，路由没开就提示先启动。
 */
export function CustomAppsPage() {
  const { t } = useTranslation();
  const [dialog, setDialog] = useState<DialogState>(null);
  const [deleteTarget, setDeleteTarget] = useState<CustomApp | null>(null);

  const { data: apps = [], isLoading } = useCustomAppsQuery();
  const createMutation = useCreateCustomAppMutation(() => setDialog(null));
  const updateMutation = useUpdateCustomAppMutation();
  const deleteMutation = useDeleteCustomAppMutation();
  const regenerateMutation = useRegenerateCustomAppKeyMutation();

  const pending = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AppPageHeader
        icon={<Boxes className="h-[18px] w-[18px]" strokeWidth={2} />}
        title={t("customApps.title")}
        actions={
          <Button
            variant="solid"
            size="regular"
            onClick={() => setDialog({ mode: "create" })}
          >
            <Plus className="h-4 w-4" />
            {t("customApps.add")}
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto scroll-stable">
        <div className="mx-auto max-w-4xl space-y-4 px-6 pb-10 pt-4">
          <p className="text-sm text-fg-3">{t("customApps.help")}</p>
          {isLoading ? (
            <div className="flex justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-fg-3" />
            </div>
          ) : apps.length === 0 ? (
            <div className="rounded-lg border border-border bg-subtle px-6 py-10 text-center text-sm text-fg-3">
              {t("customApps.empty")}
            </div>
          ) : (
            apps.map((app) => (
              <CustomAppCard
                key={app.id}
                app={app}
                regenerating={regenerateMutation.isPending}
                onEdit={() => setDialog({ mode: "edit", app })}
                onDelete={() => setDeleteTarget(app)}
                onRegenerateKey={() =>
                  regenerateMutation.mutate({ id: app.id })
                }
              />
            ))
          )}
        </div>
      </div>

      <CustomAppDialog
        isOpen={dialog !== null}
        app={dialog?.mode === "edit" ? dialog.app : null}
        pending={pending}
        onCancel={() => setDialog(null)}
        onConfirm={(values) => {
          if (dialog?.mode === "edit") {
            updateMutation.mutate(
              { id: dialog.app.id, ...values },
              { onSuccess: () => setDialog(null) },
            );
          } else {
            createMutation.mutate(values);
          }
        }}
      />

      <ConfirmDialog
        isOpen={deleteTarget !== null}
        title={t("customApps.deleteTitle", { name: deleteTarget?.name ?? "" })}
        message={t("customApps.deleteBody", { name: deleteTarget?.name ?? "" })}
        pending={deleteMutation.isPending}
        onConfirm={() => {
          if (!deleteTarget) return;
          deleteMutation.mutate(
            { id: deleteTarget.id, name: deleteTarget.name },
            { onSuccess: () => setDeleteTarget(null) },
          );
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

function CustomAppCard({
  app,
  regenerating,
  onEdit,
  onDelete,
  onRegenerateKey,
}: {
  app: CustomApp;
  regenerating: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onRegenerateKey: () => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const address = useCustomAppAddress(app.id);

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-3 text-start"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          {expanded ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-fg-3" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-fg-3" />
          )}
          <ProviderIconBox icon={app.icon} name={app.name} />
          <span className="truncate text-sm font-semibold text-fg-1">
            {app.name}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          <HoverTip content={t("customApps.edit")}>
            <Button
              variant="ghost"
              size="icon-compact"
              aria-label={t("customApps.edit")}
              onClick={onEdit}
            >
              <Pencil className="h-4 w-4" />
            </Button>
          </HoverTip>
          <HoverTip content={t("customApps.delete")}>
            <Button
              variant="ghost"
              size="icon-compact"
              aria-label={t("customApps.delete")}
              onClick={onDelete}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </HoverTip>
        </div>
      </div>
      {expanded ? (
        <div className="space-y-3 border-t border-border px-4 py-3">
          <AddressRow address={address} appId={app.id} />
          <ApiKeyRow
            apiKey={app.apiKey}
            appId={app.id}
            regenerating={regenerating}
            onRegenerate={onRegenerateKey}
          />
          <CustomAppModels appId={app.id} enabled={expanded} />
        </div>
      ) : null}
    </div>
  );
}

/** API 地址 = http://127.0.0.1:<当前代理端口>/custom/<id>/v1；端口不落库，随路由状态变。 */
export function useCustomAppAddress(appId: string): string | null {
  const { data: status } = useProxyStatusQuery();
  return useMemo(
    () =>
      status?.running && status.port
        ? `http://127.0.0.1:${status.port}/custom/${appId}/v1`
        : null,
    [status?.running, status?.port, appId],
  );
}

function AddressRow({
  address,
  appId,
}: {
  address: string | null;
  appId: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-fg-2">
        {t("customApps.apiAddress")}
      </div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-subtle px-2 py-1.5 text-xs text-fg-1">
          {address ?? t("customApps.proxyNotRunning")}
        </code>
        <Button
          variant="ghost"
          size="icon-compact"
          disabled={!address}
          aria-label={t("customApps.copyAddress")}
          onClick={async () => {
            if (!address) return;
            await copyText(address);
            toast.success(t("customApps.toast.addressCopied"));
          }}
        >
          <Copy className="h-4 w-4" />
        </Button>
      </div>
      <p className="text-xs text-fg-3">
        {t("customApps.addressHint", { appId })}
      </p>
    </div>
  );
}

/** Key 打码展示：只留前 6 位，复制时给完整值。 */
function maskKey(apiKey: string): string {
  return apiKey.length > 6 ? `${apiKey.slice(0, 6)}••••••` : "••••••";
}

function ApiKeyRow({
  apiKey,
  appId,
  regenerating,
  onRegenerate,
}: {
  apiKey: string;
  appId: string;
  regenerating: boolean;
  onRegenerate: () => void;
}) {
  const { t } = useTranslation();
  void appId;
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-fg-2">
        {t("customApps.apiKey")}
      </div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-subtle px-2 py-1.5 text-xs text-fg-1">
          {maskKey(apiKey)}
        </code>
        <HoverTip content={t("customApps.copyKey")}>
          <Button
            variant="ghost"
            size="icon-compact"
            aria-label={t("customApps.copyKey")}
            onClick={async () => {
              await copyText(apiKey);
              toast.success(t("customApps.toast.keyCopied"));
            }}
          >
            <Copy className="h-4 w-4" />
          </Button>
        </HoverTip>
        <HoverTip content={t("customApps.resetKey")}>
          <Button
            variant="ghost"
            size="icon-compact"
            disabled={regenerating}
            aria-label={t("customApps.resetKey")}
            onClick={onRegenerate}
          >
            {regenerating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </Button>
        </HoverTip>
      </div>
    </div>
  );
}

function CustomAppModels({
  appId,
  enabled,
}: {
  appId: string;
  enabled: boolean;
}) {
  const { t } = useTranslation();
  const { data: models = [], isLoading } = useCustomAppModelsQuery(
    appId,
    enabled,
  );

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-2 text-xs text-fg-3">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t("customApps.modelsLoading")}
      </div>
    );
  }

  if (models.length === 0) {
    return <p className="text-xs text-fg-3">{t("customApps.modelsEmpty")}</p>;
  }

  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-fg-2">
        {t("customApps.modelsTitle", { count: models.length })}
      </div>
      <ul className="space-y-1">
        {models.map((model) => (
          <li
            key={model.id}
            className="flex items-center gap-2 rounded bg-subtle px-2 py-1.5 text-xs"
          >
            <KeyRound className="h-3 w-3 shrink-0 text-fg-3" />
            <code className="truncate text-fg-1">{model.id}</code>
            <span
              className={cn(
                "ml-auto shrink-0 text-fg-3",
                "text-[11px] tabular-nums",
              )}
            >
              {model.providerName}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
