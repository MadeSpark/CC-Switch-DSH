import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Sparkles, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { FormLabel } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { ImeSafeInput } from "@/components/ui/ime-safe-input";
import { Button } from "@/components/ui/button";
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
  nextDshRowKey,
  withDshRowKeys,
  type DshModel,
} from "./helpers/deepseekHarnessFormUtils";
import {
  FetchedModelPicker,
  type FetchedModelSelection,
} from "./FetchedModelPicker";
import { useCommittableRef, useLatestRef } from "@/hooks/useLatestRef";
import { useModelPresetPrompt } from "@/hooks/useModelPresetPrompt";
import { useModelPresets } from "@/hooks/useModelPresets";
import {
  hasPresetParams,
  pickPresetParams,
  type ModelPresetParams,
} from "@/lib/modelPresets";
import type { ProviderCategory } from "@/types";

const API_FORMAT_LABELS: Record<string, string> = {
  "openai-completions": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
  "anthropic-messages": "Anthropic Messages",
};

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

  // 模型预设（需求 5）：新增或提交模型 id 之后询问是否套用预设参数。
  // DSH 的上下文窗口是行级字段，思考等级 / 最大 tokens 是 provider 级字段，
  // 所以套用时一个写到命中的模型行，另外两个写到表单上方的生成参数里。
  const { offerPresetForModel, dialog: presetPromptDialog } =
    useModelPresetPrompt();
  const { generic: genericPresetParams } = useModelPresets();
  const hasGenericPresetParams = hasPresetParams(genericPresetParams);
  const [modelsRef, commitModels] = useCommittableRef(models, onModelsChange);
  const reasoningEffortChangeRef = useLatestRef(onReasoningEffortChange);
  const maxTokensChangeRef = useLatestRef(onMaxTokensChange);
  const defaultModelRef = useLatestRef(defaultModel);
  /** 同一行同一个模型 id 只询问一次；用户改了 id 可以再问。 */
  const offeredPresetRef = useRef(new Map<string, string>());

  const applyPresetParams = useCallback(
    (
      target: { rowKey?: string; modelId: string },
      params: ModelPresetParams,
    ) => {
      const picked = pickPresetParams(params);
      const rows = modelsRef.current;
      let index = target.rowKey
        ? rows.findIndex((row) => row.rowKey === target.rowKey)
        : -1;
      if (index < 0 && target.modelId.trim()) {
        const wanted = target.modelId.trim();
        index = rows.findIndex((row) => row.id.trim() === wanted);
      }

      // 行可能已经被删掉了，此时只落 provider 级参数，不新建行。
      if (picked.contextWindow !== undefined && index >= 0) {
        const contextWindow = picked.contextWindow;
        commitModels(
          rows.map((row, rowIndex) =>
            rowIndex === index ? { ...row, contextWindow } : row,
          ),
        );
      }
      if (picked.reasoningEffort !== undefined) {
        reasoningEffortChangeRef.current(picked.reasoningEffort);
      }
      if (picked.maxOutputTokens !== undefined) {
        maxTokensChangeRef.current(String(picked.maxOutputTokens));
      }

      // DSH 表单没有 temperature / 透传参数的位置：列出来告诉用户哪些被跳过。
      const ignored: string[] = [];
      if (picked.temperature !== undefined) {
        ignored.push(t("modelPresets.paramLabels.temperature"));
      }
      if (picked.extraParams !== undefined) {
        ignored.push(t("modelPresets.paramLabels.extraParams"));
      }
      if (ignored.length > 0) {
        toast.warning(
          t("modelPresets.prompt.skipped", { params: ignored.join(", ") }),
        );
      } else {
        toast.success(t("modelPresets.prompt.updated"));
      }
    },
    [commitModels, maxTokensChangeRef, modelsRef, reasoningEffortChangeRef, t],
  );

  const offerPresetForRow = useCallback(
    (target: { rowKey?: string; modelId: string }) => {
      const modelId = target.modelId.trim();
      if (!modelId) return;
      const dedupeKey = target.rowKey ?? modelId;
      if (offeredPresetRef.current.get(dedupeKey) === modelId) return;
      const offered = offerPresetForModel(modelId, (params) =>
        applyPresetParams(target, params),
      );
      if (offered) offeredPresetRef.current.set(dedupeKey, modelId);
    },
    [applyPresetParams, offerPresetForModel],
  );

  /** 模型 id 输入框失焦 / 回车时触发询问（读到最新的行数据）。 */
  const commitModelId = useCallback(
    (rowKey: string | undefined, fallbackIndex: number) => {
      const rows = modelsRef.current;
      const row = rowKey
        ? rows.find((item) => item.rowKey === rowKey)
        : rows[fallbackIndex];
      if (!row?.id.trim()) return;
      offerPresetForRow({ rowKey: row.rowKey, modelId: row.id });
    },
    [modelsRef, offerPresetForRow],
  );

  /** 「使用通用参数」按钮：套到默认模型行（没有就第一行）。 */
  const handleApplyGenericPreset = useCallback(() => {
    const rows = modelsRef.current;
    if (rows.length === 0) return;
    const trimmedDefault = defaultModelRef.current.trim();
    const target =
      (trimmedDefault &&
        rows.find((row) => row.id.trim() === trimmedDefault)) ||
      rows[0];
    applyPresetParams(
      { rowKey: target.rowKey, modelId: target.id },
      pickPresetParams(genericPresetParams),
    );
  }, [applyPresetParams, defaultModelRef, genericPresetParams, modelsRef]);

  const [fetchedModels, setFetchedModels] = useState<FetchedModel[]>([]);
  const [isFetchingModels, setIsFetchingModels] = useState(false);

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

  const updateModel = (index: number, patch: Partial<DshModel>) => {
    onModelsChange(
      models.map((model, i) => (i === index ? { ...model, ...patch } : model)),
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
      const added: DshModel[] = [];
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
        added.push(row);
        seen.add(trimmed);
      }
      const withKeys = withDshRowKeys(next);
      onModelsChange(withKeys);
      // 批量勾选时逐个弹询问框太吵，只在恰好新增一个模型时问一次。
      if (added.length === 1) {
        offerPresetForRow({ rowKey: added[0].rowKey, modelId: added[0].id });
      }
      if (removeSet.has(defaultModel.trim())) {
        onDefaultModelChange(withKeys[0]?.id ?? "");
      }
    },
    [
      defaultModel,
      fetchedModels,
      models,
      offerPresetForRow,
      onDefaultModelChange,
      onModelsChange,
    ],
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
          <div className="flex gap-1">
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
            {hasGenericPresetParams && models.length > 0 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleApplyGenericPreset}
                title={t("modelPresets.genericHint")}
                className="h-7 gap-1"
              >
                <Sparkles className="h-3.5 w-3.5" />
                {t("modelPresets.prompt.applyGeneric")}
              </Button>
            )}
          </div>
        </div>

        {models.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">
            {t("deepseekHarness.noModels", {
              defaultValue: "No models configured. Click Add to add a model.",
            })}
          </p>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground px-1 mb-1">
              <span className="flex-1">
                {t("deepseekHarness.modelId", { defaultValue: "Model ID" })}
              </span>
              <span className="flex-1">
                {t("deepseekHarness.modelName", {
                  defaultValue: "Display Name",
                })}
              </span>
              <span className="w-32">
                {t("deepseekHarness.contextWindow", {
                  defaultValue: "Context Window",
                })}
              </span>
              <span className="w-9" />
            </div>
            {models.map((model, index) => (
              <div
                key={model.rowKey ?? index}
                className="flex items-center gap-2"
              >
                <div className="flex min-w-0 flex-1 gap-1">
                  <ImeSafeInput
                    value={model.id}
                    onValueChange={(value) => updateModel(index, { id: value })}
                    onBlur={() => commitModelId(model.rowKey, index)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      commitModelId(model.rowKey, index);
                    }}
                    placeholder={t("deepseekHarness.modelId", {
                      defaultValue: "Model ID",
                    })}
                    className="flex-1"
                  />
                  {fetchedModels.length > 0 && (
                    <ModelDropdown
                      models={fetchedModels}
                      onSelect={(id) => {
                        updateModel(index, { id });
                        offerPresetForRow({
                          rowKey: model.rowKey,
                          modelId: id,
                        });
                      }}
                    />
                  )}
                </div>
                <ImeSafeInput
                  value={model.name ?? ""}
                  onValueChange={(value) => updateModel(index, { name: value })}
                  placeholder={t("deepseekHarness.modelName", {
                    defaultValue: "Display Name",
                  })}
                  className="flex-1"
                />
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
                      updateModel(index, { contextWindow: Math.trunc(parsed) });
                    }
                  }}
                  placeholder="131072"
                  className="w-32"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => removeModel(index)}
                  aria-label={t("common.remove", { defaultValue: "Remove" })}
                  className="h-9 w-9 text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
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
      {presetPromptDialog}
    </>
  );
}
