import type { Debater, TurnSpec, WrittenTurn } from "../agents/debater.js";
import type { AgentFactory } from "../agents/index.js";
import { collectQuota } from "../agents/researcher.js";
import type { JudgeDraft, PlanDraft } from "../agents/schemas.js";
import { openingTarget, sourceName, spokenChars } from "../debate/citation.js";
import { debaterState, evidenceLeft, nameOf, teamEvidence } from "../debate/transcript.js";
import {
  ALL_DEBATERS,
  SIDE_LABEL,
  opponentOf,
  type DebateRecord,
  type DebaterState,
  type Evidence,
  type ProgressLog,
} from "../types.js";

// 演示模式（DEBATE_MOCK=1）：不调用 API、不联网，用占位数据走通完整的 8 人流程，方便调试界面与编排逻辑。
// 演示效果：正方一辩立论初稿故意把编号写进正文、并超出每个论点的证据上限，演示修改流程；
// 之后的辩手优先引用本方尚未公开的证据（常常是队友检索到的），演示队友共享证据库，并且不超出本方的证据使用额度；
// 封存前复核时反方三辩的一条证据「网页打不开」被删除，演示复核流程；
// 反方二辩驳论时质疑正方一辩的一条证据（核查不成立），正方三辩在自由辩论中质疑反方一辩的证据（核查成立）。

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pause = () => sleep(300 + Math.random() * 400);

const REASONING = [
  "这一点的关键在于因果链条是否完整：前提成立，中间环节可被观察，结论才站得住。",
  "如果把视角放到更长的时间尺度上，短期的波动并不能否定结构性的趋势。",
  "对方需要证明的不是问题存在，而是问题严重到足以推翻整体判断，这一步至今没有完成。",
  "判断标准要求我们比较的是净效果，而净效果取决于收益与代价在同一尺度上的权衡。",
];

/** 按引用规则写一句占位引用：先说出处，再讲内容，句末标注编号。 */
const cite = (e: Evidence) => `据${sourceName(e)}发布的资料，${e.claim.replace(/^\[演示数据\]\s*/, "").replace(/[。.]$/, "")}〔${e.id}〕。`;

function makeEvidence(me: DebaterState, n: number): Evidence {
  const id = `${me.side === "pro" ? "P" : "C"}${me.position}-${n}`;
  const stat = `${me.side === "pro" ? 1 : 5}${me.position}${n}.5%`; // 每条证据的数据点各不相同
  return {
    id,
    owner: me.id,
    side: me.side,
    claim: `[演示数据] ${me.name}检索到的第 ${n} 条占位证据，相关比例为 ${stat}。`,
    attribution: `演示机构${"甲乙丙丁戊"[n - 1] ?? "己"}`,
    sources: [
      {
        url: `https://example.com/${me.id}/${n}`,
        title: `演示来源 ${id} - 示例网站`,
        site: "示例网站",
        published: "2026-01-01",
        quote: `这是一段占位原文，真实模式下这里是从网页正文中逐字摘录、并打开网页核对过的原文（${id}）。`,
        checkedAt: new Date().toISOString(),
      },
    ],
  };
}

const opponentOpening = (record: DebateRecord, me: DebaterState) =>
  record.turns.find((t) => t.kind === "opening" && t.speaker.startsWith(opponentOf(me.side)));

class MockDebater implements Debater {
  constructor(
    private record: DebateRecord,
    readonly id: string,
  ) {}

  private get me() {
    return debaterState(this.record, this.id);
  }

  async prepare(log?: ProgressLog) {
    const me = this.me;
    for (const q of [`${this.record.input.topic} 数据`, `${this.record.input.topic} 研究`]) {
      await pause();
      me.searchCalls.push({ query: q, ok: true, results: 3, newPages: 3, ms: 0, purpose: "赛前准备", at: new Date().toISOString() });
      log?.(`${me.name} · 演示搜索「${q}」→ 3 条结果（演示模式不调用博查）`);
    }
    me.rejectedPages.push({ url: `https://example.com/${me.id}/login`, title: "需要登录的演示网页", reason: "网页正文为空（可能需要登录或由脚本渲染）" });
    for (let n = 1; n <= Math.min(4, collectQuota(me.position)); n++) me.bank.push(makeEvidence(me, n));
  }

