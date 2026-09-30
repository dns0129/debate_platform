import { config } from "../config.js";
import { nameOf } from "../debate/transcript.js";
import { usageFor } from "../debate/usage.js";
import { callStructured } from "../llm/client.js";
import { bochaSearch, type SearchResult } from "../search/bocha.js";
import { fetchPageText, normalize, quoteInPage } from "../search/page.js";
import type { Challenge, CheckVerdict, DebateRecord, Evidence, ProgressLog } from "../types.js";
import { FactCheckDraft } from "./schemas.js";

// 证据核查员：中立的第三方，不属于任何一方。辩手质疑对方证据后，由它现场核查：
//   1. 重新打开证据的原网页，看能否打开、摘录是否还在正文里；
//   2. 用博查联网搜索这条证据讲的事实，看有没有其他来源佐证；
//   3. 对照原文判断证据本身、以及发言中的转述是否忠实。

export interface CheckResult {
  verdict: CheckVerdict;
  explanation: string;
  pageReachable: boolean;
  quoteOnPage: boolean;
  corroboration: { url: string; title: string }[];
}

/** 证据在发言里是怎么被讲的：找出含这个标注的句子。 */
export function narrationOf(record: DebateRecord, evidenceId: string): string {
  const marker = `〔${evidenceId}〕`;
  for (const t of record.turns) {
    const at = t.text.indexOf(marker);
    if (at < 0) continue;
    const start = Math.max(t.text.lastIndexOf("。", at - 1), t.text.lastIndexOf("\n", at - 1)) + 1;
    return t.text.slice(start, at + marker.length);
  }
  return "";
}

export async function factCheck(
  record: DebateRecord,
  challenge: Challenge,
  evidence: Evidence,
  log?: ProgressLog,
): Promise<CheckResult> {
  const source = evidence.sources[0];
  const page = source ? await fetchPageText(source.url) : { ok: false, text: "", error: "证据没有来源" };
  const quoteOnPage = page.ok && source ? quoteInPage(normalize(page.text), source.quote) : false;

  let related: SearchResult[] = [];
  if (config.bochaApiKey) {
    const query = `${evidence.attribution ?? ""} ${evidence.claim}`.trim().slice(0, 80);
    try {
      const { results, logId } = await bochaSearch(query, 5);
      related = results;
      const time = new Date().toLocaleString("zh-CN", { hour12: false });
      console.log(`[博查] ${time} 证据核查 · 搜索「${query}」→ ${results.length} 条结果${logId ? ` log_id=${logId}` : ""}`);
      log?.(`证据核查 · 博查搜索「${query}」→ ${results.length} 条结果`);
    } catch (err) {
      log?.(`证据核查 · 博查搜索失败：${(err as Error).message}`, "warn");
    }
  }

  const draft = await callStructured({
    model: config.judgeModel,
    effort: config.judgeEffort,
    system: `你是辩论赛的证据核查员，中立、不属于任何一方。你要根据系统的核查结果和联网搜索结果，判断一条被质疑的证据是否成立。

判定标准：
- 成立：原网页能打开且摘录原文存在，证据陈述和发言中的转述都忠实于原文。
- 部分成立：原文存在，但证据陈述或发言中的转述有夸大、以偏概全或曲解；或原网页已打不开，但有其他可靠来源佐证同一事实。
- 不成立：原网页打不开或原文不存在，且找不到其他来源佐证；或证据与原文明显矛盾。
只依据下面提供的材料判断，不要凭记忆补充事实。`,
    prompt: `【被质疑的证据】${evidence.id}（${nameOf(evidence.owner)}提出）
证据陈述：${evidence.claim}
出处：${evidence.attribution ?? "未注明"}
来源网页：《${source?.title ?? ""}》${source?.url ?? ""}
摘录原文：「${source?.quote ?? ""}」
发言中的转述：${narrationOf(record, evidence.id) || "（未找到）"}

【质疑】${nameOf(challenge.by)}：${challenge.reason}

【系统核查】
原网页${page.ok ? "可以打开" : `无法打开（${page.error ?? "未知原因"}）`}；摘录原文${quoteOnPage ? "在网页正文中找到" : "在网页正文中没有找到"}。

【联网搜索结果】
${related.length ? related.map((r, i) => `${i + 1}. 《${r.title}》${r.site ? `（${r.site}）` : ""}\n${r.text.slice(0, 300)}`).join("\n") : "（无结果或未配置搜索）"}`,
    schema: FactCheckDraft,
    usage: usageFor(record, "核查", config.judgeModel),
  });

  return {
    verdict: draft.verdict,
    explanation: draft.explanation.trim(),
    pageReachable: page.ok,
    quoteOnPage,
    corroboration: related.slice(0, 3).map((r) => ({ url: r.url, title: r.title })),
  };
}
