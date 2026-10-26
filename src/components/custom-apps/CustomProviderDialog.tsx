import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Plus, Trash2 } from "lucide-react";
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
import type { Provider } from "@/types";

interface CustomProviderModelRow {
  id: string;
  name: string;
}

interface CustomProviderDialogProps {
  isOpen: boolean;
  provider?: Provider | null;
  pending?: boolean;
  onCancel: () => void;
  onConfirm: (provider: Provider) => void;
}

function providerSettings(provider?: Provider | null): {
  baseURL: string;
  apiKey: string;
  models: CustomProviderModelRow[];
} {
  const settings = provider?.settingsConfig ?? {};
  const rawModels = Array.isArray(settings.models) ? settings.models : [];
  return {
    baseURL: typeof settings.baseURL === "string" ? settings.baseURL : "",
    apiKey: typeof settings.apiKey === "string" ? settings.apiKey : "",
    models: rawModels
      .map((item) => {
        if (typeof item === "string") return { id: item, name: "" };
        const record = item as Record<string, unknown>;
        return {
          id: typeof record.id === "string" ? record.id : "",
          name: typeof record.name === "string" ? record.name : "",
        };
      })
      .filter((item) => item.id.trim().length > 0),
  };
}

export function CustomProviderDialog({
  isOpen,
  provider,
  pending = false,
  onCancel,
  onConfirm,
}: CustomProviderDialogProps) {
  const { t } = useTranslation();
  const [id, setId] = useState("");
  const [idManuallyEdited, setIdManuallyEdited] = useState(false);
  const [name, setName] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<CustomProviderModelRow[]>([
    { id: "", name: "" },
  ]);

  useEffect(() => {
    if (!isOpen) return;
    const parsed = providerSettings(provider);
    setIdManuallyEdited(Boolean(provider));
    setId(provider?.id ?? "");
    setName(provider?.name ?? "");
    setBaseURL(parsed.baseURL);
    setApiKey(parsed.apiKey);
    setModels(
      parsed.models.length > 0 ? parsed.models : [{ id: "", name: "" }],
    );
  }, [isOpen, provider]);

  // 供应商 id 未手动编辑时，从名称自动推导 slug（小写字母数字与连字符）
  useEffect(() => {
    if (idManuallyEdited || provider) return;
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    setId(slug);
  }, [idManuallyEdited, provider, name]);

  const validModels = models
    .map((model) => ({ id: model.id.trim(), name: model.name.trim() }))
    .filter((model) => model.id.length > 0);
  const canSubmit =
    !pending &&
    /^[a-z0-9][a-z0-9-]*$/.test(id.trim()) &&
    name.trim().length > 0 &&
    /^https?:\/\//i.test(baseURL.trim()) &&
    apiKey.trim().length > 0 &&
    validModels.length > 0;

  const submit = () => {
    if (!canSubmit) return;
    onConfirm({
      id: id.trim(),
      name: name.trim(),
      settingsConfig: {
        baseURL: baseURL.trim(),
        apiKey: apiKey.trim(),
        models: validModels.map((model) => ({
          id: model.id,
          name: model.name || model.id,
        })),
      },
      category: "custom",
    });
  };

  const updateModel = (index: number, field: "id" | "name", value: string) => {
    setModels((current) =>
      current.map((model, i) =>
        i === index ? { ...model, [field]: value } : model,
      ),
    );
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
          <div className="grid grid-cols-2 gap-4">
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
            <div className="space-y-2">
              <Label htmlFor="custom-provider-name">
                {t("providerForm.supplierName")}
              </Label>
              <Input
                id="custom-provider-name"
                value={name}
                placeholder={t("providerForm.supplierNamePlaceholder")}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="custom-provider-base-url">
              {t("opencode.baseUrl")}
            </Label>
            <Input
              id="custom-provider-base-url"
              value={baseURL}
              placeholder={t("providerForm.apiEndpointPlaceholder")}
              onChange={(event) => setBaseURL(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="custom-provider-api-key">
              {t("customApps.apiKey")}
            </Label>
            <Input
              id="custom-provider-api-key"
              type="password"
              value={apiKey}
              placeholder={t("customApps.apiKey")}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>{t("opencode.models")}</Label>
              <Button
                type="button"
                variant="quiet"
                size="compact"
                onClick={() =>
                  setModels((current) => [...current, { id: "", name: "" }])
                }
              >
                <Plus className="h-3.5 w-3.5" />
                {t("opencode.addModel")}
              </Button>
            </div>
            <div className="space-y-2">
              {models.map((model, index) => (
                <div
                  className="grid grid-cols-[1fr_1fr_auto] items-center gap-2"
                  key={index}
                >
                  <Input
                    value={model.id}
                    placeholder={t("opencode.modelId")}
                    onChange={(event) =>
                      updateModel(index, "id", event.target.value)
                    }
                  />
                  <Input
                    value={model.name}
                    placeholder={t("opencode.modelName")}
                    onChange={(event) =>
                      updateModel(index, "name", event.target.value)
                    }
                  />
                  <Button
                    type="button"
                    variant="quiet"
                    size="icon-compact"
                    aria-label={t("common.delete")}
                    disabled={models.length <= 1}
                    onClick={() =>
                      setModels((current) =>
                        current.filter((_, i) => i !== index),
                      )
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
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
