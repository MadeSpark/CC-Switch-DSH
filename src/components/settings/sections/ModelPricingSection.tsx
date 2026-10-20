import { useTranslation } from "react-i18next";
import { PricingConfigPanel } from "@/components/usage/PricingConfigPanel";
import { SettingsBlock } from "@/components/settings/SettingsLayout";

/**
 * 设置 →「模型定价」：把用量页里的价格表搬到设置里，让内置单价可被发现和修改。
 * 价格仍然只存一份（model-pricing.json），用量成本继续用同一套数据计算。
 */
export function ModelPricingSection() {
  const { t } = useTranslation();

  return (
    <SettingsBlock
      title={t("settings.modelPricing.title")}
      help={{
        title: t("settings.modelPricing.title"),
        body: t("settings.modelPricing.description"),
      }}
    >
      <PricingConfigPanel />
    </SettingsBlock>
  );
}
