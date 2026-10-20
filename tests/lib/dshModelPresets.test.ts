import { describe, expect, it } from "vitest";
import type { DshModel } from "@/components/providers/forms/helpers/deepseekHarnessFormUtils";
import {
  applyPresetToDshModel,
  dshModelFieldsToPresetParams,
  getDshModelPresetFields,
} from "@/lib/dshModelPresets";
import type { ModelPresetParams } from "@/lib/modelPresets";

const baseModel: DshModel = {
  id: "deepseek-v4-pro",
  name: "DeepSeek V4 Pro",
  rowKey: "row-1",
  contextWindow: 128000,
  maxTokens: 8192,
  temperature: 0.3,
  reasoningEfforts: { low: "low", high: "high" },
  compat: { supportsStore: true, supportsDeveloperRole: false },
  input: ["text", "image"],
  unknownFlag: false,
  nullable: null,
};

describe("provider field boundaries", () => {
  it("excludes connection fields from selection, conversion, and application", () => {
    const model: DshModel = {
      id: "model",
      apiKey: "fixture-secret",
      baseURL: "https://example.invalid",
      headers: { Authorization: "fixture" },
      contextWindow: 65536,
    };
    expect(getDshModelPresetFields(model).map(({ key }) => key)).toEqual([
      "contextWindow",
    ]);
    expect(dshModelFieldsToPresetParams(model, Object.keys(model))).toEqual({
      contextWindow: 65536,
    });
    expect(
      applyPresetToDshModel(
        { id: "target" },
        {
          extraParams: {
            apiKey: "fixture-secret",
            baseURL: "https://example.invalid",
            headers: {},
            input: ["text"],
          },
        },
      ),
    ).toEqual({ id: "target", input: ["text"] });
  });

  it("does not put negative or fractional token counts into unsigned preset fields", () => {
    expect(
      dshModelFieldsToPresetParams(
        { id: "invalid", contextWindow: -1, maxTokens: 1.5 },
        ["contextWindow", "maxTokens"],
      ),
    ).toEqual({ extraParams: { contextWindow: -1, maxTokens: 1.5 } });
  });
});

describe("getDshModelPresetFields", () => {
  it("去身份字段、保留 false/null、已知字段排前面，跳过旧插件字段", () => {
    const fields = getDshModelPresetFields({
      ...baseModel,
      reasoningEffort: "high",
      dsh: { contextWindow: 32000 },
    });
    expect(fields.map((field) => field.key)).toEqual([
      "contextWindow",
      "maxTokens",
      "temperature",
      "reasoningEfforts",
      "compat",
      "input",
      "unknownFlag",
      "nullable",
    ]);
    expect(fields.map((field) => field.key)).not.toContain("reasoningEffort");
    expect(fields.map((field) => field.key)).not.toContain("dsh");
    expect(fields.find((field) => field.key === "unknownFlag")?.value).toBe(
      false,
    );
    expect(fields.find((field) => field.key === "nullable")?.value).toBeNull();
  });

  it("跳过 undefined 和原型污染键", () => {
    const polluted = JSON.parse(
      '{"id":"x","__proto__":{"polluted":true},"constructor":{"bad":1},"prototype":"p","ok":1,"missing":null}',
    ) as DshModel;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (polluted as any).gone = undefined;

    expect(getDshModelPresetFields(polluted).map((field) => field.key)).toEqual(
      ["ok", "missing"],
    );
  });

  it("返回深拷贝：改字段值不会影响原模型", () => {
    const fields = getDshModelPresetFields(baseModel);
    const efforts = fields.find((field) => field.key === "reasoningEfforts")
      ?.value as Record<string, unknown>;
    const compat = fields.find((field) => field.key === "compat")
      ?.value as Record<string, unknown>;
    const input = fields.find((field) => field.key === "input")
      ?.value as unknown[];

    expect(efforts).not.toBe(baseModel.reasoningEfforts);
    expect(compat).not.toBe(baseModel.compat);
    expect(input).not.toBe(baseModel.input);

    efforts.low = "changed";
    compat.supportsStore = false;
    input.push("audio");

    expect(baseModel.reasoningEfforts).toEqual({ low: "low", high: "high" });
    expect(baseModel.compat).toEqual({
      supportsStore: true,
      supportsDeveloperRole: false,
    });
    expect(baseModel.input).toEqual(["text", "image"]);
  });
});

