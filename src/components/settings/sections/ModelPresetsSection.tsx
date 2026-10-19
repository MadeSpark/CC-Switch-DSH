import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Download, Pencil, Plus, Trash2 } from "lucide-react";
import { V7ConfirmDialog, V7Dialog } from "@/components/mcp/formBits";
import { ImportDshModelPresetDialog } from "@/components/model-presets/ImportDshModelPresetDialog";
import {
  SettingsBlock,
  SettingsCard,
  SettingsRow,
  SettingsSwitchRow,
} from "@/components/settings/SettingsLayout";
import { Button } from "@/components/ui/button";
import { DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useModelPresets } from "@/hooks/useModelPresets";
import {
  CUSTOM_REASONING_EFFORT,
  REASONING_EFFORT_OPTIONS,
  describePresetParams,
  isValidModelPattern,
  normalizeModelPattern,
  parseExtraParams,
  readGenericPromptEnabled,
  stringifyExtraParams,
  uniquePresetId,
  writeGenericPromptEnabled,
  type ModelPreset,
  type ModelPresetParams,
} from "@/lib/modelPresets";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/** 思考等级下拉里「不设置」的哨兵值（Radix 的 SelectItem 不能用空字符串）。 */
const DEFAULT_REASONING_EFFORT = "__default__";

interface ParamFieldsDraft {
  contextWindow: string;
  maxOutputTokens: string;
  reasoningEffort: string;
  customReasoningEffort: string;
  temperature: string;
  extraParams: string;
}

interface PresetDraft extends ParamFieldsDraft {
  id: string;
  name: string;
  modelId: string;
  isNew: boolean;
}

type DraftParamsResult =
  | { ok: true; params: ModelPresetParams }
  | { ok: false; reason: "extraParams" };

function isKnownReasoningEffort(value: string): boolean {
  return (REASONING_EFFORT_OPTIONS as readonly string[]).includes(value);
}

function paramFieldsFromParams(
  params?: ModelPresetParams | null,
): ParamFieldsDraft {
  const reasoningEffort = params?.reasoningEffort ?? "";
  return {
    contextWindow:
      params?.contextWindow !== undefined ? String(params.contextWindow) : "",
    maxOutputTokens:
      params?.maxOutputTokens !== undefined
        ? String(params.maxOutputTokens)
        : "",
    reasoningEffort: !reasoningEffort
      ? DEFAULT_REASONING_EFFORT
      : isKnownReasoningEffort(reasoningEffort)
        ? reasoningEffort
        : CUSTOM_REASONING_EFFORT,
    customReasoningEffort:
      reasoningEffort && !isKnownReasoningEffort(reasoningEffort)
        ? reasoningEffort
        : "",
    temperature:
      params?.temperature !== undefined ? String(params.temperature) : "",
    extraParams: stringifyExtraParams(params?.extraParams),
  };
}

function presetDraftFromPreset(preset?: ModelPreset): PresetDraft {
  const fields = paramFieldsFromParams(preset);
  return {
    ...fields,
    id: preset?.id ?? uniquePresetId(),
    name: preset?.name ?? "",
    modelId: preset?.modelId ?? "",
    isNew: preset === undefined,
  };
}

/** 只收正整数（上下文窗口 / 输出上限），非法输入当作没填。 */
function parsePositiveInteger(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.trunc(parsed);
}

/** 温度收 0–2，非法输入当作没填。 */
function parseTemperature(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) return undefined;
  return parsed;
}

function paramsFromDraft(draft: ParamFieldsDraft): DraftParamsResult {
  const extraParams = parseExtraParams(draft.extraParams);
  if (!extraParams.ok) return { ok: false, reason: "extraParams" };

  const params: ModelPresetParams = {};
  const contextWindow = parsePositiveInteger(draft.contextWindow);
  if (contextWindow !== undefined) params.contextWindow = contextWindow;
  const maxOutputTokens = parsePositiveInteger(draft.maxOutputTokens);
  if (maxOutputTokens !== undefined) params.maxOutputTokens = maxOutputTokens;

  if (draft.reasoningEffort === CUSTOM_REASONING_EFFORT) {
    const custom = draft.customReasoningEffort.trim();
    if (custom) params.reasoningEffort = custom;
  } else if (draft.reasoningEffort !== DEFAULT_REASONING_EFFORT) {
    params.reasoningEffort = draft.reasoningEffort;
  }

  const temperature = parseTemperature(draft.temperature);
  if (temperature !== undefined) params.temperature = temperature;
  if (extraParams.value) params.extraParams = extraParams.value;

  return { ok: true, params };
}

