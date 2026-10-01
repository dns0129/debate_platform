import { config } from "../config.js";
import { sharedDataPoint } from "../debate/citation.js";
import { teamEvidence } from "../debate/transcript.js";
import { usageFor } from "../debate/usage.js";
import { callStructured, callWithTools, type FunctionTool } from "../llm/client.js";
import { lowestEffort, modelSpec, teamModel } from "../llm/models.js";
import { SearchError, bochaSearch, type SearchResult } from "../search/bocha.js";
import { excerptAround, fetchPages, isBlocked, normalize, quoteInPage } from "../search/page.js";
import {
  SIDE_LABEL,
  TEAM_SIZE,
  formatOf,
  opponentOf,
  type DebateInput,
  type DebateRecord,
  type DebaterState,
  type Evidence,
  type ProgressLog,
  type SearchCall,
  type Side,
} from "../types.js";
import { ResearchDraft } from "./schemas.js";

// 辩手的检索：每位辩手自己决定搜什么、自己整理证据，证据记在自己名下，汇入本方辩手共享的证据库。
// 证据入库要过三道核对，全部由代码完成：
//   1. 网页能打开：实际请求网页，返回正常且有正文（平台在用户本机运行，这里能打开，用户也能打开）；
//   2. 搜索摘要与网页对得上：摘要里的句子能在网页正文中找到，否则说明网页靠脚本渲染或摘要不可信；
//   3. 摘录逐字出现在网页正文中，出处名称确实出现在网页里。
// 另外按「数据点」去重：同一个统计数字被多个网页转载，本方证据库只保留一条。
// 只有赛前准备可以检索：准备结束后每条证据再打开一次原网页复核（recheckEvidence），随后证据库封存，
// 立论开始后任何辩手都不能再收集新证据。出处无法确定的证据一律删除，不再退而用网页标题充当出处。

/** 本次检索到并核对通过的网页，编号 S1.. 供模型引用。 */
interface VerifiedPage extends SearchResult {
  id: string;
  excerpt: string;
  pageNorm: string;
}

const WEB_SEARCH_TOOL: FunctionTool = {
  name: "web_search",
  description: "用博查搜索引擎搜索网页，返回网页标题、链接、发布时间和摘要。每次传入一个搜索词。",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "搜索词，中英文均可" } },
    required: ["query"],
  },
};

// 摘录过短无法证明出处，直接丢弃
const MIN_QUOTE_CHARS = 12;

// 本方已经检索到的网页。同队四人并行检索，同一个网页只由最先搜到的人打开核对、整理证据，
// 整理出的证据全队共享，队友不必再花钱重复打开、重复整理，也不会产生重复证据。
const teamPages = new WeakMap<DebateRecord, Record<Side, Set<string>>>();

function knownPages(record: DebateRecord, side: Side): Set<string> {
  let bySide = teamPages.get(record);
  if (!bySide) teamPages.set(record, (bySide = { pro: new Set(), con: new Set() }));
  return bySide[side];
}

/** 公共论坛制两个辩位赛前准备的检索重点。 */
export const PF_PREP_FOCUS: Record<number, string> = {
  1: "你负责立论（4 分钟）和总结（3 分钟）：寻找能支撑己方 2-3 个论点的核心证据。每个论点按「现状如何 → 我方立场带来什么改变 → 改变导致什么影响、影响多大」组织，证据只找推理链中最需要事实支撑的那一环：权威统计、研究结论、典型案例。",
  2: "你负责反驳（4 分钟）和焦点总结（2 分钟）：预判对方最可能提出的论点，寻找能削弱或反转它们的事实与研究（对方的因果链接哪一环不成立、对方的数据有什么局限），以及能比较双方影响的权衡材料（涉及多少人、可能性多大、多快发生、能否逆转）。",
};

/** 各辩位赛前准备的检索重点。 */
export const PREP_FOCUS: Record<number, string> = {
  1: "你负责立论：寻找能支撑己方判断标准和 2-3 个主论点的核心证据——权威统计、研究结论、典型案例。",
  2: "你负责驳论：预判对方立论最可能提出的论点，寻找能动摇它们的事实、数据与反例，同时准备巩固己方论点的证据。",
  3: "你负责质询：寻找对方立场难以回避的事实、对方常用数据的局限与反例，便于设计让对方两难的问题。",
  4: "你负责总结陈词：寻找能说明本议题长远影响与价值权衡的权威材料和宏观数据。",
};

