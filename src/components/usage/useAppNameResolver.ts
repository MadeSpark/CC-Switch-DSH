import { useMemo } from "react";
import type { CustomApp } from "@/lib/api/customApps";
import { useCustomAppsQuery } from "@/lib/query/customApps";
import { appDisplayName, appShortName } from "./RequestLogTable";

/**
 * 用量页「应用」名称解析：内置应用走静态表；自定义应用的 appType 就是
 * CustomApp.id，用自定义应用列表把 id 换成用户起的名字。
 * 列表没加载完或应用已删除时回退到原始 id（与旧行为一致）。
 */
export function useAppNameResolver() {
  const { data: customApps } = useCustomAppsQuery();

  const customAppById = useMemo(() => {
    const map = new Map<string, CustomApp>();
    for (const app of customApps ?? []) {
      map.set(app.id, app);
    }
    return map;
  }, [customApps]);

  const displayName = (appType: string): string => {
    const customApp = customAppById.get(appType);
    if (customApp) return customApp.name;
    return appDisplayName(appType);
  };

  const shortName = (appType: string): string => {
    const customApp = customAppById.get(appType);
    if (customApp) return customApp.name;
    return appShortName(appType);
  };

  const customApp = (appType: string): CustomApp | undefined =>
    customAppById.get(appType);

  return { displayName, shortName, customApp };
}