describe("dshModelFieldsToPresetParams", () => {
  it("同名字段直传，maxTokens 映射成 maxOutputTokens，其余进 extraParams", () => {
    const params = dshModelFieldsToPresetParams(baseModel, [
      "contextWindow",
      "maxTokens",
      "temperature",
      "reasoningEfforts",
      "compat",
      "input",
      "unknownFlag",
      "nullable",
    ]);

    expect(params).toEqual({
      contextWindow: 128000,
      maxOutputTokens: 8192,
      temperature: 0.3,
      extraParams: {
        reasoningEfforts: { low: "low", high: "high" },
        compat: { supportsStore: true, supportsDeveloperRole: false },
        input: ["text", "image"],
        unknownFlag: false,
        nullable: null,
      },
    });
    const extra = params.extraParams as Record<string, unknown>;
    expect(extra.compat).not.toBe(baseModel.compat);
    expect(extra.reasoningEfforts).not.toBe(baseModel.reasoningEfforts);
  });

  it("未勾选的字段不进入预设，身份字段勾了也不生效", () => {
    expect(
      dshModelFieldsToPresetParams(baseModel, ["contextWindow", "id", "name"]),
    ).toEqual({ contextWindow: 128000 });
  });

  it("maxTokens 优先；两者都在时另一个保留在 extraParams", () => {
    const model: DshModel = {
      ...baseModel,
      maxTokens: 4096,
      maxOutputTokens: 2048,
    };

    expect(
      dshModelFieldsToPresetParams(model, ["maxTokens", "maxOutputTokens"]),
    ).toEqual({
      maxOutputTokens: 4096,
      extraParams: { maxOutputTokens: 2048 },
    });
    expect(dshModelFieldsToPresetParams(model, ["maxOutputTokens"])).toEqual({
      maxOutputTokens: 2048,
    });
  });

  it("类型不符合预设契约时落进 extraParams，不丢 false/null/字符串", () => {
    const model = {
      id: "m",
      contextWindow: "128k",
      temperature: null,
    } as unknown as DshModel;
    expect(
      dshModelFieldsToPresetParams(model, ["contextWindow", "temperature"]),
    ).toEqual({
      extraParams: {
        contextWindow: "128k",
        temperature: null,
      },
    });
  });

  it("旧插件的模型级 reasoningEffort 不进入预设", () => {
    const model = {
      ...baseModel,
      reasoningEffort: "high",
    } as DshModel;
    expect(
      dshModelFieldsToPresetParams(model, Object.keys(model)),
    ).not.toHaveProperty("reasoningEffort");
    expect(
      (
        dshModelFieldsToPresetParams(model, Object.keys(model))
          .extraParams as Record<string, unknown>
      ).reasoningEffort,
    ).toBeUndefined();
  });

  it("未知字段和 maxOutputTokens 的值都会深拷贝", () => {
    const model: DshModel = {
      id: "m",
      maxTokens: 100,
      compat: { nested: { a: 1 } },
      custom: { list: [1, 2] },
    };
    const params = dshModelFieldsToPresetParams(model, [
      "maxTokens",
      "compat",
      "custom",
    ]);
    const extra = params.extraParams as Record<string, unknown>;
    expect(extra.compat).not.toBe(model.compat);
    expect(extra.custom).not.toBe(model.custom);

    (extra.compat as { nested: { a: number } }).nested.a = 99;
    (extra.custom as { list: number[] }).list.push(3);
    expect(model.compat).toEqual({ nested: { a: 1 } });
    expect(model.custom).toEqual({ list: [1, 2] });
  });
});