function Field({
  label,
  htmlFor,
  hint,
  className,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-body font-medium text-fg-1">
        {label}
      </label>
      {children}
      {hint && <p className="m-0 text-caption text-fg-3">{hint}</p>}
    </div>
  );
}

/** 和预设 / 通用参数共用的参数输入行。 */
function ParamFields({
  idPrefix,
  draft,
  onChange,
}: {
  idPrefix: string;
  draft: ParamFieldsDraft;
  onChange: (patch: Partial<ParamFieldsDraft>) => void;
}) {
  const { t } = useTranslation();
  const isCustomReasoningEffort =
    draft.reasoningEffort === CUSTOM_REASONING_EFFORT;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <Field
          label={t("modelPresets.fields.contextWindow")}
          htmlFor={`${idPrefix}-context-window`}
        >
          <Input
            id={`${idPrefix}-context-window`}
            inputMode="numeric"
            value={draft.contextWindow}
            placeholder="128000"
            onChange={(event) =>
              onChange({ contextWindow: event.target.value })
            }
          />
        </Field>
        <Field
          label={t("modelPresets.fields.maxOutputTokens")}
          htmlFor={`${idPrefix}-max-output-tokens`}
        >
          <Input
            id={`${idPrefix}-max-output-tokens`}
            inputMode="numeric"
            value={draft.maxOutputTokens}
            placeholder="8192"
            onChange={(event) =>
              onChange({ maxOutputTokens: event.target.value })
            }
          />
        </Field>
      </div>

      <Field
        label={t("modelPresets.fields.reasoningEffort")}
        htmlFor={`${idPrefix}-reasoning-effort`}
      >
        <Select
          value={draft.reasoningEffort}
          onValueChange={(value) => onChange({ reasoningEffort: value })}
        >
          <SelectTrigger
            id={`${idPrefix}-reasoning-effort`}
            className="h-8 w-full"
            aria-label={t("modelPresets.fields.reasoningEffort")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_REASONING_EFFORT}>
              {t("modelPresets.reasoningDefault")}
            </SelectItem>
            {REASONING_EFFORT_OPTIONS.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
            <SelectItem value={CUSTOM_REASONING_EFFORT}>
              {t("presetSelector.custom")}
            </SelectItem>
          </SelectContent>
        </Select>
        {isCustomReasoningEffort && (
          <Input
            className="mt-1.5"
            aria-label={`${t("modelPresets.fields.reasoningEffort")} (custom)`}
            value={draft.customReasoningEffort}
            placeholder="xhigh"
            onChange={(event) =>
              onChange({ customReasoningEffort: event.target.value })
            }
          />
        )}
      </Field>

      <Field
        label={t("modelPresets.fields.temperature")}
        htmlFor={`${idPrefix}-temperature`}
      >
        <Input
          id={`${idPrefix}-temperature`}
          inputMode="decimal"
          value={draft.temperature}
          placeholder="0.7"
          onChange={(event) => onChange({ temperature: event.target.value })}
        />
      </Field>

      <Field
        label={t("modelPresets.fields.extraParams")}
        htmlFor={`${idPrefix}-extra-params`}
        hint={t("modelPresets.fields.extraParamsHint")}
      >
        <Textarea
          id={`${idPrefix}-extra-params`}
          className="font-mono text-caption"
          value={draft.extraParams}
          placeholder='{ "key": "value" }'
          onChange={(event) => onChange({ extraParams: event.target.value })}
        />
      </Field>
    </div>
  );
}

/**
 * 设置页「模型预设」分区（需求 5）：按模型 id 预置参数，添加模型时按 id 匹配并询问是否套用。
 * 包含预设列表（添加 / 编辑 / 删除 / 复制）和所有模型共用的通用参数。
 */
