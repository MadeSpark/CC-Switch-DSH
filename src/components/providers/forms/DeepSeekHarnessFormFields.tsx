import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { FormLabel } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { ImeSafeInput } from "@/components/ui/ime-safe-input";
import { Button } from "@/components/ui/button";
import { DshModelPresetMatchDialog } from "@/components/model-presets/DshModelPresetMatchDialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ApiKeySection, ModelDropdown } from "./shared";
import {
  fetchModelsForConfig,
  showFetchModelsError,
  type FetchedModel,
} from "@/lib/api/model-fetch";
import {
  DSH_MODEL_API_OPTIONS,
  DSH_REASONING_LEVELS,
  dshReasoningEffortsEqual,
  dshReasoningPresetFor,
  formatDshReasoningLevelsLabel,
  isDshReasoningEfforts,
  nextDshRowKey,
  orderDshReasoningEfforts,
  toggleDshReasoningLevel,
  withDshRowKeys,
  type DshModel,
  type DshReasoningEfforts,
} from "./helpers/deepseekHarnessFormUtils";
import {
  FetchedModelPicker,
  type FetchedModelSelection,
} from "./FetchedModelPicker";
import type { ProviderCategory } from "@/types";

const API_FORMAT_LABELS: Record<string, string> = {
  "openai-completions": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
  "anthropic-messages": "Anthropic Messages",
};

interface DshReasoningLevelsEditorProps {
  /** 这一行已存的等级表；`undefined` 表示没设置过（不写这个字段）。 */
  efforts?: DshReasoningEfforts;
  /** 最后一个非 off 等级：不能再取消，点了只给提示。 */
  blockedLevel?: string;
  /** 推荐预设家族；有值时面板底部给出「使用预设」。 */
  recommendedFamily?: string;
  /** 当前等级表已与推荐预设完全一致。 */
  recommendedApplied?: boolean;
  /** 这一行显式写了 `reasoningEfforts: false`。 */
  forcedOff?: boolean;
  /** 这一行开了 `compat.forceAdaptiveThinking`。 */
  adaptive?: boolean;
  /** 有可清除的字段（等级表或 false）时显示清除按钮。 */
  clearable?: boolean;
  onToggle: (level: string) => void;
  onApplyPreset?: () => void;
  onClear?: () => void;
}

/**
 * 推理等级控件：与 Codex 表单同一个 Popover 壳（紧凑触发器 + 折叠文案），
 * 面板里是一列 checkbox —— 等级名用英文原文，右侧灰字是真正会落盘的发送值。
 * 打开后不自动关闭，方便连续勾选；数据仍然由调用方的 onToggle 负责持久化。
 */
