import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { SearchField } from "@/components/ui/search-field";
import { AppGlyph, APP_DISPLAY_NAME } from "@/components/shell/AppGlyph";
import { ProviderIconBox } from "@/components/ProviderIconBox";
import type { AppId } from "@/lib/api/types";
import type { CatalogItem } from "@/lib/api/selectiveConfig";
import {
  type CatalogGroups,
  type GroupNode,
  groupCheckedState,
  groupSelectedCount,
  overallCheckedState,
  selectedIdsForGroup,
  toggleAll,
  toggleGroup,
  toggleItem,
  countSelected,
} from "./selectionLogic";

interface SelectionTreeProps {
  groupsData: CatalogGroups;
  selection: Parameters<typeof toggleAll>[1];
  onSelectionChange: (next: Parameters<typeof toggleAll>[1]) => void;
  /** 导入预览时单项显示「已存在」 */
  showExists?: boolean;
}

function ItemRow({
  item,
  checked,
  onToggle,
  showExists,
}: {
  item: CatalogItem;
  checked: boolean;
  onToggle: () => void;
  showExists?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <label className="flex min-w-0 cursor-pointer items-center gap-2 py-1 pl-2 text-sm text-fg-1">
      <Checkbox
        checked={checked}
        aria-checked={checked ? "true" : "false"}
        onCheckedChange={onToggle}
        aria-label={item.name}
      />
      <span className="min-w-0 flex-1 truncate">{item.name}</span>
      {item.detail ? (
        <span className="min-w-0 max-w-[45%] truncate font-mono text-xs text-fg-2">
          {item.detail}
        </span>
      ) : null}
      {showExists && item.exists ? (
        <span className="shrink-0 rounded-full border border-border-strong bg-subtle px-1.5 py-0.5 text-[10px] leading-none text-fg-2">
          {t("settings.selectiveConfig.existsBadge")}
        </span>
      ) : null}
    </label>
  );
}

