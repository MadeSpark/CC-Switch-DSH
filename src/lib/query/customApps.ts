import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { customAppsApi, type CustomApp } from "@/lib/api/customApps";
import type { Provider } from "@/types";
import { toast } from "@/lib/toast";
import { extractErrorMessage } from "@/utils/errorUtils";

export const customAppsKeys = {
  all: ["customApps"] as const,
  lists: () => [...customAppsKeys.all, "list"] as const,
  models: (id: string) => [...customAppsKeys.all, "models", id] as const,
  providers: (id: string) => [...customAppsKeys.all, "providers", id] as const,
};

/** 自定义应用列表（聚合路由页）。 */
export function useCustomAppsQuery() {
  return useQuery({
    queryKey: customAppsKeys.lists(),
    queryFn: () => customAppsApi.listCustomApps(),
  });
}

/** 一个自定义应用的聚合模型列表：展开卡片时才取。 */
export function useCustomAppModelsQuery(id: string, enabled = true) {
  return useQuery({
    queryKey: customAppsKeys.models(id),
    queryFn: () => customAppsApi.listCustomAppModels(id),
    enabled,
  });
}

/** 自定义应用自己的供应商列表。 */
export function useCustomAppProvidersQuery(id: string, enabled = true) {
  return useQuery({
    queryKey: customAppsKeys.providers(id),
    queryFn: () => customAppsApi.listCustomAppProviders(id),
    enabled,
  });
}

export function useSaveCustomAppProviderMutation(id: string) {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  return useMutation({
    mutationFn: (provider: Provider) =>
      customAppsApi.saveCustomAppProvider(id, provider),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: customAppsKeys.providers(id),
      });
      void queryClient.invalidateQueries({
        queryKey: customAppsKeys.models(id),
      });
      toast.success(t("customApps.toast.updated", { name: "" }));
    },
    onError: (error) => {
      toast.error(
        t("customApps.toast.updateFailed", {
          error: extractErrorMessage(error),
        }),
      );
    },
  });
}

export function useDeleteCustomAppProviderMutation(id: string) {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  return useMutation({
    mutationFn: (providerId: string) =>
      customAppsApi.deleteCustomAppProvider(id, providerId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: customAppsKeys.providers(id),
      });
      void queryClient.invalidateQueries({
        queryKey: customAppsKeys.models(id),
      });
      toast.success(t("customApps.toast.deleted", { name: "" }));
    },
    onError: (error) => {
      toast.error(
        t("customApps.toast.deleteFailed", {
          error: extractErrorMessage(error),
        }),
      );
    },
  });
}

/** 新建后把新应用交给调用方（跳转、展开等）。 */
export function useCreateCustomAppMutation(
  onSuccess?: (app: CustomApp) => void,
) {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  return useMutation({
    mutationFn: ({
      name,
      icon,
      iconColor,
    }: {
      name: string;
      icon: string;
      iconColor?: string | null;
    }) => customAppsApi.createCustomApp(name, icon, iconColor),
    onSuccess: (app) => {
      void queryClient.invalidateQueries({ queryKey: customAppsKeys.lists() });
      toast.success(t("customApps.toast.created", { name: app.name }));
      onSuccess?.(app);
    },
    onError: (error) => {
      toast.error(
        t("customApps.toast.createFailed", {
          error: extractErrorMessage(error),
        }),
      );
    },
  });
}

export function useUpdateCustomAppMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  return useMutation({
    mutationFn: ({
      id,
      name,
      icon,
      iconColor,
    }: {
      id: string;
      name: string;
      icon: string;
      iconColor?: string | null;
    }) => customAppsApi.updateCustomApp(id, name, icon, iconColor),
    onSuccess: (app) => {
      void queryClient.invalidateQueries({ queryKey: customAppsKeys.lists() });
      toast.success(t("customApps.toast.updated", { name: app.name }));
    },
    onError: (error) => {
      toast.error(
        t("customApps.toast.updateFailed", {
          error: extractErrorMessage(error),
        }),
      );
    },
  });
}

export function useDeleteCustomAppMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  return useMutation({
    mutationFn: ({ id }: { id: string; name: string }) =>
      customAppsApi.deleteCustomApp(id),
    onSuccess: (_deleted, { name }) => {
      void queryClient.invalidateQueries({ queryKey: customAppsKeys.all });
      toast.success(t("customApps.toast.deleted", { name }));
    },
    onError: (error) => {
      toast.error(
        t("customApps.toast.deleteFailed", {
          error: extractErrorMessage(error),
        }),
      );
    },
  });
}

export function useRegenerateCustomAppKeyMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  return useMutation({
    mutationFn: ({ id }: { id: string }) =>
      customAppsApi.regenerateCustomAppKey(id),
    onSuccess: (app) => {
      void queryClient.invalidateQueries({ queryKey: customAppsKeys.lists() });
      toast.success(t("customApps.toast.keyRegenerated", { name: app.name }));
    },
    onError: (error) => {
      toast.error(
        t("customApps.toast.keyRegenerateFailed", {
          error: extractErrorMessage(error),
        }),
      );
    },
  });
}