function brief(input: DebateInput, me: DebaterState): string {
  const stance = (s: "pro" | "con") => (s === "pro" ? input.proStance : input.conStance);
  return `今天是 ${new Date().toISOString().slice(0, 10)}。
论题：${input.topic}
你是${me.name}。己方（${SIDE_LABEL[me.side]}）立场：${stance(me.side)}
对方（${SIDE_LABEL[opponentOf(me.side)]}）立场：${stance(opponentOf(me.side))}`;
}

function formatPage(p: VerifiedPage): string {
  const meta = [p.site, p.published].filter(Boolean).join("，");
  return `[${p.id}] ${p.title}${meta ? `（${meta}）` : ""}\n链接：${p.url}\n正文节选：${p.excerpt}`;
}

export interface ResearchOptions {
  /** 本次检索的重点（赛前准备的辩位职责，或补充检索要针对的对方论点） */
  focus: string;
  maxSearches: number;
  maxNewEvidence: number;
  purpose: string;
  log?: ProgressLog;
}

/**
 * 一位辩手的一次检索：搜索 → 打开网页核对 → 整理证据 → 逐条核对摘录。
 * 返回新增的证据（已编号），由调用方加入该辩手的证据库。
 */
export async function research(record: DebateRecord, me: DebaterState, opts: ResearchOptions): Promise<Evidence[]> {
  if (record.evidenceLockedAt) throw new Error(`${me.name}试图在证据库封存后检索：立论开始后不能再收集新证据`);
  if (!config.bochaApiKey) return [];

  const input = record.input;
  const { model, effort } = teamModel(record, me.side);
  const usage = usageFor(record, "检索", model);
  const found = new Map<string, SearchResult>(); // 按 URL 去重
  const known = knownPages(record, me.side); // 本方（含自己）已经检索到的网页
  const logSearch = (call: SearchCall) => {
    me.searchCalls.push(call);
    const secs = (call.ms / 1000).toFixed(1);
    const message = call.ok
      ? `${me.name} · 博查搜索「${call.query}」→ ${call.results} 条结果（${secs} 秒）`
      : `${me.name} · 博查搜索「${call.query}」失败：${call.error}`;
    const time = new Date().toLocaleString("zh-CN", { hour12: false });
    console.log(`[博查] ${time} ${message}${call.logId ? ` log_id=${call.logId}` : ""}`);
    opts.log?.(message, call.ok ? "info" : "warn");
  };

  await callWithTools({
    model,
    system: `你是辩论赛的${me.name}，正在为自己的发言检索资料。你找到的证据会进入本方${TEAM_SIZE[formatOf(record)] === 2 ? "两" : "四"}位辩手共享的证据库，对方看不到。
${opts.focus}

检索要求：
- 每次一个搜索词，从不同角度搜索，中英文均可。最多搜索 ${opts.maxSearches} 次，根据已有结果调整后续搜索词。
- 只用可以直接打开、看得到原文的原始出处：政府与国际组织官网、高校与研究机构、学术期刊官网、主流媒体的原始报道。
- 不要用转载类网站（自媒体平台、门户网站的转载稿、资讯聚合站）和文库站（豆丁、道客巴巴、百度文库之类）；这些网站以及论文数据库、需要登录的网站会被系统丢弃。
- 搜到的只是转载稿时，换个搜索词去找最初发布的机构或媒体，例如加上机构名、报告名或原媒体名。
- 找的是能支撑推理的关键事实，不是越多越好；同一个数据被多家转载，只需要一个可靠来源。标着「本方已检索」的网页已经由队友或你整理过，不必再找。
- 这是全场唯一的检索机会：立论开始后证据库封存，任何辩手都不能再检索。本方全场最多只能在发言中使用 ${config.maxEvidenceUsedPerSide} 条证据，所以只找最关键、最可靠的。
- 搜索够了就停止调用工具，简短回复「检索完成」。`,
    prompt: `${brief(input, me)}\n\n请开始搜索。`,
    tools: [WEB_SEARCH_TOOL],
    maxToolCalls: opts.maxSearches,
    // 只是决定搜什么，不需要深度思考：用该模型最低的思考强度
    effort: lowestEffort(modelSpec(model)),
    usage,
    execute: async (name, args) => {
      const query = (args as { query?: unknown } | null)?.query;
      if (name !== WEB_SEARCH_TOOL.name || typeof query !== "string" || !query.trim()) {
        return "无效的工具调用：web_search 需要一个非空的 query 参数";
      }
      const q = query.trim();
      const startedAt = Date.now();
      const at = new Date(startedAt).toISOString();
      let pages: SearchResult[];
      let logId: string | undefined;
      try {
        ({ results: pages, logId } = await bochaSearch(q, config.webSearchResultsPerQuery));
      } catch (err) {
        const error = (err as Error).message;
        logSearch({ query: q, at, ok: false, results: 0, newPages: 0, ms: Date.now() - startedAt, error, purpose: opts.purpose });
        if (err instanceof SearchError && err.fatal) throw err;
        return `搜索失败：${error}`;
      }
      const seen = new Set(pages.filter((p) => known.has(p.url)).map((p) => p.url));
      const fresh = pages.filter((p) => !seen.has(p.url));
      for (const p of fresh) {
        found.set(p.url, p);
        known.add(p.url);
      }
      logSearch({ query: q, at, logId, ok: true, results: pages.length, newPages: fresh.length, ms: Date.now() - startedAt, purpose: opts.purpose });
      // 屏蔽名单里的网页仍记入「丢弃的网页」，但不给模型看，免得它围绕转载稿、文库继续搜
      const usable = pages.filter((p) => !isBlocked(p.url));
      if (usable.length === 0) {
        return pages.length ? "搜到的都是转载站或文库站，已被系统丢弃，请换个搜索词去找原始出处。" : "没有搜索到相关网页，请换个搜索词。";
      }
      return usable
        .map((p) => `《${p.title}》${p.site ? `（${p.site}）` : ""}${seen.has(p.url) ? "【本方已检索】" : ""}\n${p.text.slice(0, 300)}`)
        .join("\n\n");
    },
  });

  if (found.size === 0) return [];

  // 打开网页核对：打不开、没有正文、摘要与正文对不上的网页都不交给模型
  const candidates = [...found.values()];
  opts.log?.(`${me.name} · 正在打开 ${candidates.length} 个网页核对原文`);
  const fetched = await fetchPages(candidates.filter((p) => !isBlocked(p.url)).map((p) => p.url));
  const pages: VerifiedPage[] = [];
  for (const p of candidates) {
    const page = fetched.get(p.url);
    const reject = (reason: string) => me.rejectedPages.push({ url: p.url, title: p.title, reason });
    if (!page) {
      reject("站点在屏蔽名单中（转载站、文库或学术数据库）");
      continue;
    }
    if (!page.ok) {
      reject(page.error ?? "无法打开");
      continue;
    }
    const excerpt = excerptAround(page.text, p.text);
    if (!excerpt) {
      reject("搜索摘要在网页正文中找不到（网页可能由脚本渲染或内容已变更）");
      continue;
    }
    pages.push({ ...p, id: `S${pages.length + 1}`, excerpt, pageNorm: normalize(page.text) });
  }
  opts.log?.(
    `${me.name} · 网页核对：${pages.length}/${candidates.length} 个可以打开且原文可核对`,
    pages.length ? "info" : "warn",
  );
  if (pages.length === 0) return [];

  const draft = await callStructured({
    model,
    effort,
    system: `你是辩论赛的${me.name}。下面是你搜索并经系统打开核对过的网页（编号 S1、S2…），请从中整理对你的发言有用的证据。
${opts.focus}

整理要求：
- 每条证据是一句独立的中文事实陈述，必须能被所引网页的原文直接支撑，不夸大、不外推。
- 每条证据写明来源编号，并从该网页的「正文节选」中逐字摘录一段连续原文作为依据。摘录必须与原文一字不差；系统会在网页全文中逐字核对，对不上的会被丢弃。
- 优先引用原始发布方的网页；转述别人内容的网页（转载稿、资讯聚合）能不用就不用。
- 写明「出处」：最初发布这条信息的机构、媒体或报告名称，必须原样出现在该网页中。出处无法确定的证据会被删除。
- 每条证据讲一个独立的事实；同一个数据只保留一条，不要换个说法重复。
- 只保留与论题相关、对你的发言有用的内容，宁缺毋滥。`,
    prompt: `${brief(input, me)}

【核对过的网页】
${pages.map(formatPage).join("\n\n")}

请整理不超过 ${opts.maxNewEvidence} 条证据。`,
    schema: ResearchDraft,
    usage,
  });
  return buildEvidence(me, teamEvidence(record, me.side), draft, pages, opts.maxNewEvidence);
}

