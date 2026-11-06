import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FormProvider, useForm } from "react-hook-form";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FullScreenPanel } from "@/components/common/FullScreenPanel";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DeepSeekHarnessFormFields } from "@/components/providers/forms/DeepSeekHarnessFormFields";
import {
  findDshReasoningIssue,
  withDshRowKeys,
  type DshModel,
} from "@/components/providers/forms/helpers/deepseekHarnessFormUtils";
import { toast } from "@/lib/toast";
import type { Provider } from "@/types";

interface CustomProviderDialogProps {
  isOpen: boolean;
  appName: string;
  provider?: Provider | null;
  pending?: boolean;
  onCancel: () => void;
  onConfirm: (provider: Provider) => void;
}

const CUSTOM_API_OPTIONS = ["openai-completions"] as const;

function readModels(provider?: Provider | null): DshModel[] {
  const raw = provider?.settingsConfig?.models;
  if (!Array.isArray(raw)) return [];
  return withDshRowKeys(
    raw
      .map((item) => {
        if (typeof item === "string") return { id: item, name: "" };
        const record = item as Record<string, unknown>;
        return {
          id: typeof record.id === "string" ? record.id : "",
          name: typeof record.name === "string" ? record.name : "",
          contextWindow:
            typeof record.contextWindow === "number"
              ? record.contextWindow
              : undefined,
          // 非法档位表也必须带回表单，否则打开编辑再保存会把脏值静默洗掉。
          reasoningEfforts: record.reasoningEfforts,
        };
      })
      .filter((item) => item.id.trim().length > 0),
  );
}