  async recheck(log?: ProgressLog) {
    await pause();
    const me = this.me;
    if (me.id !== "con-3" || me.bank.length === 0) return;
    const e = me.bank.pop()!;
    const s = e.sources[0];
    me.rejectedPages.push({ url: s.url, title: s.title, reason: `封存前复核：网页无法打开（演示），已删除证据「${e.claim}」` });
    log?.(`${me.name} · 封存前复核删除证据〔${e.id}〕：网页无法打开（演示）`, "warn");
  }

  async plan(spec: TurnSpec): Promise<PlanDraft> {
    await pause();
    const me = this.me;
    const fresh = teamEvidence(this.record, me.side)
      .filter((e) => e.disclosedAt === undefined)
      .slice(0, evidenceLeft(this.record, me.side));
    const point = (i: number, evidence: Evidence[]) => ({
      claim: `${SIDE_LABEL[me.side]}的第 ${i + 1} 个要点`,
      responds_to: spec.kind === "opening" ? "" : "对方立论",
      logic_chain: ["前提：现状中存在可观察的问题。", "推论：该问题会在关键环节放大。", "结论：因此我方立场更能实现判断标准。"],
      evidence: evidence.map((e) => ({ evidence_id: e.id, proves: "证明推理链第一步的前提成立" })),
    });
    const opp = this.record.debaters.filter((d) => d.side !== me.side).flatMap((d) => d.bank);
    // 演示质疑：反方二辩驳论时质疑正方一辩最先公开的证据
    const target = me.id === "con-2" ? opp.find((e) => e.disclosedAt !== undefined) : undefined;
    return {
      definitions: spec.kind === "opening" ? "[演示] 概念界定占位" : "",
      criterion: spec.kind === "opening" ? "[演示] 判断标准：哪一方能带来更大的长期净收益" : "",
      points: spec.kind === "opening" ? [point(0, fresh.slice(0, 2)), point(1, fresh.slice(2, 3))] : [point(0, fresh.slice(0, 1))],
      weighing: "[演示] 我方的推理链更完整，对方的关键前提缺乏支撑。",
      challenge: target ? { evidence_id: target.id, reason: "[演示] 该数据与常识出入较大，怀疑来源不可靠" } : null,
    };
  }