export function ModelPresetsSection() {
  const { t } = useTranslation();
  const { presets, generic, save, isSaving, isLoading, isError, refetch } =
    useModelPresets();

  const [editor, setEditor] = useState<PresetDraft | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ModelPreset | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [genericDraft, setGenericDraft] = useState<ParamFieldsDraft>(() =>
    paramFieldsFromParams(generic),
  );
  const [genericPromptEnabled, setGenericPromptEnabled] = useState(() =>
    readGenericPromptEnabled(),
  );

  // 后端数据变了（首次加载 / 保存后）用服务端值刷新通用参数草稿
  useEffect(() => {
    setGenericDraft(paramFieldsFromParams(generic));
  }, [generic]);

  const persist = useCallback(
    async (
      nextPresets: ModelPreset[],
      nextGeneric: ModelPresetParams,
      successMessage: string,
    ): Promise<boolean> => {
      try {
        await save({ presets: nextPresets, generic: nextGeneric });
        toast.success(successMessage);
        return true;
      } catch {
        toast.error(t("modelPresets.saveFailed"));
        return false;
      }
    },
    [save, t],
  );

  const openCreate = useCallback(() => {
    setEditorError(null);
    setEditor(presetDraftFromPreset());
  }, []);

  const openEdit = useCallback((preset: ModelPreset) => {
    setEditorError(null);
    setEditor(presetDraftFromPreset(preset));
  }, []);

  const openDuplicate = useCallback((preset: ModelPreset) => {
    setEditorError(null);
    // 模型 id 必须唯一，所以复制出来的预设留空让用户自己填
    setEditor({
      ...presetDraftFromPreset(preset),
      id: uniquePresetId(),
      modelId: "",
      isNew: true,
    });
  }, []);

  const closeEditor = useCallback(() => {
    setEditor(null);
    setEditorError(null);
  }, []);

  const updateEditor = useCallback((patch: Partial<PresetDraft>) => {
    setEditor((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const handleSavePreset = useCallback(async () => {
    if (!editor) return;
    const modelId = normalizeModelPattern(editor.modelId);
    if (!isValidModelPattern(modelId)) {
      setEditorError(t("modelPresets.invalidModelId"));
      return;
    }
    const duplicated = presets.some(
      (preset) =>
        preset.id !== editor.id &&
        normalizeModelPattern(preset.modelId).toLowerCase() ===
          modelId.toLowerCase(),
    );
    if (duplicated) {
      setEditorError(t("modelPresets.duplicateModelId"));
      return;
    }
    const parsed = paramsFromDraft(editor);
    if (!parsed.ok) {
      setEditorError(t("modelPresets.invalidExtraParams"));
      return;
    }

    const { id, name, isNew } = editor;
    const nextPreset: ModelPreset = {
      id,
      name: name.trim() || modelId,
      modelId,
      ...parsed.params,
    };
    const nextPresets = isNew
      ? [...presets, nextPreset]
      : presets.map((preset) => (preset.id === id ? nextPreset : preset));

    const saved = await persist(nextPresets, generic, t("modelPresets.saved"));
    if (saved) closeEditor();
  }, [closeEditor, editor, generic, persist, presets, t]);

  const handleDeletePreset = useCallback(async () => {
    if (!deleteTarget) return;
    const nextPresets = presets.filter(
      (preset) => preset.id !== deleteTarget.id,
    );
    const saved = await persist(nextPresets, generic, t("modelPresets.saved"));
    if (saved) setDeleteTarget(null);
  }, [deleteTarget, generic, persist, presets, t]);

  const handleSaveGeneric = useCallback(async () => {
    const parsed = paramsFromDraft(genericDraft);
    if (!parsed.ok) {
      toast.error(t("modelPresets.invalidExtraParams"));
      return;
    }
    await persist(presets, parsed.params, t("modelPresets.saved"));
  }, [genericDraft, persist, presets, t]);

  const handleImportPresets = useCallback(
    async (imported: ModelPreset[]): Promise<boolean> => {
      if (isLoading || isError || imported.length === 0) return false;
      return persist(
        [...presets, ...imported],
        generic,
        t("modelPresets.saved"),
      );
    },
    [generic, isLoading, isError, persist, presets, t],
  );

  const handleToggleGenericPrompt = useCallback((enabled: boolean) => {
    setGenericPromptEnabled(enabled);
    writeGenericPromptEnabled(enabled);
  }, []);

  return (
    <>
      <SettingsBlock
        title={t("modelPresets.title")}
        help={{
          title: t("modelPresets.title"),
          body: t("modelPresets.description"),
        }}
        actions={
          <>
            <Button
              type="button"
              variant="neutral"
              size="compact"
              disabled={isSaving || isLoading || isError}
              onClick={() => setImportOpen(true)}
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              {t("modelPresets.import.open", {
                defaultValue: "从已配置供应商导入",
              })}
            </Button>
            <Button
              type="button"
              variant="neutral"
              size="compact"
              disabled={isSaving}
              onClick={openCreate}
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              {t("modelPresets.addPreset")}
            </Button>
          </>
        }
      >
        {isError && (
          <div
            className="flex items-center gap-3 text-caption text-danger-text"
            role="alert"
          >
            <span>
              {t("modelPresets.import.loadPresetsFailed", {
                defaultValue: "读取已有预设失败，请重试后再导入。",
              })}
            </span>
            <Button
              type="button"
              variant="quiet"
              size="compact"
              onClick={refetch}
            >
              {t("modelPresets.import.retry", { defaultValue: "重试" })}
            </Button>
          </div>
        )}
        <SettingsCard>
          {presets.length === 0 ? (
            <SettingsRow
              label={t("modelPresets.empty")}
              description={t("modelPresets.emptyHint")}
            />
          ) : (
            presets.map((preset) => {
              const summary = describePresetParams(preset, t);
              return (
                <SettingsRow
                  key={preset.id}
                  label={
                    <span className="[overflow-wrap:anywhere]">
                      {preset.name}
                    </span>
                  }
                  description={
                    <span className="[overflow-wrap:anywhere]">
                      <span className="font-mono">{preset.modelId}</span>
                      {summary.length > 0 && (
                        <span> · {summary.join(" · ")}</span>
                      )}
                    </span>
                  }
                  control={
                    <>
                      <Button
                        type="button"
                        variant="quiet"
                        size="icon-compact"
                        aria-label={t("modelPresets.editPreset")}
                        title={t("modelPresets.editPreset")}
                        disabled={isSaving}
                        onClick={() => openEdit(preset)}
                      >
                        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="quiet"
                        size="icon-compact"
                        aria-label={t("common.copy")}
                        title={t("common.copy")}
                        disabled={isSaving}
                        onClick={() => openDuplicate(preset)}
                      >
                        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="quiet"
                        size="icon-compact"
                        aria-label={t("modelPresets.deletePreset")}
                        title={t("modelPresets.deletePreset")}
                        disabled={isSaving}
                        onClick={() => setDeleteTarget(preset)}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                    </>
                  }
                />
              );
            })
          )}
        </SettingsCard>
      </SettingsBlock>

      <SettingsBlock
        title={t("modelPresets.genericTitle")}
        help={{
          title: t("modelPresets.genericTitle"),
          body: t("modelPresets.genericHint"),
        }}
        actions={
          <Button
            type="button"
            variant="solid"
            size="compact"
            disabled={isSaving}
            onClick={() => void handleSaveGeneric()}
          >
            {t("modelPresets.save")}
          </Button>
        }
      >
        <SettingsCard>
          <SettingsSwitchRow
            label={t("modelPresets.genericAskToggle")}
            checked={genericPromptEnabled}
            onCheckedChange={handleToggleGenericPrompt}
          />
          <SettingsRow
            label={t("modelPresets.fields.contextWindow")}
            htmlFor="model-preset-generic-context-window"
            control={
              <Input
                id="model-preset-generic-context-window"
                className="w-[180px]"
                inputMode="numeric"
                value={genericDraft.contextWindow}
                placeholder="128000"
                onChange={(event) =>
                  setGenericDraft((prev) => ({
                    ...prev,
                    contextWindow: event.target.value,
                  }))
                }
              />
            }
          />
          <SettingsRow
            label={t("modelPresets.fields.maxOutputTokens")}
            htmlFor="model-preset-generic-max-output-tokens"
            control={
              <Input
                id="model-preset-generic-max-output-tokens"
                className="w-[180px]"
                inputMode="numeric"
                value={genericDraft.maxOutputTokens}
                placeholder="8192"
                onChange={(event) =>
                  setGenericDraft((prev) => ({
                    ...prev,
                    maxOutputTokens: event.target.value,
                  }))
                }
              />
            }
          />
          <SettingsRow
            label={t("modelPresets.fields.reasoningEffort")}
            htmlFor="model-preset-generic-reasoning-effort"
            control={
              <Select
                value={genericDraft.reasoningEffort}
                onValueChange={(value) =>
                  setGenericDraft((prev) => ({
                    ...prev,
                    reasoningEffort: value,
                  }))
                }
              >
                <SelectTrigger
                  id="model-preset-generic-reasoning-effort"
                  className="h-8 w-[180px]"
                  aria-label={t("modelPresets.fields.reasoningEffort")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_REASONING_EFFORT}>
                    {t("modelPresets.reasoningDefault")}
                  </SelectItem>
                  {REASONING_EFFORT_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                  <SelectItem value={CUSTOM_REASONING_EFFORT}>
                    {t("presetSelector.custom")}
                  </SelectItem>
                </SelectContent>
              </Select>
            }
          />
          <SettingsRow
            label={t("modelPresets.fields.temperature")}
            htmlFor="model-preset-generic-temperature"
            control={
              <Input
                id="model-preset-generic-temperature"
                className="w-[180px]"
                inputMode="decimal"
                value={genericDraft.temperature}
                placeholder="0.7"
                onChange={(event) =>
                  setGenericDraft((prev) => ({
                    ...prev,
                    temperature: event.target.value,
                  }))
                }
              />
            }
          />
          <SettingsRow
            label={t("modelPresets.fields.extraParams")}
            htmlFor="model-preset-generic-extra-params"
            description={t("modelPresets.fields.extraParamsHint")}
            children={
              <Textarea
                id="model-preset-generic-extra-params"
                className="font-mono text-caption"
                value={genericDraft.extraParams}
                placeholder='{ "key": "value" }'
                onChange={(event) =>
                  setGenericDraft((prev) => ({
                    ...prev,
                    extraParams: event.target.value,
                  }))
                }
              />
            }
          />
        </SettingsCard>
      </SettingsBlock>

      {editor && (
        <V7Dialog
          open
          width={560}
          onOpenChange={(next) => {
            if (!next) closeEditor();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <DialogTitle className="text-section [overflow-wrap:anywhere]">
              {editor.isNew
                ? t("modelPresets.addPreset")
                : t("modelPresets.editPreset")}
            </DialogTitle>
            <DialogDescription className="text-body text-fg-2">
              {t("modelPresets.fields.modelIdHint")}
            </DialogDescription>
          </div>

          <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto pe-1">
            <Field
              label={t("modelPresets.fields.modelId")}
              htmlFor="model-preset-editor-model-id"
            >
              <Input
                id="model-preset-editor-model-id"
                autoFocus
                className="font-mono"
                value={editor.modelId}
                placeholder="deepseek-v4-*"
                onChange={(event) =>
                  updateEditor({ modelId: event.target.value })
                }
              />
            </Field>
            <Field
              label={t("modelPresets.fields.name")}
              htmlFor="model-preset-editor-name"
            >
              <Input
                id="model-preset-editor-name"
                value={editor.name}
                placeholder={t("modelPresets.fields.modelIdHint")}
                onChange={(event) => updateEditor({ name: event.target.value })}
              />
            </Field>
            <ParamFields
              idPrefix="model-preset-editor"
              draft={editor}
              onChange={updateEditor}
            />
          </div>

          {editorError && (
            <p className="m-0 text-caption text-danger" role="alert">
              {editorError}
            </p>
          )}

          <div className="flex flex-wrap justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="neutral"
              size="regular"
              disabled={isSaving}
              onClick={closeEditor}
            >
              {t("modelPresets.cancel")}
            </Button>
            <Button
              type="button"
              variant="solid"
              size="regular"
              disabled={isSaving}
              onClick={() => void handleSavePreset()}
            >
              {t("modelPresets.save")}
            </Button>
          </div>
        </V7Dialog>
      )}

      <ImportDshModelPresetDialog
        open={importOpen}
        presets={presets}
        isSaving={isSaving}
        onClose={() => setImportOpen(false)}
        onSave={handleImportPresets}
      />

      <V7ConfirmDialog
        open={deleteTarget !== null}
        title={t("modelPresets.deleteConfirmTitle")}
        body={t("modelPresets.deleteConfirmDescription", {
          name: deleteTarget?.name ?? "",
          model: deleteTarget?.modelId ?? "",
        })}
        confirmLabel={t("modelPresets.deletePreset")}
        pending={isSaving}
        onConfirm={() => void handleDeletePreset()}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  );
}
