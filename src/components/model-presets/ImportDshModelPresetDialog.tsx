import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { CHECKBOX_CLASS, V7Dialog } from "@/components/mcp/formBits";
import {
  DSH_REASONING_LEVELS,
  formatDshReasoningLevelsLabel,
  normalizeDshModels,
  readDshReasoningEntries,
  type DshModel,
} from "@/components/providers/forms/helpers/deepseekHarnessFormUtils";
import { Button } from "@/components/ui/button";
import { DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { providersApi } from "@/lib/api";
import {
  dshModelFieldsToPresetParams,
  getDshModelPresetFields,
} from "@/lib/dshModelPresets";
import {
  normalizeModelPattern,
  uniquePresetId,
  type ModelPreset,
  type ModelPresetParams,
} from "@/lib/modelPresets";
import { cn } from "@/lib/utils";

/**
 * 只给导入对话框用的供应商查询键：不复用全局 `["providers", appId]`
 * （那里的缓存结构是 `{ providers, currentProviderId }`，混用会把列表写坏）。
 */
export const dshModelPresetProvidersQueryKey = [
  "providers",
  "deepseek-harness",
  "model-preset-import",
] as const;

export interface ImportDshModelPresetDialogProps {
  open: boolean;
  /** 现有预设：已有相同匹配模型 ID 的模型不再重复导入。 */
  presets: readonly ModelPreset[];
  /** 宿主正在保存（复用 ModelPresetsSection 的 isSaving）。 */
  isSaving?: boolean;
  /** 取消 / 关闭；保存成功后也会调用。 */
  onClose: () => void;
  /** 宿主负责一次性持久化这批预设（保留 generic 和其他预设）；返回 false 表示保存失败。 */
  onSave: (presets: ModelPreset[]) => Promise<boolean>;
}

interface ImportableModelRow {
  model: DshModel;
  modelId: string;
  name: string;
  params: ModelPresetParams;
  /** 当前配置里没有可迁移参数（例如只有 ID）。 */
  hasParams: boolean;
  /** 已有匹配同一模型 ID 的预设。 */
  duplicate: boolean;
  selectable: boolean;
}

function compareProviders(
  left: { name: string; sortIndex?: number },
  right: { name: string; sortIndex?: number },
): number {
  const leftIndex = left.sortIndex ?? Number.MAX_SAFE_INTEGER;
  const rightIndex = right.sortIndex ?? Number.MAX_SAFE_INTEGER;
  if (leftIndex !== rightIndex) return leftIndex - rightIndex;
  return left.name.localeCompare(right.name, "zh-CN");
}

function formatContextWindow(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : "—";
}

export function ImportDshModelPresetDialog({
  open,
  presets,
  isSaving = false,
  onClose,
  onSave,
}: ImportDshModelPresetDialogProps) {
  const { t } = useTranslation();

  const [providerId, setProviderId] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const selectAllRef = useRef<HTMLInputElement>(null);

  const pending = saving || isSaving;

  const providersQuery = useQuery({
    queryKey: dshModelPresetProvidersQueryKey,
    queryFn: () => providersApi.getAll("deepseek-harness"),
    // 对话框打开前不发请求；打开后每次重新读取 DSH 当前配置。
    enabled: open,
    retry: false,
  });

  const providers = useMemo(() => {
    const all = providersQuery.data ? Object.values(providersQuery.data) : [];
    return all.slice().sort(compareProviders);
  }, [providersQuery.data]);

  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.id === providerId) ?? null,
    [providerId, providers],
  );

  const models = useMemo(() => {
    const unique = new Map<string, DshModel>();
    for (const model of normalizeDshModels(
      selectedProvider?.settingsConfig?.models,
    )) {
      if (model.id && !unique.has(model.id)) unique.set(model.id, model);
    }
    return [...unique.values()];
  }, [selectedProvider]);

  const rows = useMemo<ImportableModelRow[]>(() => {
    return models.map((model) => {
      const fields = getDshModelPresetFields(model);
      const params = dshModelFieldsToPresetParams(
        model,
        fields.map((field) => field.key),
      );
      const duplicate = presets.some(
        (preset) =>
          normalizeModelPattern(preset.modelId).toLowerCase() ===
          model.id.toLowerCase(),
      );
      const hasParams = fields.length > 0;
      return {
        model,
        modelId: model.id,
        name: model.name?.trim() || model.id,
        params,
        hasParams,
        duplicate,
        selectable: hasParams && !duplicate,
      };
    });
  }, [models, presets]);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectableRows = useMemo(
    () => rows.filter((row) => row.selectable),
    [rows],
  );
  const selectedRows = useMemo(
    () => rows.filter((row) => row.selectable && selectedSet.has(row.modelId)),
    [rows, selectedSet],
  );
  const allSelected =
    selectableRows.length > 0 && selectedRows.length === selectableRows.length;
  const partiallySelected = selectedRows.length > 0 && !allSelected;

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = partiallySelected;
    }
  }, [partiallySelected]);

  // 每次打开都从「未选择」开始，避免上次的勾选/错误状态漏进来。
  useEffect(() => {
    if (!open) return;
    setProviderId("");
    setSelectedIds([]);
    setError(null);
    setSaving(false);
  }, [open]);

  const handleProviderChange = useCallback((nextProviderId: string) => {
    setProviderId(nextProviderId);
    setSelectedIds([]);
    setError(null);
  }, []);

  const toggleModel = useCallback((modelId: string, checked: boolean) => {
    setError(null);
    setSelectedIds((prev) => {
      if (checked) {
        return prev.includes(modelId) ? prev : [...prev, modelId];
      }
      return prev.filter((entry) => entry !== modelId);
    });
  }, []);

  const selectAllModels = useCallback(() => {
    setError(null);
    setSelectedIds(selectableRows.map((row) => row.modelId));
  }, [selectableRows]);

  const clearAllModels = useCallback(() => {
    setError(null);
    setSelectedIds([]);
  }, []);

  const handleClose = useCallback(() => {
    if (pending) return;
    onClose();
  }, [onClose, pending]);

  const handleSave = useCallback(async () => {
    if (selectedRows.length === 0) {
      setError(
        t("modelPresets.import.selectModelsFirst", {
          defaultValue: "请至少勾选一个可导入的模型。",
        }),
      );
      return;
    }

    const duplicated = selectedRows.find((row) =>
      presets.some(
        (preset) =>
          normalizeModelPattern(preset.modelId).toLowerCase() ===
          row.modelId.toLowerCase(),
      ),
    );
    if (duplicated) {
      setError(
        t("modelPresets.import.duplicateModelId", {
          defaultValue: "已存在匹配同一个模型 ID 的预设，请直接编辑已有预设。",
        }),
      );
      return;
    }

    const nextPresets: ModelPreset[] = selectedRows.map((row) => ({
      id: uniquePresetId(),
      name: row.name,
      modelId: row.modelId,
      ...row.params,
    }));

    setError(null);
    setSaving(true);
    try {
      const saved = await onSave(nextPresets);
      if (saved) onClose();
      else {
        setError(
          t("modelPresets.import.saveFailed", {
            defaultValue: "保存失败，当前选择已保留，可以直接重试。",
          }),
        );
      }
    } catch {
      setError(
        t("modelPresets.import.saveFailed", {
          defaultValue: "保存失败，当前选择已保留，可以直接重试。",
        }),
      );
    } finally {
      setSaving(false);
    }
  }, [onClose, onSave, presets, selectedRows, t]);

  const reasoningText = useCallback(
    (model: DshModel): string => {
      if (model.reasoningEfforts === false) {
        return t("dshReasoning.disabled", { defaultValue: "已禁用" });
      }
      // 原生模型字段只有 `reasoningEfforts`；旧插件在模型行写的
      // `reasoningEffort` 字符串不是原生字段，不能拿来冒充当前档位。
      const entries = readDshReasoningEntries(model.reasoningEfforts);
      if (entries && entries.length > 0) {
        // 这里只做只读摘要：七档按原生顺序展示，网关自定义键排在后面，
        // 不回头改写落盘里的键顺序。
        const levels = entries.map(([level]) => level);
        const canonical = DSH_REASONING_LEVELS as readonly string[];
        return formatDshReasoningLevelsLabel([
          ...canonical.filter((level) => levels.includes(level)),
          ...levels.filter((level) => !canonical.includes(level)),
        ]);
      }
      return t("dshReasoning.notSet", { defaultValue: "未设置" });
    },
    [t],
  );

  return (
    <V7Dialog
      open={open}
      width={760}
      onOpenChange={(next) => {
        if (!next) handleClose();
      }}
    >
      <div className="flex flex-col gap-1.5">
        <DialogTitle className="text-section [overflow-wrap:anywhere]">
          {t("modelPresets.import.title", {
            defaultValue: "从已配置供应商导入",
          })}
        </DialogTitle>
        <DialogDescription className="text-body text-fg-2">
          {t("modelPresets.import.description", {
            defaultValue:
              "读取所选 DeepSeek Harness 供应商的全部模型，勾选后批量生成预设。不会导入供应商凭据或地址。",
          })}
        </DialogDescription>
      </div>

      <div className="flex max-h-[62vh] flex-col gap-3 overflow-y-auto pe-1">
        {providersQuery.isPending ? (
          <p className="m-0 text-body text-fg-2">
            {t("modelPresets.import.loadingProviders", {
              defaultValue: "正在读取 DSH 供应商…",
            })}
          </p>
        ) : providersQuery.isError ? (
          <div className="flex flex-col gap-2 rounded-panel border border-border bg-subtle px-3 py-2">
            <p className="m-0 text-body text-fg-2" role="alert">
              {t("modelPresets.import.loadProvidersFailed", {
                defaultValue: "读取 DSH 供应商失败，请重试。",
              })}
            </p>
            <div>
              <Button
                type="button"
                variant="neutral"
                size="compact"
                onClick={() => void providersQuery.refetch()}
              >
                {t("modelPresets.import.retry", { defaultValue: "重试" })}
              </Button>
            </div>
          </div>
        ) : providers.length === 0 ? (
          <p className="m-0 text-body text-fg-2">
            {t("modelPresets.import.emptyProviders", {
              defaultValue:
                "还没有已配置的 DeepSeek Harness 供应商。请先在供应商页添加供应商和模型。",
            })}
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="dsh-preset-import-provider"
                className="text-body font-medium text-fg-1"
              >
                {t("modelPresets.import.providerLabel", {
                  defaultValue: "供应商",
                })}
              </label>
              <Select value={providerId} onValueChange={handleProviderChange}>
                <SelectTrigger
                  id="dsh-preset-import-provider"
                  className="h-8 w-full"
                  aria-label={t("modelPresets.import.providerLabel", {
                    defaultValue: "供应商",
                  })}
                >
                  <SelectValue
                    placeholder={t("modelPresets.import.providerPlaceholder", {
                      defaultValue: "选择 DSH 供应商",
                    })}
                  />
                </SelectTrigger>
                <SelectContent>
                  {providers.map((provider) => (
                    <SelectItem key={provider.id} value={provider.id}>
                      {provider.name || provider.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {selectedProvider && models.length === 0 ? (
              <p className="m-0 text-caption text-fg-3">
                {t("modelPresets.import.emptyModels", {
                  defaultValue:
                    "该供应商还没有配置模型。请先在供应商表单里添加模型。",
                })}
              </p>
            ) : selectedProvider ? (
              <section className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="m-0 text-body font-semibold">
                    {t("modelPresets.import.modelLabel", {
                      defaultValue: "模型",
                    })}
                  </h3>
                  <span className="text-caption text-fg-3">
                    {t("modelPresets.import.selectableCount", {
                      defaultValue: "共 {{count}} 个可导入",
                      count: selectableRows.length,
                    })}
                  </span>
                  <span className="text-caption text-fg-2">
                    {t("modelPresets.import.selectedCount", {
                      defaultValue: "已选 {{count}} 个模型",
                      count: selectedRows.length,
                    })}
                  </span>
                  <div className="ms-auto flex items-center gap-1">
                    <Button
                      type="button"
                      variant="quiet"
                      size="compact"
                      disabled={selectableRows.length === 0 || allSelected}
                      onClick={selectAllModels}
                    >
                      {t("modelPresets.import.selectAll", {
                        defaultValue: "全选",
                      })}
                    </Button>
                    <Button
                      type="button"
                      variant="quiet"
                      size="compact"
                      disabled={selectedRows.length === 0}
                      onClick={clearAllModels}
                    >
                      {t("modelPresets.import.clearAll", {
                        defaultValue: "清空",
                      })}
                    </Button>
                  </div>
                </div>

                <div className="max-h-[300px] overflow-auto rounded-panel border border-border">
                  <table
                    className="w-full table-fixed border-collapse text-body"
                    aria-label={t("modelPresets.import.modelTableLabel", {
                      defaultValue: "供应商模型",
                    })}
                  >
                    <thead className="sticky top-0 z-[1] bg-subtle text-caption text-fg-3">
                      <tr className="border-b border-border">
                        <th scope="col" className="w-9 px-2 py-1.5">
                          <input
                            ref={selectAllRef}
                            type="checkbox"
                            className={CHECKBOX_CLASS}
                            aria-label={t("modelPresets.import.selectAll", {
                              defaultValue: "全选",
                            })}
                            checked={allSelected}
                            disabled={selectableRows.length === 0}
                            onChange={(event) => {
                              if (event.target.checked) selectAllModels();
                              else clearAllModels();
                            }}
                          />
                        </th>
                        <th
                          scope="col"
                          className="w-[26%] px-2 py-1.5 text-left font-medium"
                        >
                          {t("modelPresets.import.tableName", {
                            defaultValue: "显示名称",
                          })}
                        </th>
                        <th
                          scope="col"
                          className="px-2 py-1.5 text-left font-medium"
                        >
                          {t("modelPresets.import.tableModelId", {
                            defaultValue: "模型 ID",
                          })}
                        </th>
                        <th
                          scope="col"
                          className="w-[18%] px-2 py-1.5 text-left font-medium"
                        >
                          {t("modelPresets.import.tableContextWindow", {
                            defaultValue: "上下文窗口",
                          })}
                        </th>
                        <th
                          scope="col"
                          className="w-[20%] px-2 py-1.5 text-left font-medium"
                        >
                          {t("modelPresets.import.tableReasoning", {
                            defaultValue: "推理等级",
                          })}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => {
                        const checked =
                          row.selectable && selectedSet.has(row.modelId);
                        return (
                          <tr
                            key={row.modelId}
                            className={cn(
                              "border-b border-border last:border-b-0",
                              !row.selectable && "bg-subtle/40",
                            )}
                          >
                            <td className="px-2 py-1.5 align-middle">
                              <input
                                type="checkbox"
                                className={CHECKBOX_CLASS}
                                aria-label={t("modelPresets.import.selectRow", {
                                  defaultValue: "选择 {{name}}",
                                  name: row.name,
                                })}
                                checked={checked}
                                disabled={!row.selectable}
                                onChange={(event) =>
                                  toggleModel(row.modelId, event.target.checked)
                                }
                              />
                            </td>
                            <td className="min-w-0 px-2 py-1.5 align-middle">
                              <div className="flex min-w-0 items-center gap-1.5">
                                <span
                                  className="min-w-0 truncate"
                                  title={row.name}
                                >
                                  {row.name}
                                </span>
                                {row.duplicate ? (
                                  <span className="shrink-0 rounded-sm bg-subtle px-1.5 py-0.5 text-caption text-fg-3">
                                    {t("modelPresets.import.rowDuplicate", {
                                      defaultValue: "已有预设",
                                    })}
                                  </span>
                                ) : !row.hasParams ? (
                                  <span className="shrink-0 rounded-sm bg-subtle px-1.5 py-0.5 text-caption text-fg-3">
                                    {t("modelPresets.import.rowNoParams", {
                                      defaultValue: "无可导入参数",
                                    })}
                                  </span>
                                ) : null}
                              </div>
                            </td>
                            <td className="min-w-0 px-2 py-1.5 align-middle">
                              <code
                                className="block truncate font-mono text-caption text-fg-2"
                                title={row.modelId}
                              >
                                {row.modelId}
                              </code>
                            </td>
                            <td className="px-2 py-1.5 align-middle tabular-nums">
                              {formatContextWindow(row.model.contextWindow)}
                            </td>
                            <td
                              className="truncate px-2 py-1.5 align-middle text-caption text-fg-2"
                              title={reasoningText(row.model)}
                            >
                              {reasoningText(row.model)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <p className="m-0 text-caption text-fg-3">
                  {t("modelPresets.import.selectModelHint", {
                    defaultValue:
                      "勾选要导入的模型；每个模型会带上它当前配置的全部模型参数。",
                  })}
                </p>
                {rows.some((row) => row.duplicate) && (
                  <p className="m-0 text-caption text-fg-3">
                    {t("modelPresets.import.duplicateHint", {
                      defaultValue: "已有相同匹配 ID 的预设，不会重复导入。",
                    })}
                  </p>
                )}
                {selectableRows.length === 0 && (
                  <p className="m-0 text-caption text-fg-3">
                    {t("modelPresets.import.noSelectable", {
                      defaultValue: "该供应商没有可导入的模型。",
                    })}
                  </p>
                )}
              </section>
            ) : (
              <p className="m-0 text-caption text-fg-3">
                {t("modelPresets.import.selectProviderHint", {
                  defaultValue: "选择供应商后，会列出它的全部模型。",
                })}
              </p>
            )}
          </>
        )}
      </div>

      {error && (
        <p className="m-0 text-caption text-danger" role="alert">
          {error}
        </p>
      )}

      <div className="flex flex-wrap justify-end gap-2 pt-1">
        <Button
          type="button"
          variant="neutral"
          size="regular"
          disabled={pending}
          onClick={handleClose}
        >
          {t("modelPresets.cancel")}
        </Button>
        <Button
          type="button"
          variant="solid"
          size="regular"
          disabled={pending || selectedRows.length === 0}
          onClick={() => void handleSave()}
        >
          {selectedRows.length > 0
            ? t("modelPresets.import.importButtonCount", {
                defaultValue: "导入 {{count}} 个预设",
                count: selectedRows.length,
              })
            : t("modelPresets.import.importButton", {
                defaultValue: "导入预设",
              })}
        </Button>
      </div>
    </V7Dialog>
  );
}
