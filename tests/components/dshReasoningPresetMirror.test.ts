/**
 * 镜像契约测试：CC Switch 的 `dshReasoningPresetFor()` 必须与 DSH 插件
 * `dsh-desktop-ui-reasoning-effort@0.1.2` 的 `presetFor()` 逐键一致。
 *
 * ── 出处 ────────────────────────────────────────────────────────────
 * 下面的 `effortsOf` / `preset` / `atLeast` / `normalizeModelId` / `presetFor`
 * 逐行抄自
 *   ~/.dsh/profiles/desktop/node_modules/dsh-desktop-ui-reasoning-effort/lib/client.js:108-222
 * 只补了 TypeScript 类型标注，没有改逻辑、没有换正则、没有重排分支——这就是
 * 「照抄照搬的对照表」，实现侧改坏了这里必须红。
 *
 * 用途仅限测试夹具：不要从业务代码里 import 这些函数，也不要拿它们当实现。
 */
import { describe, expect, it } from "vitest";
import { dshReasoningPresetFor } from "@/components/providers/forms/helpers/deepseekHarnessFormUtils";

// ── 以下为插件原文镜像（client.js:108-222）────────────────────────────

/** @see client.js:108-115 */
function effortsOf(spec: string): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const part of spec.split(",")) {
    const [level, wire] = part.split("=");
    out[level] = wire !== undefined ? wire : level === "off" ? null : level;
  }
  return out;
}

/** @see client.js:117-119 */
function preset(
  family: string,
  spec: string,
  adaptive?: boolean,
): {
  family: string;
  efforts: Record<string, string | null>;
  adaptive: boolean;
} {
  return { family, efforts: effortsOf(spec), adaptive: adaptive === true };
}

/** @see client.js:121-124 */
function atLeast(major: number, minor: number, a: number, b: number): boolean {
  return major > a || (major === a && minor >= b);
}

/** @see client.js:132-145 */
function normalizeModelId(id: string): string {
  let s = String(id).trim().toLowerCase();
  s = s.slice(s.lastIndexOf("/") + 1);
  s = s.replace(/[:@].*$/, "");
  let previous: string;
  do {
    previous = s;
    s = s.replace(
      /-(?:thinking|nothinking|openai-compact|compact|preview|exp|\d{8}|\d{4}-\d{2}-\d{2})$/,
      "",
    );
  } while (s !== previous);
  s = s.replace(
    /^claude-(opus|sonnet|haiku|fable)-(\d+)\.(\d+)/,
    "claude-$1-$2-$3",
  );
  s = s.replace(/^(grok|glm)-(\d+)-(\d+)(?=-|$)/, "$1-$2.$3");
  s = s.replace(/^claude-3\.7-/, "claude-3-7-");
  return s;
}