function readString(settings: unknown, key: string): string {
  if (!settings || typeof settings !== "object") return "";
  const value = (settings as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

export function CustomProviderDialog({
  isOpen,
  appName,
  provider,
  pending = false,
  onCancel,
  onConfirm,
}: CustomProviderDialogProps) {
  const { t } = useTranslation();
  const form = useForm();
  const [id, setId] = useState("");
  const [idManuallyEdited, setIdManuallyEdited] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyEnv, setApiKeyEnv] = useState("");
  const [api, setApi] = useState("openai-completions");
  const [maxTokens, setMaxTokens] = useState("");
  const [models, setModels] = useState<DshModel[]>([]);
  const [defaultModel, setDefaultModel] = useState("");

  useEffect(() => {
    if (!isOpen) return;
    const settings = provider?.settingsConfig;
    setId(provider?.id ?? "");
    setIdManuallyEdited(false);
    setDisplayName(provider?.name ?? "");
    setBaseURL(readString(settings, "baseURL"));
    setApiKey(readString(settings, "apiKey"));
    setApiKeyEnv(readString(settings, "apiKeyEnv"));
    setApi(
      readString(settings, "api") === "openai-completions"
        ? "openai-completions"
        : "openai-completions",
    );
    setMaxTokens(readString(settings, "maxTokens"));
    const parsedModels = readModels(provider);
    setModels(parsedModels);
    setDefaultModel(
      typeof settings?.defaultModel === "string"
        ? settings.defaultModel
        : (parsedModels[0]?.id ?? ""),
    );
  }, [isOpen, provider]);

  // 新供应商的 ID 跟随名称；用户手动改过 ID 后不再覆盖。
  useEffect(() => {
    if (idManuallyEdited || provider) return;
    const slug = displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    setId(slug);
  }, [displayName, idManuallyEdited, provider]);

  const validModels = models.filter((model) => model.id.trim().length > 0);
  const normalizedId = id.trim().toLowerCase();
  const canSubmit =
    !pending &&
    /^[a-z0-9][a-z0-9-]*$/.test(normalizedId) &&
    displayName.trim().length > 0 &&
    /^https?:\/\//i.test(baseURL.trim()) &&
    apiKey.trim().length > 0 &&
    validModels.length > 0;

  const submit = () => {
    if (!canSubmit) return;
    const reasoningIssue = findDshReasoningIssue(validModels);
    if (reasoningIssue) {
      const { issue } = reasoningIssue;
      const reason =
        issue.kind === "needsLevel"
          ? t("dshReasoning.needsLevel", {
              defaultValue:
                "Add at least one level other than Off; turn reasoning off if the model should not think.",
            })
          : issue.kind === "valueRequired"
            ? t("dshReasoning.valueRequired", { level: issue.level })
            : t("dshReasoning.unknownLevel", { level: issue.level });
      toast.error(
        t("deepseekHarness.reasoningInvalid", {
          model: reasoningIssue.modelId || t("deepseekHarness.unnamedModel"),
          reason,
        }),
      );
      return;
    }
    onConfirm({
      id: normalizedId,
      name: displayName.trim(),
      settingsConfig: {
        baseURL: baseURL.trim(),
        apiKey: apiKey.trim(),
        api,
        apiKeyEnv: apiKeyEnv.trim() || undefined,
        maxTokens: maxTokens.trim() || undefined,
        defaultModel: defaultModel.trim() || undefined,
        models: validModels.map((model) => {
          const {
            rowKey: _rowKey,
            id: modelId,
            name: modelName,
            ...extra
          } = model;
          return {
            ...extra,
            id: modelId.trim(),
            name: (modelName ?? "").trim() || modelId.trim(),
          };
        }),
      },
      category: "custom",
    });
  };

  return (
    <FullScreenPanel
      isOpen={isOpen}
      trackUnsavedChanges
      title={
        provider
          ? t("provider.editProviderNamed", { name: provider.name })
          : t("provider.addNewProvider")
      }
      subtitle={appName}
      backLabel={t("provider.backToList")}
      onClose={onCancel}
      contentClassName="pt-4"
      footer={
        <>
          <Button
            type="button"
            variant="neutral"
            size="regular"
            onClick={onCancel}
            disabled={pending}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            form="custom-provider-form"
            variant="solid"
            size="regular"
            disabled={!canSubmit}
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {t("common.save")}
          </Button>
        </>
      }
    >
      <form
        id="custom-provider-form"
        className="space-y-6"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="custom-provider-id">
            {t("opencode.providerKey")}
          </Label>
          <Input
            id="custom-provider-id"
            value={id}
            placeholder={t("opencode.providerKeyPlaceholder")}
            onChange={(event) => {
              setIdManuallyEdited(true);
              setId(event.target.value);
            }}
            onBlur={(event) =>
              setId(event.currentTarget.value.trim().toLowerCase())
            }
            disabled={Boolean(provider)}
          />
        </div>
        <FormProvider {...form}>
          <DeepSeekHarnessFormFields
            isOfficial={false}
            displayName={displayName}
            onDisplayNameChange={setDisplayName}
            maxTokens={maxTokens}
            onMaxTokensChange={setMaxTokens}
            apiKey={apiKey}
            onApiKeyChange={setApiKey}
            apiKeyEnv={apiKeyEnv}
            onApiKeyEnvChange={setApiKeyEnv}
            category="custom"
            shouldShowApiKeyLink={false}
            websiteUrl=""
            baseUrl={baseURL}
            onBaseUrlChange={setBaseURL}
            api={api}
            onApiChange={setApi}
            apiOptions={CUSTOM_API_OPTIONS}
            models={models}
            onModelsChange={(next) => {
              setModels(next);
              if (!next.some((model) => model.id.trim() === defaultModel)) {
                setDefaultModel(
                  next.find((model) => model.id.trim())?.id ?? "",
                );
              }
            }}
            defaultModel={defaultModel}
            onDefaultModelChange={setDefaultModel}
            isDefaultModelApplicable={false}
          />
        </FormProvider>
        <p className="text-xs text-fg-3">
          {t("customApps.dialog.routingNote")}
        </p>
      </form>
    </FullScreenPanel>
  );
}
