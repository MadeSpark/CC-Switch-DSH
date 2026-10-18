import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { AppGlyph } from "@/components/shell/AppGlyph";
import { ProviderIcon } from "@/components/ProviderIcon";

/**
 * 很多内置图标的 SVG 自带 `<title>DeepSeek</title>` 这类文本节点。AppGlyph 是
 * 纯装饰用法（名字由旁边的文字或按钮的 aria-label 提供），把 `<title>` 一起塞进
 * DOM 会让同一屏出现两个同名文本节点 —— 读屏会重复播报，按文本查询也会撞车。
 */
describe("AppGlyph decorative icons", () => {
  it("does not leak the icon's own <title> into the DOM", () => {
    const { container } = render(<AppGlyph app="deepseek-harness" />);
    expect(container.querySelector("svg title")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("still renders the icon artwork itself", () => {
    const { container } = render(<AppGlyph app="deepseek-harness" />);
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelector("svg path")).not.toBeNull();
  });

  it("keeps the <title> for named icons that show it as their label", () => {
    const { container } = render(
      <ProviderIcon icon="deepseek" name="DeepSeek" />,
    );
    expect(container.querySelector("svg title")?.textContent).toBe("DeepSeek");
  });
});
