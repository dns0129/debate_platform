import { config } from "../config.js";
import type { DebateRecord, Side, TeamModel } from "../types.js";

// 可选模型目录：三家都兼容 OpenAI Chat Completions 格式，用同一个 SDK 指向各自的 base URL。
// 思考强度各家档位不同，一律用各家 API 的原生取值，按由低到高排列：
//   DeepSeek  reasoning_effort：low / high / max（默认 high）
//   智谱 GLM   reasoning_effort：low / high / max（默认 max，思考模式始终开启）
//   千问 Qwen  enable_thinking + reasoning_effort：low / medium / xhigh（默认 xhigh）

export type Provider = "deepseek" | "zhipu" | "qwen";

export interface ProviderInfo {
  label: string;
  /** .env 里的密钥变量名，用于提示 */
  keyEnv: string;
  apiKey: string;
  baseUrl: string;
}

export const PROVIDERS: Record<Provider, ProviderInfo> = {
  deepseek: { label: "DeepSeek", keyEnv: "DEEPSEEK_API_KEY", apiKey: config.deepseekApiKey, baseUrl: config.deepseekBaseUrl },
  zhipu: { label: "智谱", keyEnv: "ZHIPU_API_KEY", apiKey: config.zhipuApiKey, baseUrl: config.zhipuBaseUrl },
  qwen: { label: "千问", keyEnv: "DASHSCOPE_API_KEY", apiKey: config.dashscopeApiKey, baseUrl: config.dashscopeBaseUrl },
};

export interface EffortLevel {
  value: string;
  label: string;
}

export interface ModelSpec {
  id: string;
  label: string;
  provider: Provider;
  /** 思考强度档位，由低到高 */
  efforts: EffortLevel[];
  /** 该模型 API 的默认档位 */
  defaultEffort: string;
  /** max_tokens：思考内容是否计入各家不同；undefined 表示不传，用模型默认上限 */
  maxTokens(effort: string): number | undefined;
  /** 控制思考的请求参数 */
  thinkingParams(effort: string): Record<string, unknown>;
}

const level = (value: string, label: string): EffortLevel => ({ value, label });

type Family = Omit<ModelSpec, "id" | "label">;

const FAMILIES: Record<Provider, Family> = {
  // 思考模式默认开启，思维链计入 max_tokens。取 DeepSeek 自己的默认值：思考模式 64K，max 档 128K；
  // 按实际生成的 token 计费，上限放宽不会多花钱，放得太小会把 max 档的构思截断
  deepseek: {
    provider: "deepseek",
    efforts: [level("low", "低"), level("high", "高"), level("max", "最高")],
    defaultEffort: "high",
    maxTokens: (effort) => (effort === "max" ? 131_072 : 65_536),
    thinkingParams: (effort) => ({ reasoning_effort: effort }),
  },
  // GLM-5.3 思考模式始终开启，最大输出 128K（含思维链）
  zhipu: {
    provider: "zhipu",
    efforts: [level("low", "低"), level("high", "高"), level("max", "最高")],
    defaultEffort: "max",
    maxTokens: () => 128_000,
    thinkingParams: (effort) => ({ reasoning_effort: effort }),
  },
  // 千问的 max_tokens 只限制回复内容、不限制思考内容，不传即用模型默认上限；
  // reasoning_effort 不能和 thinking_budget 同时传
  qwen: {
    provider: "qwen",
    efforts: [level("low", "低"), level("medium", "中"), level("xhigh", "最高")],
    defaultEffort: "xhigh",
    maxTokens: () => undefined,
    thinkingParams: (effort) => ({ enable_thinking: true, reasoning_effort: effort }),
  },
};

/** 页面上可以选择的模型。 */
export const MODELS: ModelSpec[] = [
  { id: "deepseek-flash", label: "DeepSeek V4.1 Flash", ...FAMILIES.deepseek },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", ...FAMILIES.deepseek },
  { id: "glm-5.3", label: "智谱 GLM-5.3", ...FAMILIES.zhipu },
  { id: "qwen3.8-max", label: "千问 Qwen3.8-Max", ...FAMILIES.qwen },
];

/** 目录里的模型直接取；.env 里填了目录外的模型编号时，按前缀归到对应厂商。认不出的返回 undefined。 */
export function findModel(id: string): ModelSpec | undefined {
  const known = MODELS.find((m) => m.id === id);
  if (known) return known;
  const provider: Provider | undefined = id.startsWith("deepseek")
    ? "deepseek"
    : id.startsWith("glm")
      ? "zhipu"
      : id.startsWith("qwen")
        ? "qwen"
        : undefined;
  return provider && { id, label: id, ...FAMILIES[provider] };
}

export function modelSpec(id: string): ModelSpec {
  const spec = findModel(id);
  if (!spec) throw new Error(`不支持的模型「${id}」：模型编号需以 deepseek、glm 或 qwen 开头`);
  return spec;
}

// 其他厂商的档位名换算到本模型：按「低 / 中 / 高」三级对齐
const RANK: Record<string, number> = { none: 0, minimal: 0, low: 0, medium: 1, high: 1, xhigh: 2, max: 2 };

/** 把思考强度落到该模型支持的档位上；没填或认不出时用模型默认档位。 */
export function resolveEffort(spec: ModelSpec, effort?: string): string {
  if (!effort) return spec.defaultEffort;
  if (spec.efforts.some((e) => e.value === effort)) return effort;
  const rank = RANK[effort];
  return rank === undefined ? spec.defaultEffort : spec.efforts[Math.min(rank, spec.efforts.length - 1)].value;
}

/** 低一档的思考强度；已经是最低档时返回 null。 */
export function lowerEffort(spec: ModelSpec, effort: string): string | null {
  const i = spec.efforts.findIndex((e) => e.value === effort);
  return i > 0 ? spec.efforts[i - 1].value : null;
}

export const lowestEffort = (spec: ModelSpec) => spec.efforts[0].value;

export const isConfigured = (spec: ModelSpec) => Boolean(PROVIDERS[spec.provider].apiKey);

export const effortLabel = (spec: ModelSpec, effort: string) => spec.efforts.find((e) => e.value === effort)?.label ?? effort;

/** 日志里显示的「模型 · 思考强度」。 */
export const describeModel = (id: string, effort: string) => {
  const spec = findModel(id);
  return spec ? `${spec.label}（思考强度 ${effortLabel(spec, effort)}）` : id;
};

/** 页面上的默认选项：.env 的 DEBATE_MODEL 与 DEBATE_REASONING_EFFORT。 */
export function defaultTeam(): TeamModel {
  const spec = findModel(config.debateModel) ?? MODELS[0];
  return { model: spec.id, effort: resolveEffort(spec, config.debateEffort) };
}

/** 这一方辩手用的模型与思考强度；旧记录没有保存时用默认配置。 */
export function teamModel(record: DebateRecord, side: Side): TeamModel {
  return record.input.teams?.[side] ?? defaultTeam();
}
