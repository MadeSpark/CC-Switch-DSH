import { invoke } from "@tauri-apps/api/core";
import type { Provider } from "@/types";

/** 自定义应用（聚合路由）。API 地址由前端按当前代理端口拼接，后端不保存端口。 */
export interface CustomApp {
  id: string;
  name: string;
  icon: string;
  iconColor: string | null;
  apiKey: string;
  createdAt: number;
  updatedAt: number;
}

/** 聚合模型。id 是对外模型 id（<upstreamModel>-<providerId>）。 */
export interface CustomAppModel {
  id: string;
  upstreamModel: string;
  providerId: string;
  providerName: string;
  appType: string;
}

export const customAppsApi = {
  listCustomApps: () => invoke<CustomApp[]>("list_custom_apps"),
  createCustomApp: (name: string, icon: string, iconColor?: string | null) =>
    invoke<CustomApp>("create_custom_app", {
      name,
      icon,
      iconColor: iconColor ?? null,
    }),
  updateCustomApp: (
    id: string,
    name: string,
    icon: string,
    iconColor?: string | null,
  ) =>
    invoke<CustomApp>("update_custom_app", {
      id,
      name,
      icon,
      iconColor: iconColor ?? null,
    }),
  deleteCustomApp: (id: string) => invoke<boolean>("delete_custom_app", { id }),
  regenerateCustomAppKey: (id: string) =>
    invoke<CustomApp>("regenerate_custom_app_key", { id }),
  listCustomAppModels: (id: string) =>
    invoke<CustomAppModel[]>("list_custom_app_models", { id }),
  listCustomAppProviders: (id: string) =>
    invoke<Record<string, Provider>>("list_custom_app_providers", { id }),
  saveCustomAppProvider: (id: string, provider: Provider) =>
    invoke<boolean>("save_custom_app_provider", { id, provider }),
  deleteCustomAppProvider: (id: string, providerId: string) =>
    invoke<boolean>("delete_custom_app_provider", { id, providerId }),
};
