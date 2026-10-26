import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FormProvider, useForm } from "react-hook-form";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DeepSeekHarnessFormFields } from "@/components/providers/forms/DeepSeekHarnessFormFields";
import {
  withDshRowKeys,
  type DshModel,
} from "@/components/providers/forms/helpers/deepseekHarnessFormUtils";
import type { Provider } from "@/types";

interface CustomProviderDialogProps {
  isOpen: boolean;
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
  const canSubmit =
    !pending &&
    /^[a-z0-9][a-z0-9-]*$/.test(id.trim()) &&
    displayName.trim().length > 0 &&
    /^https?:\/\//i.test(baseURL.trim()) &&
    apiKey.trim().length > 0 &&
    validModels.length > 0;

  const submit = () => {
    if (!canSubmit) return;
    onConfirm({
      id: id.trim(),
      name: displayName.trim(),
      settingsConfig: {
        baseURL: baseURL.trim(),
        apiKey: apiKey.trim(),
        api,
        apiKeyEnv: apiKeyEnv.trim() || undefined,
        maxTokens: maxTokens.trim() || undefined,
        defaultModel: defaultModel.trim() || undefined,
        models: validModels.map((model) => {
          const { rowKey: _rowKey, id: modelId, name: modelName, ...extra } =
            model;
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
    <Dialog open={isOpen} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {provider ? t("common.edit") : t("provider.addProvider")}
          </DialogTitle>
        </DialogHeader>
        <DialogDescription className="sr-only">
          {t("customApps.dialog.routingNote")}
        </DialogDescription>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
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
        </div>
        <DialogFooter>
          <Button variant="quiet" onClick={onCancel} disabled={pending}>
            {t("common.cancel")}
          </Button>
          <Button variant="solid" onClick={submit} disabled={!canSubmit}>
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