describe("applyPresetToDshModel", () => {
  it("只覆盖预设里存在的参数，其余原样保留", () => {
    const applied = applyPresetToDshModel(baseModel, { temperature: 0.7 });

    expect(applied).not.toBe(baseModel);
    expect(applied.temperature).toBe(0.7);
    expect(applied.contextWindow).toBe(128000);
    expect(applied.maxTokens).toBe(8192);
    expect(applied.reasoningEfforts).toEqual(baseModel.reasoningEfforts);
    expect(applied.compat).toEqual(baseModel.compat);
    expect(applied.input).toEqual(baseModel.input);
    expect(applied.id).toBe(baseModel.id);
    expect(applied.name).toBe(baseModel.name);
    expect(applied.rowKey).toBe(baseModel.rowKey);
  });

  it("maxOutputTokens 落到原生 maxTokens", () => {
    const applied = applyPresetToDshModel(baseModel, {
      maxOutputTokens: 16384,
    });
    expect(applied.maxTokens).toBe(16384);
    expect(applied.contextWindow).toBe(128000);
  });

  it("compat 浅合并保留模型上的其他开关，reasoningEfforts 整表替换", () => {
    const params: ModelPresetParams = {
      extraParams: {
        compat: { supportsStore: false, supportsToolCalls: true },
        reasoningEfforts: { max: "max" },
      },
    };
    const applied = applyPresetToDshModel(baseModel, params);

    expect(applied.compat).toEqual({
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsToolCalls: true,
    });
    expect(applied.reasoningEfforts).toEqual({ max: "max" });
    // 原模型不受影响
    expect(baseModel.compat).toEqual({
      supportsStore: true,
      supportsDeveloperRole: false,
    });
    expect(baseModel.reasoningEfforts).toEqual({ low: "low", high: "high" });
  });

  it("忽略旧插件的模型级 reasoningEffort 与 extraParams.dsh 命名空间", () => {
    const applied = applyPresetToDshModel(
      { id: "m" },
      {
        reasoningEffort: "max",
        extraParams: {
          reasoningEffort: "high",
          dsh: { contextWindow: 32000 },
          custom: 1,
        },
      } as ModelPresetParams,
    );

    expect(applied).toEqual({ id: "m", custom: 1 });
    expect(applied).not.toHaveProperty("reasoningEffort");
    expect(applied).not.toHaveProperty("dsh");
  });

  it("extraParams 不覆盖身份字段和原型污染键", () => {
    const extraParams = JSON.parse(
      '{"id":"evil","name":"evil","rowKey":"evil","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"prototype":"x","custom":1}',
    ) as Record<string, unknown>;
    const applied = applyPresetToDshModel(baseModel, { extraParams });

    expect(applied.id).toBe("deepseek-v4-pro");
    expect(applied.name).toBe("DeepSeek V4 Pro");
    expect(applied.rowKey).toBe("row-1");
    expect((applied as Record<string, unknown>).custom).toBe(1);
    expect((applied as Record<string, unknown>).prototype).toBeUndefined();
    expect(
      (Object.prototype as Record<string, unknown>).polluted,
    ).toBeUndefined();
  });

  it("套用结果不与入参共享引用", () => {
    const applied = applyPresetToDshModel(baseModel, {
      extraParams: { input: [{ type: "text" }] },
    });
    const nested = (applied.input as { type: string }[])[0];
    nested.type = "audio";

    expect(baseModel.input).toEqual(["text", "image"]);
    expect((applied.compat as Record<string, unknown>).supportsStore).toBe(
      true,
    );
    // 未修改的嵌套对象也是深拷贝
    (applied.compat as Record<string, unknown>).supportsStore = false;
    expect(baseModel.compat).toEqual({
      supportsStore: true,
      supportsDeveloperRole: false,
    });
  });

  it("字段全选后往返不丢配置", () => {
    const keys = getDshModelPresetFields(baseModel).map((field) => field.key);
    const params = dshModelFieldsToPresetParams(baseModel, keys);
    const applied = applyPresetToDshModel(
      { id: baseModel.id, name: baseModel.name, rowKey: baseModel.rowKey },
      params,
    );

    expect(applied).toEqual(baseModel);
  });
});