function GroupRow({
  group,
  groupsData,
  selection,
  onSelectionChange,
  showExists,
}: {
  group: GroupNode;
  groupsData: CatalogGroups;
  selection: SelectionTreeProps["selection"];
  onSelectionChange: SelectionTreeProps["onSelectionChange"];
  showExists?: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState("");

  const checked = groupCheckedState(group, selection);
  const selectedCount = groupSelectedCount(group, selection);

  // 组名 / 图标
  let label = group.label;
  let icon: React.ReactNode = null;
  if (group.id.startsWith("providers:")) {
    const appType = group.id.slice("providers:".length) as AppId;
    label = APP_DISPLAY_NAME[appType] ?? appType;
    icon = <AppGlyph app={appType} size={16} />;
  } else if (group.id.startsWith("customApp:")) {
    const app = groupsData.customAppGroups.find(
      (entry) => entry.group.id === group.id,
    )?.data;
    if (app) {
      label = app.name;
      icon = (
        <ProviderIconBox
          icon={app.icon ?? undefined}
          name={app.name}
          color={app.iconColor ?? undefined}
          className="h-4 w-4 rounded-[4px] border-0"
          iconClassName="!h-3.5 !w-3.5"
        />
      );
    }
  } else if (group.id === "modelPricing") {
    label = t("settings.selectiveConfig.groupModelPricing");
  } else if (group.id === "modelPresets") {
    label = t("settings.selectiveConfig.groupModelPresets");
  } else if (group.id === "genericPreset") {
    label = t("settings.selectiveConfig.groupGenericPreset");
  }

  const total = group.items.length;
  const isCustomApp = group.id.startsWith("customApp:");
  // 导入预览：自定义应用整体行的「已存在」徽标（该行不可展开）
  const customAppExists = isCustomApp
    ? (groupsData.customAppGroups.find((entry) => entry.group.id === group.id)
        ?.data.exists ?? false)
    : false;
  // 定价组可搜索；自定义应用只有整体一项（不展开到供应商）
  const searchable = group.id === "modelPricing" && expanded;
  const filteredItems = useMemo(() => {
    if (!search.trim()) return group.items;
    const q = search.trim().toLowerCase();
    return group.items.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        (item.detail ?? "").toLowerCase().includes(q),
    );
  }, [group.items, search]);

  return (
    <div className="rounded-lg border border-border">
      <div className="flex items-center gap-2 px-3 py-2">
        {total > 0 && !isCustomApp ? (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="shrink-0 rounded p-0.5 text-fg-2 hover:text-fg-1"
            aria-label={
              expanded
                ? t("settings.selectiveConfig.collapseGroup")
                : t("settings.selectiveConfig.expandGroup")
            }
          >
            {expanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
        ) : (
          <span className="w-5 shrink-0" />
        )}
        <Checkbox
          checked={checked}
          aria-checked={
            checked === "indeterminate" ? undefined : checked ? "true" : "false"
          }
          onCheckedChange={(next) =>
            // 原生 input 在半选态渲染 checked=false，点击时发出 false；
            // 半选态点击语义是「全选」，这里转换回 true。
            onSelectionChange(
              toggleGroup(
                group,
                selection,
                checked === "indeterminate" ? true : next,
              ),
            )
          }
          aria-label={label}
        />
        {icon}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg-1">
          {label}
        </span>
        {showExists && customAppExists ? (
          <span className="shrink-0 rounded-full border border-border-strong bg-subtle px-1.5 py-0.5 text-[10px] leading-none text-fg-2">
            {t("settings.selectiveConfig.existsBadge")}
          </span>
        ) : null}
        <span className="shrink-0 text-xs text-fg-2">
          {group.isBoolean ? null : `${selectedCount}/${total}`}
        </span>
      </div>
      {expanded && total > 0 && !isCustomApp ? (
        <div className="border-t border-border px-3 py-1.5">
          {searchable ? (
            <div className="pb-1.5">
              <SearchField
                value={search}
                onValueChange={setSearch}
                clearLabel={t("settings.selectiveConfig.clearSearch")}
              />
            </div>
          ) : null}
          {filteredItems.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              checked={selectedIdsForGroup(group.id, selection).has(item.id)}
              showExists={showExists}
              onToggle={() =>
                onSelectionChange(toggleItem(group, item.id, selection))
              }
            />
          ))}
          {filteredItems.length === 0 ? (
            <p className="py-2 text-sm text-fg-2">
              {t("settings.selectiveConfig.noSearchResults")}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function SelectionTree({
  groupsData,
  selection,
  onSelectionChange,
  showExists,
}: SelectionTreeProps) {
  const { t } = useTranslation();
  const { groups } = groupsData;
  const overall = overallCheckedState(groups, selection);
  const selectedTotal = countSelected(groups, selection);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Checkbox
          checked={overall}
          aria-checked={
            overall === "indeterminate" ? undefined : overall ? "true" : "false"
          }
          onCheckedChange={(next) =>
            // 半选态点击语义是「全选」；全选态点击是「全不选」
            onSelectionChange(
              toggleAll(
                groups,
                selection,
                overall === "indeterminate" ? true : next,
              ),
            )
          }
          aria-label={t("settings.selectiveConfig.selectAll")}
        />
        <span className="text-sm font-medium text-fg-1">
          {t("settings.selectiveConfig.selectAll")}
        </span>
        <span className="ml-auto text-sm text-fg-2">
          {t("settings.selectiveConfig.selectedCount", {
            count: selectedTotal,
          })}
        </span>
      </div>
      <div className="space-y-2">
        {[
          ...groupsData.providerGroups.map((entry) => entry.group),
          ...groupsData.customAppGroups.map((entry) => entry.group),
          ...groupsData.plainGroups.map((entry) => entry.group),
        ].map((group) => (
          <GroupRow
            key={group.id}
            group={group}
            groupsData={groupsData}
            selection={selection}
            onSelectionChange={onSelectionChange}
            showExists={showExists}
          />
        ))}
      </div>
    </div>
  );
}