  async write(spec: TurnSpec, plan: PlanDraft | null, feedback?: string): Promise<WrittenTurn> {
    await pause();
    const me = this.me;
    const bank = new Map(teamEvidence(this.record, me.side).map((e) => [e.id, e]));
    const planned = (i: number) => (plan?.points[i]?.evidence ?? []).map((x) => bank.get(x.evidence_id)!).filter(Boolean);
    const label = SIDE_LABEL[me.side];

    switch (spec.kind) {
      case "opening": {
        const flawed = me.id === "pro-1" && !feedback;
        const args = [
          {
            title: `${label}论点一：现实层面的必要性`,
            reasoning: flawed
              ? `${planned(0)[0].id}已经说明了问题。${planned(0).map(cite).join("")}${cite(me.bank[3])}这说明${label}立场具有必要性。`
              : `${REASONING[0]}${planned(0).map(cite).join("")}这说明${label}立场在现实中具有必要性。`,
          },
          { title: `${label}论点二：长期影响`, reasoning: `${REASONING[1]}${planned(1).map(cite).join("")}从长期看，${label}立场的收益大于代价。` },
        ];
        const draft = {
          intro: `[演示] 谢谢主席，各位评委、对方辩友，大家好。今天我方的立场是${label}观点成立。${plan?.criterion ?? ""}`,
          arguments: args,
          conclusion: `综上所述，${label}立场更有说服力。谢谢！`,
        };
        if (!flawed) {
          const { target } = openingTarget();
          const count = () => spokenChars([draft.intro, ...args.flatMap((a) => [a.title, a.reasoning]), draft.conclusion].join(""));
          for (let i = 0; count() + 60 <= target; i++) args[i % 2].reasoning += REASONING[(i + 2) % REASONING.length];
        }
        return { opening: draft, text: "" };
      }
      case "rebuttal":
      case "summary":
      case "closing": {
        const opp = opponentOpening(this.record, me);
        const target = opp?.arguments?.[0];
        const body = [
          `[演示] ${target ? `对方一辩的第一个论点认为「${target.title}」〔${target.id}〕，` : ""}但这条推理链的中间一步并不成立。`,
          ...planned(0).map(cite),
        ];
        // 用占位推理把篇幅补到该环节要求的字数
        const goal = { rebuttal: 700, summary: 470, closing: 800 }[spec.kind];
        for (let i = 0; spokenChars(body.join("")) + 50 < goal; i++) body.push(REASONING[i % REASONING.length]);
        body.push(`因此，${label}的立场更站得住脚。`);
        return { text: body.join(""), challenge: plan?.challenge ?? null };
      }
      case "question":
        return { text: `[演示] 请问${nameOf(spec.target ?? "")}：如果对方的前提不成立，贵方的结论还能成立吗？（第 ${spec.round} 问）` };
      case "answer":
        return { text: `[演示] 能成立。我方的推理并不依赖这个前提，关键在于长期净效果的比较。` };
      case "free": {
        // 演示质疑：正方三辩在自由辩论中质疑反方一辩最先公开的证据
        const opp = this.record.debaters.filter((d) => d.side !== me.side).flatMap((d) => d.bank);
        const target = me.id === "pro-3" ? opp.find((e) => e.disclosedAt !== undefined) : undefined;
        return {
          text: `[演示] 对方刚才的回应回避了我们的问题：净效果到底如何比较？${REASONING[2]}`,
          challenge: target ? { evidence_id: target.id, reason: "[演示] 怀疑该数据被断章取义" } : null,
        };
      }
      default:
        return { text: "" };
    }
  }
}

export const mockAgents: AgentFactory = {
  debater: (record, id) => new MockDebater(record, id),

  async factCheck(_record, challenge) {
    await pause();
    const upheld = challenge.side === "pro"; // 演示：正方的质疑核查成立（证据属实），反方的质疑核查不成立
    return {
      verdict: upheld ? "成立" : "不成立",
      explanation: upheld
        ? "[演示] 原网页可以打开，摘录原文存在，证据与发言都忠实于原文。"
        : "[演示] 原网页无法打开，联网搜索也没有找到其他来源佐证。",
      pageReachable: upheld,
      quoteOnPage: upheld,
      corroboration: [],
    };
  },

  async judge(_record, persona): Promise<JudgeDraft> {
    await pause();
    const tilt = persona.id.length % 2 === 0 ? 1 : -1;
    return {
      pro: { argument: 7 + tilt, evidence: 6, clash: 7, delivery: 7 },
      con: { argument: 7 - tilt, evidence: 7, clash: 6, delivery: 7 },
      debaters: ALL_DEBATERS.map((d, i) => ({ id: d.id, score: 80 + ((i * 3 + persona.id.length) % 10), comment: `[演示] ${d.name}表现稳定` })),
      winner: tilt > 0 ? "pro" : "con",
      reason: `[演示] ${persona.name}从「${persona.focus}」角度认为${tilt > 0 ? "正方" : "反方"}略胜一筹。`,
      key_moments: ["[演示] 双方围绕论点一的交锋", "[演示] 证据质疑的核查结果"],
    };
  },

  async summarize(_record, _results, tally) {
    await pause();
    return `[演示] 裁判组以 ${tally.votes.pro}:${tally.votes.con} 作出判决。真实模式下，这里是主裁判对全场的综合评议。`;
  },
};
