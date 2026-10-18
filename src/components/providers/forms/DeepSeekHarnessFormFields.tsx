import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookmarkPlus, Plus, Sparkles, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { FormLabel } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { ImeSafeInput } from "@/components/ui/ime-safe-input";
import { Button } from "@/components/ui/button";
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
  DSH_PRESET_EXTRAS_KEY,
  DSH_REASONING_LEVELS,
  buildDshPresetExtras,
  dshReasoningEffortsEqual,
  dshReasoningPresetFor,
  isDshReasoningEfforts,
  nextDshRowKey,
  orderDshReasoningEfforts,
  pickDshPresetExtras,
  toggleDshReasoningLevel,
  withDshRowKeys,
  type DshModel,
  type DshReasoningEfforts,
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
  uniquePresetId,
  type ModelPreset,
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
  const {
    presets,
    generic: genericPresetParams,
    save,
    isLoading: presetsLoading,
    isSaving,
  } = useModelPresets();
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
      // DSH 自己的行级参数（每行的 reasoningEfforts / input / compat）存在
      // 预设的 extraParams.dsh 里，套用时还原到命中的模型行上。
      const extras = pickDshPresetExtras(picked.extraParams);
      const rowPatch: Partial<DshModel> = {};
      if (picked.contextWindow !== undefined) {
        rowPatch.contextWindow = picked.contextWindow;
      }
      if (extras.reasoningEfforts !== undefined) {
        rowPatch.reasoningEfforts = extras.reasoningEfforts;
      }
      if (extras.input !== undefined) {
        rowPatch.input = extras.input;
      }
      if (
        index >= 0 &&
        (Object.keys(rowPatch).length > 0 || extras.compat !== undefined)
      ) {
        const compat = extras.compat;
        commitModels(
          rows.map((row, rowIndex) => {
            if (rowIndex !== index) return row;
            const nextRow: DshModel = { ...row, ...rowPatch };
            if (compat) nextRow.compat = { ...(row.compat ?? {}), ...compat };
            return nextRow;
          }),
        );
      }
      if (picked.reasoningEffort !== undefined) {
        reasoningEffortChangeRef.current(picked.reasoningEffort);
      }
      if (picked.maxOutputTokens !== undefined) {
        maxTokensChangeRef.current(String(picked.maxOutputTokens));
      }

      // DSH 表单没有 temperature 的位置；extraParams 里除 dsh 命名空间以外的
      // 键也落不下去：列出来告诉用户哪些被跳过。
      const ignored: string[] = [];
      if (picked.temperature !== undefined) {
        ignored.push(t("modelPresets.paramLabels.temperature"));
      }
      if (
        picked.extraParams !== undefined &&
        Object.keys(picked.extraParams).some(
          (key) => key !== DSH_PRESET_EXTRAS_KEY,
        )
      ) {
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

  /**
   * Provider 级的生成参数（思考等级 / 最大 Tokens）：保存成模型预设时每行都
   * 会带上，这样「刚调好的整套参数」可以整包复原。
   */
  const buildProviderPresetParams = useCallback((): ModelPresetParams => {
    const params: ModelPresetParams = {};
    const effort = reasoningEffort.trim();
    if (effort) params.reasoningEffort = effort;
    const tokens = maxTokens.trim() === "" ? NaN : Number(maxTokens.trim());
    if (Number.isFinite(tokens) && tokens > 0) {
      params.maxOutputTokens = Math.trunc(tokens);
    }
    return params;
  }, [maxTokens, reasoningEffort]);

  /**
   * 一键把当前模型目录保存为模型预设（需求 6）：每个填了模型 id 的行存成一条
   * 预设，模式是这个 id 本身，于是「拉取模型列表 → 逐个调参数 → 一键保存」之后，
   * 以后再添加同名模型就会命中预设并询问是否套用。同名（不分大小写）已存在时
   * 保留原来的 id / 名称，只更新参数。
   */
  const handleSaveAsPresets = useCallback(async () => {
    // 预设还没加载完时不能保存：否则会拿空列表覆盖掉磁盘上已有的预设。
    if (presetsLoading) return;
    const rows = modelsRef.current.filter((row) => row.id.trim() !== "");
    if (rows.length === 0) {
      toast.info(t("dshPreset.noModels"));
      return;
    }

    const providerParams = buildProviderPresetParams();
    const next: ModelPreset[] = [...presets];
    let created = 0;
    let updated = 0;

    for (const row of rows) {
      const modelId = row.id.trim();
      const params: ModelPresetParams = { ...providerParams };
      if (row.contextWindow !== undefined) {
        params.contextWindow = row.contextWindow;
      }
      const extras = buildDshPresetExtras({ ...row, id: modelId });
      if (extras) {
        params.extraParams = { [DSH_PRESET_EXTRAS_KEY]: extras };
      }

      const existingIndex = next.findIndex(
        (preset) =>
          preset.modelId.trim().toLowerCase() === modelId.toLowerCase(),
      );
      if (existingIndex >= 0) {
        const existing = next[existingIndex];
        // 合并而不是整条覆盖：DSH 表单装不下的字段（temperature、旧的
        // contextWindow、其它 app 的 extraParams 命名空间）要留在预设里。
        // `dsh` 命名空间以当前这一行为准（没填就删掉，避免残留旧等级）。
        const extraParams: Record<string, unknown> = {
          ...(existing.extraParams ?? {}),
        };
        delete extraParams[DSH_PRESET_EXTRAS_KEY];
        if (params.extraParams) Object.assign(extraParams, params.extraParams);
        next[existingIndex] = {
          ...existing,
          ...params,
          id: existing.id,
          name: existing.name || modelId,
          modelId: existing.modelId,
        };
        if (Object.keys(extraParams).length > 0) {
          next[existingIndex].extraParams = extraParams;
        } else {
          delete next[existingIndex].extraParams;
        }
        updated += 1;
      } else {
        next.push({
          id: uniquePresetId(),
          name: row.name?.trim() || modelId,
          modelId,
          ...params,
        });
        created += 1;
      }
    }

    try {
      await save({ presets: next, generic: genericPresetParams });
      toast.success(
        updated > 0
          ? t("dshPreset.savedUpdated", { count: created + updated, updated })
          : t("dshPreset.savedNew", { count: created }),
      );
    } catch (error) {
      console.warn("[DSH] Failed to save model presets:", error);
      toast.error(t("dshPreset.saveFailed"));
    }
  }, [
    buildProviderPresetParams,
    genericPresetParams,
    modelsRef,
    presets,
    presetsLoading,
    save,
    t,
  ]);

  /** 把生成参数区里的思考等级 / 最大 Tokens 存成通用参数（合并，不清空别的字段）。 */
  const handleSaveAsDefaults = useCallback(async () => {
    if (presetsLoading) return;
    const params = buildProviderPresetParams();
    if (Object.keys(params).length === 0) {
      toast.info(t("dshPreset.defaultsEmpty"));
      return;
    }
    try {
      await save({ presets, generic: { ...genericPresetParams, ...params } });
      toast.success(t("dshPreset.defaultsSaved"));
    } catch (error) {
      console.warn("[DSH] Failed to save generic preset params:", error);
      toast.error(t("dshPreset.saveFailed"));
    }
  }, [
    buildProviderPresetParams,
    genericPresetParams,
    presets,
    presetsLoading,
    save,
    t,
  ]);

  /** 点等级小胶囊：加/减一个等级；全减完就删掉整个字段（回到「未设置」）。 */
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

      {/* 把上面两个生成参数存成通用参数（合并进已有的通用参数，不动别的字段） */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleSaveAsDefaults}
          disabled={isSaving || presetsLoading}
          title={t("dshPreset.saveDefaultsHint", {
            defaultValue:
              "Store the reasoning effort and max tokens above as default generator options.",
          })}
          className="h-7 gap-1"
        >
          <Sparkles className="h-3.5 w-3.5" />
          {t("dshPreset.saveDefaults", {
            defaultValue: "Save as defaults",
          })}
        </Button>
        <span className="text-xs text-muted-foreground">
          {t("dshPreset.saveDefaultsHintShort", {
            defaultValue: "Applies to newly added models.",
          })}
        </span>
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
            {/* 一键把当前目录（含每行推理等级）存成模型预设，下次加同名模型自动询问 */}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleSaveAsPresets}
              disabled={isSaving || presetsLoading || models.length === 0}
              title={t("dshPreset.saveHint", {
                defaultValue:
                  "Save every model in this catalog (with its reasoning levels) as a model preset.",
              })}
              className="h-7 gap-1"
            >
              <BookmarkPlus className="h-3.5 w-3.5" />
              {t("dshPreset.save", { defaultValue: "Save as preset" })}
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
            <div className="flex items-center gap-2 text-xs text-muted-foreground px-2 mb-1">
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
              const nonOff = efforts
                ? DSH_REASONING_LEVELS.filter(
                    (level) => level !== "off" && level in efforts,
                  ).length
                : 0;

              return (
                <div
                  key={model.rowKey ?? index}
                  className="space-y-1.5 rounded-md border border-border-default px-2 py-1.5"
                >
                  <div className="flex items-center gap-2">
                    <div className="flex min-w-0 flex-1 gap-1">
                      <ImeSafeInput
                        value={model.id}
                        onValueChange={(value) =>
                          updateModel(index, { id: value })
                        }
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
                      onValueChange={(value) =>
                        updateModel(index, { name: value })
                      }
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
                          updateModel(index, {
                            contextWindow: Math.trunc(parsed),
                          });
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
                      aria-label={t("common.remove", {
                        defaultValue: "Remove",
                      })}
                      className="h-9 w-9 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>

                  {/* 推理等级（reasoningEfforts）：点亮的等级会写进模型配置 */}
                  <div className="flex flex-wrap items-center gap-1.5 pl-1">
                    <span className="text-caption text-muted-foreground">
                      {t("dshReasoning.label", { defaultValue: "Reasoning" })}
                    </span>
                    {DSH_REASONING_LEVELS.map((level) => {
                      const active = !!efforts && level in efforts;
                      // 已点亮的等级：标题显示真正落盘的值（可能是 null、none 或
                      // 自定义字面值），不是推荐表里的值；未点亮的不带标题。
                      const stored = active ? (efforts?.[level] ?? null) : null;
                      // 最后一个非 off 等级点不掉，否则会留下空表 / 触发误清空。
                      const removeBlocked =
                        active && level !== "off" && nonOff === 1;
                      return (
                        <button
                          key={level}
                          type="button"
                          aria-pressed={active}
                          disabled={removeBlocked}
                          title={
                            active
                              ? stored === null
                                ? t("dshReasoning.chipSilent", {
                                    defaultValue:
                                      "No reasoning parameter is sent for this level.",
                                  })
                                : t("dshReasoning.chipWire", {
                                    defaultValue: "Sends: {{wire}}",
                                    wire: stored,
                                  })
                              : undefined
                          }
                          onClick={() =>
                            handleToggleReasoningLevel(index, level)
                          }
                          className={cn(
                            "h-6 rounded-full border px-2 text-caption leading-none transition-colors",
                            active
                              ? "border-border-strong bg-subtle font-medium text-fg-1"
                              : "border-border-default text-fg-3 hover:text-fg-1",
                            removeBlocked && "cursor-not-allowed opacity-70",
                          )}
                        >
                          {t(`dshReasoning.level_${level}`, {
                            defaultValue: level,
                          })}
                        </button>
                      );
                    })}
                    {isForcedOff && (
                      <span className="text-caption text-muted-foreground">
                        {t("dshReasoning.forcedOff", {
                          defaultValue: "Reasoning disabled (false)",
                        })}
                      </span>
                    )}
                    {recommended && !isRecommended && (
                      <button
                        type="button"
                        onClick={() => handleApplyReasoningPreset(index)}
                        className="text-caption text-action-text hover:underline"
                      >
                        {t("dshReasoning.applyPreset", {
                          defaultValue: "Use {{family}} preset",
                          family: recommended.family,
                        })}
                      </button>
                    )}
                    {isRecommended && (
                      <span className="text-caption text-muted-foreground">
                        {t("dshReasoning.recommended", {
                          defaultValue: "{{family}} preset",
                          family: recommended.family,
                        })}
                      </span>
                    )}
                    {(efforts || isForcedOff) && (
                      <button
                        type="button"
                        onClick={() => handleClearReasoningEfforts(index)}
                        aria-label={t("dshReasoning.clear", {
                          defaultValue: "Clear reasoning levels",
                        })}
                        className="flex h-6 w-6 items-center justify-center rounded-full text-fg-3 hover:text-fg-1"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                    {isAdaptive && (
                      <span className="text-caption text-muted-foreground">
                        {t("dshReasoning.adaptive", {
                          defaultValue: "Adaptive thinking on",
                        })}
                      </span>
                    )}
                  </div>
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
      {presetPromptDialog}
    </>
  );
}
