import type { DebateRecord, TokenUsage } from "../types.js";

// 每场辩论的模型 token 用量：按环节和模型分类累计（双方可能用不同的模型），
// 赛后写入运行日志，便于和各家控制台的账单对照。

export type UsageCategory = "检索" | "构思" | "发言" | "核查" | "评议";

/** 某一类调用的用量统计（没有就新建），交给模型调用累加。 */
export function usageFor(record: DebateRecord, category: UsageCategory, model: string): TokenUsage {
  record.usage ??= {};
  return (record.usage[`${category} · ${model}`] ??= { calls: 0, input: 0, cachedInput: 0, output: 0, reasoning: 0 });
}

const wan = (n: number) => `${(n / 10000).toFixed(1)} 万`;
const hitRate = (u: TokenUsage) => (u.input ? Math.round((u.cachedInput / u.input) * 100) : 0);

/** 一行用量汇总；没有调用过模型（演示模式）时返回 null。 */
export function formatUsage(record: DebateRecord): string | null {
  const entries = Object.entries(record.usage ?? {}).filter(([, u]) => u.calls > 0);
  if (entries.length === 0) return null;
  const total: TokenUsage = { calls: 0, input: 0, cachedInput: 0, output: 0, reasoning: 0 };
  for (const [, u] of entries) for (const k of Object.keys(total) as (keyof TokenUsage)[]) total[k] += u[k];
  const parts = entries.map(
    ([name, u]) => `${name} ${u.calls} 次，输入 ${wan(u.input)}（命中 ${hitRate(u)}%），输出 ${wan(u.output)}`,
  );
  return `模型用量：共 ${total.calls} 次调用，输入 ${wan(total.input)} token（缓存命中 ${hitRate(total)}%），输出 ${wan(total.output)} token（其中思考 ${wan(total.reasoning)}）。${parts.join("；")}`;
}
