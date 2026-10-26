import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, HelpCircle, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { FormLabel } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { ImeSafeInput } from "@/components/ui/ime-safe-input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
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
  dshReasoningDefaultValue,
  dshReasoningInitialEntries,
  dshReasoningIssue,
  dshReasoningLevelChoices,
  dshReasoningNextLevel,
  dshReasoningWithLevel,
  dshReasoningWithWire,
  formatDshReasoningLevelsLabel,
  formatDshReasoningWire,
  nextDshRowKey,
  readDshReasoningEntries,
  withDshRowKeys,
  type DshModel,
  type DshReasoningEfforts,
  type DshReasoningEntries,
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

/**
 * 模型行栅格。两种路由的列数不同：手写 pi-ai 路由多一列「思考强度」，官方
 * `llm-deepseek` 路由没有这一列。两套任意值都写成字面量常量，Tailwind 才能扫到。
 */
const MODEL_GRID_CUSTOM =
  "md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_140px_minmax(0,1fr)_36px]";
const MODEL_GRID_OFFICIAL =
  "md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_140px_36px]";

interface DshReasoningLevelsEditorProps {
  /**
   * 这一行的原始值：`undefined` 继承目录能力，`false` 声明非推理模型；
   * 落盘里的非法值（`null`、数组、数字等）也原样传进来，由校验标错。
   */
  efforts?: unknown;
  disabled?: boolean;
  /** 写回：`undefined` = 删除字段；对象 = 整张等级表。 */
  onChange: (next: DshReasoningEfforts | undefined) => void;
}

/**
 * 模型级「思考强度」控件，照抄 DSH 44.7 原生设置页：
 * Popover 里一个开关（继承 ⇄ 声明）+ 行编辑器（档位下拉 + API 参数值 + 删除）
 * + 添加档位。开关关掉 = 删除字段（继承目录能力）；打开则播种
 * `off/low/medium/high`（`off` 发 `null`，其余发档位名）。
 * 编辑期允许出现 `{}`、未知档位、空值等中间态，保存前由 `dshReasoningIssue`
 * 硬拦截，这里只负责把它们标出来。
 */