/** @see client.js:154-222 */
function presetFor(id: string): {
  family: string;
  efforts: Record<string, string | null>;
  adaptive: boolean;
} | null {
  const n = normalizeModelId(id);
  let m: RegExpExecArray | null;

  if ((m = /^gpt-(\d+)(?:\.(\d+))?(.*)$/.exec(n)) !== null) {
    const major = Number(m[1]);
    const minor = m[2] === undefined ? 0 : Number(m[2]);
    const rest = m[3];
    const at = (a: number, b: number) => atLeast(major, minor, a, b);
    if (!at(5, 0)) return null;
    if (/^-chat(?:-|$)/.test(rest))
      return major === 5 && minor === 2 ? preset("GPT", "medium,xhigh") : null;
    if (/-pro(?:-|$)/.test(rest))
      return preset("GPT", at(5, 2) ? "medium,high,xhigh" : "high");
    if (/-codex-spark(?:-|$)/.test(rest))
      return preset("GPT", "low,medium,high,xhigh");
    if (at(6, 0))
      return preset(
        "GPT",
        /astra/.test(rest)
          ? "low,medium,high,xhigh,max"
          : "off=none,low,medium,high,xhigh,max",
      );
    if (at(5, 6)) return preset("GPT", "off=none,low,medium,high,xhigh,max");
    if (at(5, 2)) return preset("GPT", "off=none,low,medium,high,xhigh");
    if (at(5, 1)) return preset("GPT", "off=none,low,medium,high");
    return preset("GPT", "minimal,low,medium,high");
  }

  if (/^gpt-oss(?:-|$)/.test(n)) return preset("GPT", "low,medium,high");
  if (/^o[134](?:-|$)/.test(n)) return preset("OpenAI o", "low,medium,high");

  if (
    (m = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(
      n,
    )) !== null
  ) {
    const tier = m[1];
    const major = Number(m[2]);
    const minor = m[3] === undefined ? 0 : Number(m[3]);
    const at = (a: number, b: number) => atLeast(major, minor, a, b);
    if (tier === "fable" || (tier === "opus" && at(5, 0)))
      return preset("Claude", "low,medium,high,xhigh,max", true);
    if (at(4, 7))
      return preset("Claude", "off,low,medium,high,xhigh,max", true);
    if (at(4, 6)) return preset("Claude", "off,low,medium,high,max", true);
    if (at(4, 0) && (tier !== "haiku" || at(4, 5)))
      return preset("Claude", "off,low,medium,high");
    return null;
  }
  if (/^claude-3-7-sonnet(?:-|$)/.test(n))
    return preset("Claude", "off,low,medium,high");

  if ((m = /^grok-(\d+)(?:\.(\d+))?(.*)$/.exec(n)) !== null) {
    const major = Number(m[1]);
    const minor = m[2] === undefined ? 0 : Number(m[2]);
    const rest = m[3];
    const at = (a: number, b: number) => atLeast(major, minor, a, b);
    // Grok 4.1/4.2 Fast Reasoning and Mini expose only low/high.
    if (at(4, 1) && !at(4, 3) && /(?:fast|mini|reasoning)/.test(rest))
      return preset("Grok", "low,high");
    if (at(4, 6)) return preset("Grok", "low,medium,high,xhigh");
    if (at(4, 5)) return preset("Grok", "low,medium,high");
    if (at(4, 3)) return preset("Grok", "off=none,low,medium,high");
    if (at(4, 1)) return preset("Grok", "low,medium,high");
    if (major === 3 && /mini/.test(rest)) return preset("Grok", "low,high");
    return null;
  }

  if ((m = /^glm-(\d+)(?:\.(\d+))?/.exec(n)) !== null) {
    const major = Number(m[1]);
    const minor = m[2] === undefined ? 0 : Number(m[2]);
    const at = (a: number, b: number) => atLeast(major, minor, a, b);
    if (at(5, 3)) return preset("GLM", "low,high,max");
    if (at(5, 2)) return preset("GLM", "off=none,high,max");
    if (at(4, 5)) return preset("GLM", "off,minimal,low,medium,high");
    return null;
  }

  if ((m = /^(?:xiaomi-)?mimo-v(\d+)(?:\.(\d+))?/.exec(n)) !== null) {
    const major = Number(m[1]);
    const minor = m[2] === undefined ? 0 : Number(m[2]);
    return atLeast(major, minor, 2, 5)
      ? preset("MiMo", "off,minimal,low,medium,high")
      : null;
  }

  return null;
}

// ── 语料：覆盖每一族的所有分支 + 别名 / 后缀 / 供应商前缀 / 未知模型 ──

