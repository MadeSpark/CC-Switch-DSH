import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, HelpCircle, Plus, Trash2 } from "lucide-react";
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
  dshReasoningDefaultValue,
  dshReasoningIssue,
  dshReasoningMode,
  dshReasoningToggleLevel,
  dshReasoningWithMode,
  dshReasoningWithWire,
  formatDshReasoningLevelsLabel,
  formatDshReasoningWire,
  nextDshRowKey,
  readDshReasoningEntries,
  withDshRowKeys,
  type DshModel,
  type DshReasoningEfforts,
  type DshReasoningEntries,
  type DshReasoningLevel,
  type DshReasoningMode,
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
 * 模型级「思考强度」控件：Popover 里一个模式下拉（跟随目录 / 不支持思考 /
 * 自定义档位）+ 档位芯片（点选即增删，顺序由 `dshReasoningToggleLevel` 保证）
 * + 默认收起的「高级：API 参数值」行编辑器。「跟随」= 删除字段；「不支持思考」
 * = 写 `false`（原生显式禁用）；自定义则播种 `off/low/medium/high`（`off`
 * 发 `null`，其余发档位名）。切到自定义时已是普通对象就原样保留（含非法对象，
 * 不在此修复）；编辑期中间态由 `dshReasoningIssue` 在保存前硬拦截。
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
  // 「高级：API 参数值」折叠区，默认收起。
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const entries = readDshReasoningEntries(efforts);
  const mode = dshReasoningMode(efforts);
  const issue = dshReasoningIssue(efforts);
  const issueIndex =
    entries && issue && "level" in issue
      ? entries.findIndex(([level]) => level === issue.level)
      : -1;

  // 摘要：没有字段 → 未设置；显式 false → 已关闭；非普通对象的其余脏值
  // （null/数组/标量，原生判非法而非继承）→ 缺档位提示并标红；普通对象沿用
  // issue/档位列表逻辑。
  const summary =
    efforts === undefined
      ? t("dshReasoning.notSet", { defaultValue: "Not set" })
      : efforts === false
        ? t("dshReasoning.disabled", { defaultValue: "Disabled" })
        : !entries || issue
          ? t("dshReasoning.needsLevelShort", { defaultValue: "Needs levels" })
          : formatDshReasoningLevelsLabel(entries.map(([level]) => level));

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
          </div>

          <Select
            value={mode}
            onValueChange={(nextMode) => {
              setTyping(undefined);
              setAdvancedOpen(false);
              onChange(
                dshReasoningWithMode(efforts, nextMode as DshReasoningMode),
              );
            }}
          >
            <SelectTrigger
              aria-label={t("dshReasoning.mode", { defaultValue: "Mode" })}
              disabled={disabled}
              className="h-8 w-full text-caption"
            >
              <SelectValue />
            </SelectTrigger>
            {/* 必须盖过外层 z-[1000] 的 Popover：SelectContent 默认的
                z-[100] 会在下拉向上翻转时把选项画到面板后面。 */}
            <SelectContent className="z-[1100]">
              <SelectItem value="inherit">
                {t("dshReasoning.modeInherit", {
                  defaultValue: "Follow model catalog (default)",
                })}
              </SelectItem>
              <SelectItem value="disabled">
                {t("dshReasoning.modeDisabled", {
                  defaultValue: "No reasoning",
                })}
              </SelectItem>
              <SelectItem value="custom">
                {t("dshReasoning.modeCustom", {
                  defaultValue: "Custom levels",
                })}
              </SelectItem>
            </SelectContent>
          </Select>

          {entries ? (
            <div className="space-y-1.5">
              <div className="space-y-1">
                <p className="text-caption text-fg-3">
                  {t("dshReasoning.levels", {
                    defaultValue: "Available levels",
                  })}
                </p>
                <p className="text-caption text-fg-3">
                  {t("dshReasoning.levelsHint", {
                    defaultValue:
                      "Click to toggle; order follows the canonical level order.",
                  })}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {/* 七档标准芯片 + 存量里的未知/非法档位键（后者以选中态展示，
                      点击即移除；行内仍会由 dshReasoningIssue 报 unknownLevel）。 */}
                  {[
                    ...DSH_REASONING_LEVELS,
                    ...entries
                      .map(([level]) => level)
                      .filter(
                        (level) =>
                          !(DSH_REASONING_LEVELS as readonly string[]).includes(
                            level,
                          ),
                      ),
                  ].map((level) => {
                    const selected = entries.some(([key]) => key === level);
                    return (
                      <button
                        key={level}
                        type="button"
                        aria-pressed={selected}
                        aria-label={level}
                        disabled={disabled}
                        onClick={() =>
                          // 未知档位键不在 DshReasoningLevel 联合里，但
                          // dshReasoningToggleLevel 本就支持移除任意存量键。
                          commit(
                            dshReasoningToggleLevel(
                              entries,
                              level as DshReasoningLevel,
                            ),
                          )
                        }
                        className={cn(
                          "h-7 rounded-md border px-2 text-caption",
                          selected
                            ? "border-primary bg-primary/10 text-fg-1"
                            : "border-border-default text-fg-3 hover:border-border-strong",
                        )}
                      >
                        {level}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-1">
                <button
                  type="button"
                  aria-expanded={advancedOpen}
                  onClick={() => setAdvancedOpen(!advancedOpen)}
                  className="flex items-center gap-1 text-caption text-fg-3 hover:text-fg-1"
                >
                  <ChevronDown
                    className={cn(
                      "h-3.5 w-3.5 transition-transform",
                      advancedOpen && "rotate-180",
                    )}
                  />
                  {t("dshReasoning.advanced", {
                    defaultValue: "Advanced: API parameter values",
                  })}
                </button>
                {advancedOpen && (
                  <div className="space-y-1.5">
                    {entries.map(([level, wire], index) => (
                      <div
                        key={`${level}-${index}`}
                        className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-1.5"
                      >
                        <span className="min-w-0 truncate text-caption text-fg-1">
                          {level}
                        </span>
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
                              (typeof wire === "string" &&
                                wire.trim() !== "") ||
                              (wire === null && level === "off");
                            if (accepted) return;
                            const next: DshReasoningEntries = entries.map(
                              ([entryLevel, entryWire]) => [
                                entryLevel,
                                entryWire,
                              ],
                            );
                            next[index] = [
                              level,
                              dshReasoningDefaultValue(level),
                            ];
                            onChange(
                              Object.fromEntries(next) as DshReasoningEfforts,
                            );
                          }}
                          className="h-8 w-full min-w-0 text-caption"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {issueText && (
                <p role="alert" className="text-caption text-danger-text">
                  {issueText}
                </p>
              )}
            </div>
          ) : efforts === undefined || efforts === false ? (
            // 没有字段 = 继承目录能力；false = 显式禁用。二者都不是脏值。
            <p className="text-caption text-fg-3">
              {efforts === undefined
                ? t("dshReasoning.inheritHint")
                : t("dshReasoning.disabled", { defaultValue: "Disabled" })}
            </p>
          ) : (
            // 其余无 entries 的值都是非普通对象脏值（null/数组/标量）：原生
            // 对 null 判非法而不是继承，这里照 needsLevel 显式标错。
            <p role="alert" className="text-caption text-danger-text">
              {issueText}
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