/** 每方证据库上限按辩位平均分给本方辩手（并行检索，各自只能整理自己的份额），除不尽的余数给靠前的辩位。 */
export function collectQuota(position: number, teamSize = 4): number {
  const base = Math.floor(config.evidencePerSide / teamSize);
  return base + (position <= config.evidencePerSide % teamSize ? 1 : 0);
}

/**
 * 封存前复核：重新打开这位辩手每条证据的原网页。网页打不开、摘录已不在正文里、出处无法确定的证据
 * 直接删除，记入「丢弃的网页」。通过的证据更新核对时间。返回删除的条数。
 */
export async function recheckEvidence(me: DebaterState, log?: ProgressLog): Promise<number> {
  const fetched = await fetchPages(me.bank.flatMap((e) => e.sources.map((s) => s.url)));
  const checkedAt = new Date().toISOString();
  const kept: Evidence[] = [];
  for (const e of me.bank) {
    const s = e.sources[0];
    const page = s ? fetched.get(s.url) : undefined;
    const problem = !s
      ? "证据没有来源网页"
      : !e.attribution?.trim()
        ? "无法确定出处"
        : !page?.ok
          ? `网页无法打开（${page?.error ?? "未知原因"}）`
          : !quoteInPage(normalize(page.text), s.quote)
            ? "摘录原文已不在网页正文中"
            : null;
    if (problem) {
      me.rejectedPages.push({ url: s?.url ?? "", title: s?.title ?? e.claim, reason: `封存前复核：${problem}，已删除证据「${e.claim}」` });
      log?.(`${me.name} · 封存前复核删除证据〔${e.id}〕：${problem}`, "warn");
      continue;
    }
    for (const src of e.sources) src.checkedAt = checkedAt;
    kept.push(e);
  }
  const removed = me.bank.length - kept.length;
  me.bank = kept;
  return removed;
}

