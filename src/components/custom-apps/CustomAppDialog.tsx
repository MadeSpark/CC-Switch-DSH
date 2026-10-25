import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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
import { IconPicker } from "@/components/IconPicker";
import { DEFAULT_ICON } from "./constants";
import type { CustomApp } from "@/lib/api/customApps";

interface CustomAppDialogProps {
  isOpen: boolean;
  /** 传应用 = 编辑；不传 = 新建 */
  app?: CustomApp | null;
  pending?: boolean;
  onConfirm: (values: {
    name: string;
    icon: string;
    iconColor?: string | null;
  }) => void;
  onCancel: () => void;
}

/**
 * 新建 / 编辑自定义应用：名称必填，图标用共享的 IconPicker。
 * 供应商和模型不在这里配 —— 聚合路由始终指向固定的供应商集合。
 */
export function CustomAppDialog({
  isOpen,
  app,
  pending = false,
  onConfirm,
  onCancel,
}: CustomAppDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<string>(DEFAULT_ICON);

  useEffect(() => {
    if (isOpen) {
      setName(app?.name ?? "");
      setIcon(app?.icon ?? DEFAULT_ICON);
    }
  }, [isOpen, app]);

  const trimmed = name.trim();
  const canSubmit = trimmed.length > 0 && !pending;

  const submit = () => {
    if (!canSubmit) return;
    onConfirm({ name: trimmed, icon, iconColor: null });
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {app
              ? t("customApps.dialog.editTitle")
              : t("customApps.dialog.createTitle")}
          </DialogTitle>
        </DialogHeader>
        <DialogDescription className="sr-only">
          {t("customApps.dialog.routingNote")}
        </DialogDescription>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
          <div className="space-y-2">
            <Label htmlFor="custom-app-name">
              {t("customApps.dialog.nameLabel")}
            </Label>
            <Input
              id="custom-app-name"
              value={name}
              placeholder={t("customApps.dialog.namePlaceholder")}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submit();
              }}
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label>{t("customApps.dialog.iconLabel")}</Label>
            <IconPicker
              value={icon}
              onValueChange={setIcon}
              defaultName={trimmed}
            />
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
            {app ? t("common.save") : t("common.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