function DshReasoningLevelsEditor({
  efforts,
  blockedLevel,
  recommendedFamily,
  recommendedApplied,
  forcedOff,
  adaptive,
  clearable,
  onToggle,
  onApplyPreset,
  onClear,
}: DshReasoningLevelsEditorProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  // 已知等级在前（从弱到强），网关自定义的等级名原样接在后面。
  const selected = efforts
    ? [
        ...DSH_REASONING_LEVELS.filter((level) => level in efforts),
        ...Object.keys(efforts).filter(
          (level) =>
            !(DSH_REASONING_LEVELS as readonly string[]).includes(level),
        ),
      ]
    : [];
  const triggerLabel =
    selected.length > 0
      ? formatDshReasoningLevelsLabel(selected)
      : forcedOff
        ? t("dshReasoning.disabled", { defaultValue: "Disabled" })
        : t("dshReasoning.notSet", { defaultValue: "Not set" });

  return (
    <Popover modal={false} open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t("dshReasoning.label", { defaultValue: "Reasoning" })}
          title={triggerLabel}
          className={cn(
            "flex h-8 w-full min-w-0 items-center justify-between gap-1 whitespace-nowrap rounded-md border border-border-default bg-surface px-2 text-caption leading-none transition-colors hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:border-border-strong",
            selected.length === 0 && !forcedOff ? "text-fg-3" : "text-fg-1",
          )}
        >
          <span className="min-w-0 flex-1 truncate text-left">
            {triggerLabel}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={6}
        avoidCollisions
        collisionPadding={8}
        className="z-[1000] w-72 p-1"
      >
        <div
          role="group"
          aria-label={t("dshReasoning.label", { defaultValue: "Reasoning" })}
        >
          {DSH_REASONING_LEVELS.map((level) => {
            const active = !!efforts && level in efforts;
            // 落盘的值可能是 null（不发任何思考参数）或自定义字面值。
            const wire = active ? (efforts?.[level] ?? null) : null;
            const blocked = blockedLevel === level;
            return (
              <button
                key={level}
                type="button"
                role="checkbox"
                aria-checked={active}
                aria-disabled={blocked ? true : undefined}
                data-level={level}
                title={
                  active
                    ? wire === null
                      ? t("dshReasoning.chipSilent", {
                          defaultValue: "No reasoning parameter is sent",
                        })
                      : t("dshReasoning.chipWire", {
                          defaultValue: "Sends: {{wire}}",
                          wire,
                        })
                    : undefined
                }
                onClick={() => {
                  if (blocked) return;
                  onToggle(level);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-control px-2 py-1 text-left text-caption focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active ? "text-fg-1" : "text-fg-2",
                  blocked ? "cursor-not-allowed opacity-60" : "hover:bg-subtle",
                )}
              >
                <Check
                  className={cn(
                    "h-3.5 w-3.5 shrink-0",
                    active ? "text-action-text opacity-100" : "opacity-0",
                  )}
                />
                <span className="flex-1">{level}</span>
                <span
                  aria-hidden="true"
                  className="max-w-32 truncate text-fg-3"
                >
                  {active
                    ? wire === null
                      ? t("dshReasoning.noParam", { defaultValue: "Not sent" })
                      : wire
                    : "—"}
                </span>
              </button>
            );
          })}
        </div>
        {blockedLevel && (
          <p className="px-2 pt-1 pb-0.5 text-caption text-fg-3">
            {t("dshReasoning.keepOne", {
              defaultValue: "At least one level must stay enabled",
            })}
          </p>
        )}
        {(recommendedFamily ||
          forcedOff ||
          adaptive ||
          (clearable && onClear)) && (
          <div className="mt-1 space-y-0.5 border-t border-border-default px-1 pt-1">
            {recommendedFamily && !recommendedApplied && onApplyPreset && (
              <button
                type="button"
                onClick={onApplyPreset}
                className="block w-full rounded-control px-1.5 py-1 text-left text-caption text-action-text hover:bg-subtle hover:underline"
              >
                {t("dshReasoning.applyPreset", {
                  defaultValue: "Use {{family}} preset",
                  family: recommendedFamily,
                })}
              </button>
            )}
            {recommendedFamily && recommendedApplied && (
              <p className="px-1.5 py-1 text-caption text-fg-3">
                {t("dshReasoning.recommended", {
                  defaultValue: "{{family}} preset",
                  family: recommendedFamily,
                })}
              </p>
            )}
            {forcedOff && (
              <p className="px-1.5 py-1 text-caption text-fg-3">
                {t("dshReasoning.forcedOff", {
                  defaultValue: "Reasoning disabled (false)",
                })}
              </p>
            )}
            {adaptive && (
              <p className="px-1.5 py-1 text-caption text-fg-3">
                {t("dshReasoning.adaptive", {
                  defaultValue: "Adaptive thinking on",
                })}
              </p>
            )}
            {clearable && onClear && (
              <button
                type="button"
                onClick={onClear}
                aria-label={t("dshReasoning.clear", {
                  defaultValue: "Clear reasoning levels",
                })}
                className="flex w-full items-center gap-1.5 rounded-control px-1.5 py-1 text-left text-caption text-fg-2 hover:bg-subtle hover:text-fg-1"
              >
                <X className="h-3.5 w-3.5 shrink-0" />
                {t("dshReasoning.clear", {
                  defaultValue: "Clear reasoning levels",
                })}
              </button>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

interface DeepSeekHarnessFormFieldsProps {
  isOfficial: boolean;

  // Provider display name and generation limits
  displayName: string;
  onDisplayNameChange: (value: string) => void;
  reasoningEffort: string;
  onReasoningEffortChange: (value: string) => void;
  maxTokens: string;
  onMaxTokensChange: (value: string) => void;

  // API Key
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  apiKeyEnv: string;
  onApiKeyEnvChange: (value: string) => void;
  category?: ProviderCategory;
  shouldShowApiKeyLink: boolean;
  websiteUrl: string;
  isPartner?: boolean;
  partnerPromotionKey?: string;

  // Base URL
  baseUrl: string;
  onBaseUrlChange: (value: string) => void;

  // API format
  api: string;
  onApiChange: (value: string) => void;

  // Models
  models: DshModel[];
  onModelsChange: (models: DshModel[]) => void;

  // Default model
  defaultModel: string;
  onDefaultModelChange: (value: string) => void;
  /** False for background providers: the backend only applies the default
   * model of the route DSH currently uses, so the field is disabled. */
  isDefaultModelApplicable?: boolean;
}

export function DeepSeekHarnessFormFields({
  isOfficial,
  displayName,
  onDisplayNameChange,
  reasoningEffort,
  onReasoningEffortChange,
  maxTokens,
  onMaxTokensChange,
  apiKey,
  onApiKeyChange,
  apiKeyEnv,
  onApiKeyEnvChange,
  category,
  shouldShowApiKeyLink,
  websiteUrl,
  isPartner,
  partnerPromotionKey,
  baseUrl,
  onBaseUrlChange,
  api,
  onApiChange,
  models,
  onModelsChange,
  defaultModel,
  onDefaultModelChange,
  isDefaultModelApplicable = true,
}: DeepSeekHarnessFormFieldsProps) {
  const { t } = useTranslation();

  const [fetchedModels, setFetchedModels] = useState<FetchedModel[]>([]);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [presetMatchOpen, setPresetMatchOpen] = useState(false);

  /** 点等级行：加/减一个等级；全减完就删掉整个字段（回到「未设置」）。 */
  const handleToggleReasoningLevel = (index: number, level: string) => {
    const model = models[index];
    if (!model) return;
    updateModel(index, {
      reasoningEfforts: toggleDshReasoningLevel(
        model.reasoningEfforts,
        level,
        dshReasoningPresetFor(model.id),
      ),
    });
  };

  /** 「推荐」：套用模型族的推荐等级表；Claude 走 Anthropic 通道时同时开自适应思考。 */
  const handleApplyReasoningPreset = (index: number) => {
    const model = models[index];
    if (!model) return;
    const preset = dshReasoningPresetFor(model.id);
    if (!preset) return;
    const compat: Record<string, unknown> = { ...(model.compat ?? {}) };
    // 插件只在「推荐表要求自适应 + 走 Anthropic 通道」时才写这个开关；
    // 其余情况一律清掉，免得换模型 / 换通道后留着上一条记录的残值。
    if (preset.adaptive && api === "anthropic-messages") {
      compat.forceAdaptiveThinking = true;
    } else {
      delete compat.forceAdaptiveThinking;
    }
    const patch: Partial<DshModel> = {
      reasoningEfforts: orderDshReasoningEfforts(preset.efforts),
      compat: Object.keys(compat).length > 0 ? compat : undefined,
    };
    updateModel(index, patch);
  };

  /** 清掉这一行的 reasoningEfforts（写回「未设置」，不是写 `{}`）。 */
  const handleClearReasoningEfforts = (index: number) => {
    const model = models[index];
    if (!model) return;
    const compat: Record<string, unknown> = { ...(model.compat ?? {}) };
    delete compat.forceAdaptiveThinking;
    updateModel(index, {
      reasoningEfforts: undefined,
      compat: Object.keys(compat).length > 0 ? compat : undefined,
    });
  };

  const handleFetchModels = useCallback(() => {
    if (!baseUrl || !apiKey) {
      showFetchModelsError(null, t, {
        hasApiKey: !!apiKey,
        hasBaseUrl: !!baseUrl,
      });
      return;
    }
    setIsFetchingModels(true);
    fetchModelsForConfig(baseUrl, apiKey)
      .then((models) => {
        setFetchedModels(models);
        if (models.length === 0) {
          toast.info(t("providerForm.fetchModelsEmpty"));
        }
      })
      .catch((err) => {
        console.warn("[ModelFetch] Failed:", err);
        showFetchModelsError(err, t);
      })
      .finally(() => setIsFetchingModels(false));
  }, [baseUrl, apiKey, t]);

  /**
   * 改某一行。值为 `undefined` 的补丁会**删掉**这个键：写进 cordis.patch.yml 的
   * 模型行要么带字段、要么整段省略，不能留下 `reasoningEfforts: {}` / `null`。
   */
  const updateModel = (index: number, patch: Partial<DshModel>) => {
    onModelsChange(
      models.map((model, i) => {
        if (i !== index) return model;
        const next: DshModel = { ...model, ...patch };
        for (const [key, value] of Object.entries(next)) {
          if (value === undefined) delete next[key];
        }
        return next;
      }),
    );
  };

  const removeModel = (index: number) => {
    onModelsChange(models.filter((_, i) => i !== index));
  };

  const addModel = (id = "") => {
    const trimmed = id.trim();
    if (trimmed && models.some((model) => model.id === trimmed)) return;
    onModelsChange([
      ...models,
      { id: trimmed, name: trimmed || undefined, rowKey: nextDshRowKey() },
    ]);
  };

  const handleApplyFetchedModels = useCallback(
    ({ add, remove }: FetchedModelSelection) => {
      const removeSet = new Set(remove.map((id) => id.trim()));
      const next = models.filter((model) => !removeSet.has(model.id.trim()));
      const seen = new Set(next.map((model) => model.id.trim()));
      for (const id of add) {
        const trimmed = id.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        const fetched = fetchedModels.find((model) => model.id === id);
        const contextWindow = (
          fetched as FetchedModel & { contextWindow?: number }
        ).contextWindow;
        const row: DshModel = {
          id: trimmed,
          name: trimmed,
          ...(typeof contextWindow === "number" ? { contextWindow } : {}),
          rowKey: nextDshRowKey(),
        };
        next.push(row);
        seen.add(trimmed);
      }
      const withKeys = withDshRowKeys(next);
      onModelsChange(withKeys);
      if (removeSet.has(defaultModel.trim())) {
        onDefaultModelChange(withKeys[0]?.id ?? "");
      }
    },
    [defaultModel, fetchedModels, models, onDefaultModelChange, onModelsChange],
  );

  return (
    <>
      {/* Provider display name */}
      <div className="space-y-2">
        <FormLabel htmlFor="dsh-display-name">
          {t("deepseekHarness.displayName")}
        </FormLabel>
        <ImeSafeInput
          id="dsh-display-name"
          value={displayName}
          onValueChange={onDisplayNameChange}
          disabled={isOfficial}
          placeholder="Custom DSH"
        />
        <p className="text-xs text-muted-foreground">
          {t("deepseekHarness.displayNameHint")}
        </p>
      </div>

      {/* Generation options */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <FormLabel htmlFor="dsh-reasoning-effort">
            {t("deepseekHarness.reasoningEffort")}
          </FormLabel>
          <Input
            id="dsh-reasoning-effort"
            value={reasoningEffort}
            onChange={(event) => onReasoningEffortChange(event.target.value)}
            placeholder="high"
          />
          <p className="text-xs text-muted-foreground">
            {t("deepseekHarness.reasoningEffortHint")}
          </p>
        </div>
        <div className="space-y-2">
          <FormLabel htmlFor="dsh-max-tokens">
            {t("deepseekHarness.maxTokens")}
          </FormLabel>
          <Input
            id="dsh-max-tokens"
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            value={maxTokens}
            onChange={(event) => onMaxTokensChange(event.target.value)}
            placeholder=""
          />
          <p className="text-xs text-muted-foreground">
            {t("deepseekHarness.maxTokensHint")}
          </p>
        </div>
      </div>

      {/* API Key */}
      {/* The official DeepSeek route has no OAuth login: it requires an API
          key stored under DEEPSEEK_API_KEY, so the input must stay editable
          even though the category is "official". */}
      <ApiKeySection
        id="dsh-api-key"
        value={apiKey}
        onChange={onApiKeyChange}
        category={category}
        disabled={false}
        placeholder={{
          official: t("deepseekHarness.officialApiKeyPlaceholder", {
            defaultValue:
              "Enter the DeepSeek API key (stored in ~/.dsh/.credentials.yaml)",
          }),
          thirdParty: t("providerForm.apiKeyAutoFill", {
            defaultValue: "输入 API Key，将自动填充到配置",
          }),
        }}
        shouldShowLink={shouldShowApiKeyLink}
        websiteUrl={websiteUrl}
        isPartner={isPartner}
        partnerPromotionKey={partnerPromotionKey}
      />

      {/* Credential Ref (custom routes only) */}
      {!isOfficial && (
        <div className="space-y-2">
          <FormLabel htmlFor="dsh-credential-ref">
            {t("deepseekHarness.credentialRef", {
              defaultValue: "Credential Ref",
            })}
          </FormLabel>
          <ImeSafeInput
            id="dsh-credential-ref"
            value={apiKeyEnv}
            onValueChange={(value) => onApiKeyEnvChange(value.toUpperCase())}
            normalize={(value) => value.toUpperCase()}
            placeholder="CUSTOM_DSH_API_KEY"
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">
            {t("deepseekHarness.credentialRefHint", {
              defaultValue:
                "Uppercase identifier used to store the API key in DSH credentials.",
            })}
          </p>
        </div>
      )}

      {/* Base URL */}
      <div className="space-y-2">
        <FormLabel htmlFor="dsh-base-url">
          {t("deepseekHarness.baseUrl", { defaultValue: "Base URL" })}
        </FormLabel>
        <ImeSafeInput
          id="dsh-base-url"
          value={baseUrl}
          onValueChange={onBaseUrlChange}
          placeholder="https://api.example.com/v1"
        />
        <p className="text-xs text-muted-foreground">
          {t("deepseekHarness.baseUrlHint", {
            defaultValue: "The base URL for the API endpoint.",
          })}
        </p>
      </div>

      {/* API Format (custom routes only) */}
      {!isOfficial && (
        <div className="space-y-2">
          <FormLabel htmlFor="dsh-api-format">
            {t("deepseekHarness.apiFormat", { defaultValue: "API Format" })}
          </FormLabel>
          <Select value={api} onValueChange={onApiChange}>
            <SelectTrigger id="dsh-api-format">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DSH_MODEL_API_OPTIONS.map((option) => (
                <SelectItem key={option} value={option}>
                  {t(`deepseekHarness.api_${option.replace(/-/g, "_")}`, {
                    defaultValue: API_FORMAT_LABELS[option] ?? option,
                  })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Model Catalog */}
      <div className="space-y-3 border-l border-border-default pl-3">
        <div className="flex items-center justify-between gap-2">
          <FormLabel>
            {t("deepseekHarness.modelCatalog", {
              defaultValue: "Model Catalog",
            })}
          </FormLabel>
          <div className="flex flex-wrap justify-end gap-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7"
              disabled={!models.some((model) => model.id.trim())}
              onClick={() => setPresetMatchOpen(true)}
            >
              {t("modelPresets.match.open", { defaultValue: "一键匹配预设" })}
            </Button>
            <FetchedModelPicker
              models={fetchedModels}
              configuredModelIds={models.map((model) => model.id)}
              onApply={handleApplyFetchedModels}
              onFetch={handleFetchModels}
              isFetching={isFetchingModels}
              metadataSource={{ baseUrl }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => addModel()}
              className="h-7 gap-1"
            >
              <Plus className="h-3.5 w-3.5" />
              {t("deepseekHarness.addModel", { defaultValue: "Add" })}
            </Button>
          </div>
        </div>

        {presetMatchOpen && (
          <DshModelPresetMatchDialog
            models={models}
            onApply={onModelsChange}
            onClose={() => setPresetMatchOpen(false)}
          />
        )}

        {models.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">
            {t("deepseekHarness.noModels", {
              defaultValue: "No models configured. Click Add to add a model.",
            })}
          </p>
        ) : (
          <div className="space-y-2">
            {/* 列头：与 Codex 的模型目錄一致，md+ 一行一列。 */}
            <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1fr)_140px_minmax(0,1fr)_36px] gap-2 px-2 text-xs text-muted-foreground md:grid">
              <span>
                {t("deepseekHarness.modelName", {
                  defaultValue: "Display Name",
                })}
              </span>
              <span>
                {t("deepseekHarness.modelId", { defaultValue: "Model ID" })}
              </span>
              <span>
                {t("deepseekHarness.contextWindow", {
                  defaultValue: "Context Window",
                })}
              </span>
              <span>
                {t("dshReasoning.label", { defaultValue: "Reasoning" })}
              </span>
              <span />
            </div>
            {models.map((model, index) => {
              // 这一行的推理等级：跟着模型族推荐值走，用户可以逐级微调。
              const recommended = dshReasoningPresetFor(model.id);
              const declared = model.reasoningEfforts;
              const efforts = isDshReasoningEfforts(declared)
                ? (declared as DshReasoningEfforts)
                : undefined;
              const isForcedOff = declared === false;
              const isRecommended =
                !!recommended &&
                !!efforts &&
                dshReasoningEffortsEqual(efforts, recommended.efforts);
              const isAdaptive = model.compat?.forceAdaptiveThinking === true;
              // 只剩最后一个非 off 等级时不允许取消（与插件面板一致）。
              const nonOffLevels = efforts
                ? DSH_REASONING_LEVELS.filter(
                    (level) => level !== "off" && level in efforts,
                  )
                : [];
              const blockedLevel =
                nonOffLevels.length === 1 ? nonOffLevels[0] : undefined;

              return (
                <div
                  key={model.rowKey ?? index}
                  className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_140px_minmax(0,1fr)_36px]"
                >
                  <ImeSafeInput
                    value={model.name ?? ""}
                    onValueChange={(value) =>
                      updateModel(index, { name: value })
                    }
                    placeholder={t("deepseekHarness.modelName", {
                      defaultValue: "Display Name",
                    })}
                  />
                  <div className="flex min-w-0 gap-1">
                    <ImeSafeInput
                      value={model.id}
                      onValueChange={(value) =>
                        updateModel(index, { id: value })
                      }
                      placeholder={t("deepseekHarness.modelId", {
                        defaultValue: "Model ID",
                      })}
                      className="min-w-0 flex-1"
                    />
                    {fetchedModels.length > 0 && (
                      <ModelDropdown
                        models={fetchedModels}
                        onSelect={(id) => {
                          updateModel(index, { id });
                        }}
                      />
                    )}
                  </div>
                  <Input
                    type="number"
                    min={0}
                    step={1}
                    aria-label={t("deepseekHarness.contextWindow", {
                      defaultValue: "Context Window",
                    })}
                    value={model.contextWindow ?? ""}
                    onChange={(event) => {
                      const raw = event.target.value.trim();
                      if (raw === "") {
                        updateModel(index, { contextWindow: undefined });
                        return;
                      }
                      const parsed = Number(raw);
                      if (Number.isFinite(parsed) && parsed >= 0) {
                        updateModel(index, {
                          contextWindow: Math.trunc(parsed),
                        });
                      }
                    }}
                    placeholder="131072"
                    className="w-full"
                  />
                  <DshReasoningLevelsEditor
                    efforts={efforts}
                    blockedLevel={blockedLevel}
                    recommendedFamily={recommended?.family}
                    recommendedApplied={isRecommended}
                    forcedOff={isForcedOff}
                    adaptive={isAdaptive}
                    clearable={!!(efforts || isForcedOff)}
                    onToggle={(level) =>
                      handleToggleReasoningLevel(index, level)
                    }
                    onApplyPreset={() => handleApplyReasoningPreset(index)}
                    onClear={() => handleClearReasoningEfforts(index)}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeModel(index)}
                    aria-label={t("common.remove", {
                      defaultValue: "Remove",
                    })}
                    className="h-8 w-8 justify-self-end text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}

        {/* Default Model */}
        <div className="space-y-2">
          <FormLabel htmlFor="dsh-default-model">
            {t("deepseekHarness.defaultModel", {
              defaultValue: "Default Model",
            })}
          </FormLabel>
          <ImeSafeInput
            id="dsh-default-model"
            value={defaultModel}
            onValueChange={onDefaultModelChange}
            placeholder={models[0]?.id ?? ""}
            disabled={!isDefaultModelApplicable}
          />
          <p className="text-xs text-muted-foreground">
            {isDefaultModelApplicable
              ? t("deepseekHarness.defaultModelHint", {
                  defaultValue: "The model DSH uses by default.",
                })
              : t("deepseekHarness.defaultModelBackgroundHint", {
                  defaultValue:
                    "This provider is not the route DSH currently uses; default-model changes would not apply.",
                })}
          </p>
        </div>
      </div>
    </>
  );
}