/**
 * 把模型整理的发现转成证据。每条都要通过核对才保留：来源编号是本次核对过的网页、
 * 摘录逐字出现在网页正文里、与本方证据库中已有证据不是同一个数据点。
 */
function buildEvidence(
  me: DebaterState,
  team: Evidence[],
  draft: ResearchDraft,
  pages: VerifiedPage[],
  maxNew: number,
): Evidence[] {
  const prefix = `${me.side === "pro" ? "P" : "C"}${me.position}`;
  const byId = new Map(pages.map((p) => [p.id, p]));
  const out: Evidence[] = [];
  const checkedAt = new Date().toISOString();

  for (const f of draft.findings) {
    if (out.length >= maxNew) break;
    const claim = f.claim.trim();
    const page = byId.get(f.source_id.trim().toUpperCase());
    const quote = f.quote.trim();
    if (!claim || !page || normalize(quote).length < MIN_QUOTE_CHARS || !quoteInPage(page.pageNorm, quote)) continue;

    const attribution = verifyAttribution(f.attribution, page);
    if (!attribution) {
      me.rejectedPages.push({ url: page.url, title: page.title, reason: `无法确定出处：「${f.attribution}」在网页中找不到，网页也没有站点名称，已删除证据「${claim}」` });
      continue;
    }
    const evidence: Evidence = {
      id: `${prefix}-${me.bank.length + out.length + 1}`,
      owner: me.id,
      side: me.side,
      claim,
      attribution,
      sources: [
        { url: page.url, title: page.title, quote, site: page.site || undefined, published: page.published, checkedAt },
      ],
    };
    const existing = [...team, ...out];
    if (existing.some((e) => e.claim === claim || e.sources[0]?.quote === quote || sharedDataPoint(e, evidence))) continue;
    out.push(evidence);
  }
  return out;
}

/** 出处名称必须原样出现在网页标题、站点名或正文里，否则改用网站名；连网站名都没有，出处无法确定，返回 null。 */
function verifyAttribution(attribution: string, page: VerifiedPage): string | null {
  const name = normalize(attribution);
  if (name.length >= 2 && normalize(`${page.title}${page.site}`).concat(page.pageNorm).includes(name)) return attribution.trim();
  return page.site.trim() || null;
}