const CORPUS: string[] = [
  // GPT：5.0 / 5.1 / 5.2 / 5.6 / 6.x 的每一档，以及 -chat / -pro / -codex-spark
  "gpt-5",
  "gpt-5.0",
  "gpt-5.1",
  "gpt-5.2",
  "gpt-5.6",
  "gpt-5-chat",
  "gpt-5.2-chat",
  "gpt-5-pro",
  "gpt-5.1-pro",
  "gpt-5.2-pro",
  "gpt-5-codex-spark",
  "gpt-6",
  "gpt-6.1",
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-4o",
  "gpt-4.1",
  "gpt-oss-120b",
  "gpt-oss",
  // OpenAI o 系列（正则必须还是 /^o[134](?:-|$)/）
  "o1",
  "o3",
  "o4-mini",
  "o1-mini",
  "o3-deep-research",
  // Claude：4.0 / 4.5 / 4.6 / 4.7 / 5.0 / fable / 3.x
  "claude-3-5-sonnet",
  "claude-3-5-haiku",
  "claude-3-7-sonnet",
  "claude-3-7-sonnet-20250219",
  "claude-3-7-sonnet-thinking",
  "claude-3-opus",
  "claude-3.7-sonnet",
  "claude-sonnet-4-0",
  "claude-sonnet-4-5",
  "claude-sonnet-4-5-thinking",
  "claude-sonnet-4-5-20250929",
  "claude-haiku-4-5",
  "claude-haiku-4-0",
  "claude-opus-4-5",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4.7",
  "claude-opus-5",
  "claude-fable-5",
  "anthropic/claude-opus-4-7",
  // Grok：fast / mini / 4.3 / 4.5 / 4.6
  "grok-2",
  "grok-3-mini",
  "grok-4",
  "grok-4.1",
  "grok-4.1-fast",
  "grok-4.1-mini",
  "grok-4.2-fast-reasoning",
  "grok-4.3",
  "grok-4.5",
  "grok-4.6",
  "xai/grok-4.6",
  // GLM：4.5 / 4.6 / 5.2 / 5.3 + 连字符版本号
  "glm-4.5",
  "glm-4.6",
  "glm-5.2",
  "glm-5.3",
  "glm-5-2",
  "zai/glm-5.2",
  // MiMo：2.0（没有）/ 2.5（有）+ xiaomi- 前缀 / 后缀
  "mimo-v2",
  "mimo-v2.0",
  "mimo-v2.5",
  "xiaomi-mimo-v2.5",
  "xiaomi-mimo-v2.5-thinking",
  // 路由前缀 / 标签 / 未知模型
  "openai/gpt-6.1",
  "gpt-6.1:thinking",
  "gpt-6.1@20260101",
  "my-gateway-model",
  "deepseek-v4-pro",
  "qwen3-max",
];

describe("dshReasoningPresetFor 与插件 presetFor 的镜像契约", () => {
  it("语料至少 60 条，别在重构时被裁掉", () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(60);
  });

  it.each(CORPUS)("%s 与插件 presetFor 完全一致", (modelId) => {
    expect(dshReasoningPresetFor(modelId)).toStrictEqual(presetFor(modelId));
  });

  it("族名 / 等级表 / 自适应标志的形状与插件一致", () => {
    const result = dshReasoningPresetFor("claude-opus-4-7");
    expect(result).not.toBeNull();
    expect(Object.keys(result ?? {}).sort()).toStrictEqual([
      "adaptive",
      "efforts",
      "family",
    ]);
    expect(typeof result?.adaptive).toBe("boolean");
    expect(typeof result?.family).toBe("string");
  });

  // 这一条是整套逻辑最容易写错的地方：`off` 到底是 null（不发参数）
  // 还是字符串 "none"（真的发 none），两族行为不同。
  it('off 的 null 与 "none" 严格区分', () => {
    expect(dshReasoningPresetFor("claude-sonnet-4-6")?.efforts.off).toBeNull();
    expect(dshReasoningPresetFor("glm-4.5")?.efforts.off).toBeNull();
    expect(dshReasoningPresetFor("mimo-v2.5")?.efforts.off).toBeNull();
    expect(dshReasoningPresetFor("gpt-5")?.efforts.off).toBeUndefined();

    expect(dshReasoningPresetFor("gpt-6.1")?.efforts.off).toBe("none");
    expect(dshReasoningPresetFor("grok-4.3")?.efforts.off).toBe("none");
    expect(dshReasoningPresetFor("glm-5.2")?.efforts.off).toBe("none");
  });

  it("不认识 / 非推理模型一律返回 null（不再猜前缀）", () => {
    for (const modelId of [
      "gpt-4o",
      "claude-haiku-4-0",
      "claude-3-5-sonnet",
      "mimo-v2.0",
      "gpt-5-chat",
      "grok-2",
      "glm-4.4",
      "my-gateway-model",
    ]) {
      expect(dshReasoningPresetFor(modelId)).toBeNull();
    }
  });
});