function DshReasoningLevelsEditor({
  efforts,
  disabled = false,
  onChange,
}: DshReasoningLevelsEditorProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // 正在输入的那一行：输入框允许暂时是空串，行数据已经回到档位默认值。
  const [typing, setTyping] = useState<{ index: number; text: string }>();

  const entries = readDshReasoningEntries(efforts);
  const issue = dshReasoningIssue(efforts);
  const usedLevels = entries?.map(([level]) => level) ?? [];
  const nextLevel = dshReasoningNextLevel(usedLevels);
  const issueIndex =
    entries && issue && "level" in issue
      ? entries.findIndex(([level]) => level === issue.level)
      : -1;

  // 摘要：显式 false → 已关闭；没有字段 → 未设置；非法表 → 缺档位提示。
  const summary = !entries
    ? efforts === false
      ? t("dshReasoning.disabled", { defaultValue: "Disabled" })
      : t("dshReasoning.notSet", { defaultValue: "Not set" })
    : issue
      ? t("dshReasoning.needsLevelShort", { defaultValue: "Needs levels" })
      : formatDshReasoningLevelsLabel(usedLevels);

  const issueText = !issue
    ? undefined
    : issue.kind === "valueRequired"
      ? t("dshReasoning.valueRequired", {
          defaultValue: "{{level}} needs a value",
          level: issue.level,
        })
      : issue.kind === "unknownLevel"
        ? t("dshReasoning.unknownLevel", {
            defaultValue: "{{level}} is not a native level",
            level: issue.level,
          })
        : t("dshReasoning.needsLevel", {
            defaultValue: "Keep at least one level other than off",
          });

  const commit = (next: DshReasoningEntries) => {
    setTyping(undefined);
    onChange(Object.fromEntries(next) as DshReasoningEfforts);
  };

  return (
    <Popover modal={false} open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t("dshReasoning.label", { defaultValue: "Reasoning" })}
          title={summary}
          className={cn(
            "flex h-8 w-full min-w-0 items-center justify-between gap-1 whitespace-nowrap rounded-md border border-border-default bg-surface px-2 text-caption leading-none transition-colors hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:border-border-strong",
            issue ? "text-danger-text" : entries ? "text-fg-1" : "text-fg-3",
          )}
        >
          <span className="min-w-0 flex-1 truncate text-left">{summary}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={6}
        avoidCollisions
        collisionPadding={12}
        className="z-[1000] w-[22rem] p-2"
      >
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <span className="text-caption font-medium text-fg-1">
                {t("dshReasoning.label", { defaultValue: "Reasoning" })}
              </span>
              <span title={t("dshReasoning.help", { defaultValue: "" })}>
                <HelpCircle
                  aria-hidden="true"
                  className="h-3.5 w-3.5 shrink-0 text-fg-3"
                />
              </span>
            </div>
            <Switch
              size="sm"
              checked={entries !== undefined}
              disabled={disabled}
              aria-label={t("dshReasoning.label", {
                defaultValue: "Reasoning",
              })}
              onCheckedChange={(checked) => {
                setTyping(undefined);
                onChange(
                  checked
                    ? (Object.fromEntries(
                        dshReasoningInitialEntries(),
                      ) as DshReasoningEfforts)
                    : undefined,
                );
              }}
            />
          </div>

          {entries ? (
            <div className="space-y-1.5">
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2rem] items-center gap-1.5 text-caption text-fg-3">
                <span>
                  {t("dshReasoning.level", { defaultValue: "Level" })}
                </span>
                <span>
                  {t("dshReasoning.value", { defaultValue: "Value" })}
                </span>
                <span />
              </div>
              {entries.map(([level, wire], index) => (
                <div
                  key={`${level}-${index}`}
                  className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2rem] items-center gap-1.5"
                >
                  <select
                    value={level}
                    aria-label={`${t("dshReasoning.level", {
                      defaultValue: "Level",
                    })} ${index + 1}`}
                    aria-invalid={issueIndex === index ? true : undefined}
                    disabled={disabled}
                    onChange={(event) =>
                      commit(
                        dshReasoningWithLevel(
                          entries,
                          index,
                          event.target.value,
                        ),
                      )
                    }
                    className="h-8 w-full min-w-0 rounded-md border border-border-default bg-surface px-1 text-caption text-fg-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {dshReasoningLevelChoices(level, usedLevels).map(
                      (choice) => (
                        <option key={choice} value={choice}>
                          {choice}
                        </option>
                      ),
                    )}
                  </select>
                  <Input
                    value={
                      typing?.index === index
                        ? typing.text
                        : formatDshReasoningWire(wire)
                    }
                    aria-label={`${t("dshReasoning.value", {
                      defaultValue: "Value",
                    })} ${index + 1}`}
                    aria-invalid={issueIndex === index ? true : undefined}
                    disabled={disabled || level === "off"}
                    placeholder={
                      level === "off"
                        ? t("dshReasoning.offPlaceholder", {
                            defaultValue: "Not sent",
                          })
                        : level
                    }
                    onChange={(event) => {
                      const text = event.target.value;
                      setTyping({ index, text });
                      onChange(
                        Object.fromEntries(
                          dshReasoningWithWire(entries, index, text),
                        ) as DshReasoningEfforts,
                      );
                    }}
                    onBlur={() => {
                      // 照抄原生 `leaveValue`（client.js:366-369）：失焦时值仍
                      // 不被接受（例如存量空串 / null / 数字），就回落到该档位
                      // 默认值，别把无法提交的脏值原样留在表单里。
                      setTyping(undefined);
                      const accepted =
                        (typeof wire === "string" && wire.trim() !== "") ||
                        (wire === null && level === "off");
                      if (accepted) return;
                      const next: DshReasoningEntries = entries.map(
                        ([entryLevel, entryWire]) => [entryLevel, entryWire],
                      );
                      next[index] = [level, dshReasoningDefaultValue(level)];
                      onChange(Object.fromEntries(next) as DshReasoningEfforts);
                    }}
                    className="h-8 w-full min-w-0 text-caption"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={disabled}
                    aria-label={t("dshReasoning.removeLevel", {
                      defaultValue: "Remove level",
                    })}
                    title={t("dshReasoning.removeLevel", {
                      defaultValue: "Remove level",
                    })}
                    onClick={() =>
                      commit(entries.filter((_, i) => i !== index))
                    }
                    className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled || nextLevel === undefined}
                onClick={() => {
                  if (nextLevel === undefined) return;
                  commit([
                    ...entries,
                    [nextLevel, dshReasoningDefaultValue(nextLevel)],
                  ]);
                }}
                className="h-7 gap-1 px-1.5 text-caption"
              >
                <Plus className="h-3.5 w-3.5" />
                {t("dshReasoning.addLevel", { defaultValue: "Add level" })}
              </Button>
              {issueText && (
                <p role="alert" className="text-caption text-danger-text">
                  {issueText}
                </p>
              )}
            </div>
          ) : (
            <p className="text-caption text-fg-3">
              {efforts === false
                ? t("dshReasoning.disabled", { defaultValue: "Disabled" })
                : t("dshReasoning.inheritHint", { defaultValue: "" })}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface DeepSeekHarnessFormFieldsProps {
  /** 官方 `llm-deepseek` 路由：models schema 里没有 `reasoningEfforts`，
   * 所以不渲染模型级「思考强度」列。已有的字段原样透传、不被清掉。 */
  isOfficial: boolean;

  // Provider display name and generation limits
  displayName: string;
  onDisplayNameChange: (value: string) => void;
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
  /** 可选的 API 协议；自定义应用聚合入口只暴露 OpenAI Chat。 */
  apiOptions?: readonly string[];

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
  apiOptions = DSH_MODEL_API_OPTIONS,
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
   * 模型行要么带字段、要么整段省略。注意 `reasoningEfforts` 只有「缺省」才表示
   * 继承目录能力，`{}` 是原生 schema 允许的中间态，不能顺手删掉。
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

      {/* Generation options：思考强度已经改为模型级「思考强度」列，这里只剩上限。 */}
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
              {apiOptions.map((option) => (
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
            {/* 列头：与 Codex 的模型目錄一致，md+ 一行一列。官方路由没有
                「思考强度」列（原生 `llm-deepseek` 的 models schema 里没有这个字段）。 */}
            <div
              className={cn(
                "hidden gap-2 px-2 text-xs text-muted-foreground md:grid",
                isOfficial ? MODEL_GRID_OFFICIAL : MODEL_GRID_CUSTOM,
              )}
            >
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
              {!isOfficial && (
                <span>
                  {t("dshReasoning.label", { defaultValue: "Reasoning" })}
                </span>
              )}
              <span />
            </div>
            {models.map((model, index) => {
              return (
                <div
                  key={model.rowKey ?? index}
                  className={cn(
                    "grid grid-cols-1 gap-2",
                    isOfficial ? MODEL_GRID_OFFICIAL : MODEL_GRID_CUSTOM,
                  )}
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
                  {!isOfficial && (
                    <DshReasoningLevelsEditor
                      efforts={model.reasoningEfforts}
                      onChange={(next) =>
                        updateModel(index, { reasoningEfforts: next })
                      }
                    />
                  )}
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
