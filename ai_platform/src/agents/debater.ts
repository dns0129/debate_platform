import { config } from "../config.js";
import { openingBudgetLine, openingDurationLine, openingTarget } from "../debate/citation.js";
import {
  debaterState,
  evidenceLeft,
  evidenceUsed,
  formatOpponentDisclosed,
  formatTeamBank,
  formatTranscript,
  nameOf,
} from "../debate/transcript.js";
import { usageFor } from "../debate/usage.js";
import { callStructured } from "../llm/client.js";
import { teamModel } from "../llm/models.js";
import {
  SIDE_LABEL,
  TURN_LABEL,
  opponentOf,
  type DebateRecord,
  type DebaterState,
  type ProgressLog,
  type Stage,
  type TurnKind,
} from "../types.js";
import { DEBATER_PERSONAS, formatPersona } from "./personas.js";
import { PREP_FOCUS, collectQuota, recheckEvidence, research } from "./researcher.js";
import { AnswerDraft, FreeDraft, OpeningDraft, PlanDraft, QuestionDraft, SpeechDraft } from "./schemas.js";

// 辩手 Agent：8 位辩手各是一个独立的 Agent。
// - 身份与职责：所在方、辩位和该辩位的职责；
// - 本方资料：自己检索、核对、整理的证据汇入本方共享的证据库，队友检索到的也能用；对方看不到尚未公开的部分；
// - 私有记忆：自己每次发言前的构思（逻辑链、证据分工），只有自己能回看；
// - 可见范围：公开发言记录、本方证据库、对方已公开的证据、证据核查结果——和真实辩论中的辩手一样。
// 重要发言（立论、驳论、小结、总结）先私下构思逻辑链，再按构思撰写。

export type SpeakingKind = Exclude<TurnKind, "check">;

export interface TurnSpec {
  kind: SpeakingKind;
  stage: Stage;
  /** 质询：被问的辩手；答质询：提问的辩手 */
  target?: string;
  /** 答质询时对方的问题 */
  question?: string;
  /** 第几问 / 自由辩论第几轮，以及总数 */
  round?: number;
  rounds?: number;
}

export const PLANNED_KINDS: SpeakingKind[] = ["opening", "rebuttal", "summary", "closing"];

export interface ChallengeRequest {
  evidence_id: string;
  reason: string;
}

/** 辩手写出的一段发言。立论另外带分段结构。 */
export interface WrittenTurn {
  text: string;
  opening?: OpeningDraft;
  challenge?: ChallengeRequest | null;
}

export interface Debater {
  readonly id: string;
  /** 赛前准备：按辩位职责检索，证据汇入本方共享的证据库。这是全场唯一的检索机会 */
  prepare(log?: ProgressLog): Promise<void>;
  /** 封存前复核：重新打开本人每条证据的原网页，打不开、摘录不在或出处无法确定的删除 */
  recheck(log?: ProgressLog): Promise<void>;
  /** 私下构思：逻辑链与证据分工 */
  plan(spec: TurnSpec, feedback?: string): Promise<PlanDraft>;
  /** 按构思（如有）写出发言 */
  write(spec: TurnSpec, plan: PlanDraft | null, feedback?: string): Promise<WrittenTurn>;
}

const ROLE_DUTY: Record<number, string> = {
  1: "一辩：立论——构建己方完整的论证框架（概念界定、判断标准、主论点）；在对方质询中捍卫立论；自由辩论中守住论证框架。",
  2: "二辩：驳论——找出对方立论推理链中最薄弱的一环并攻破，同时修补己方被攻击的环节；在对方质询中捍卫本方。",
  3: "三辩：质询——用具体、封闭、两难的问题逼对方做出让步；质询小结——把对方的回答整理成对我方有利的结论。",
  4: "四辩：总结陈词——梳理全场交锋的焦点，做价值与影响的权衡，说明我方为何胜出；不引入全新的论点。",
};

export function challengesLeft(record: DebateRecord, side: "pro" | "con"): number {
  return Math.max(0, config.maxChallengesPerSide - record.challenges.filter((c) => c.side === side).length);
}

/**
 * 八位辩手共用的系统提示：只有论题和规则，不含个人身份和随比赛变化的内容（如剩余质疑次数），
 * 保证每次调用的开头完全相同，才能命中前缀缓存。身份与职责放在用户消息里。
 */
function systemPrompt(record: DebateRecord): string {
  const { topic, proStance, conStance } = record.input;
  return `你是一场正式中文辩论赛中一位独立思考的辩手。正反双方各四位辩手，你是哪一位、职责是什么，见用户消息中的【你的身份】。同队四位辩手共享本方证据库；你能看到公开发言记录、本方证据库和对方已公开的证据，看不到对方尚未公开的证据。
论题：${topic}
正方立场：${proStance}
反方立场：${conStance}

【论证要求】
1. 先有推理，后有证据。每个论点都要讲清推理链：前提是什么、如何一步步推出结论、为什么这样推成立。证据只用来支撑推理中需要事实的那一步，不能用引用代替推理。
2. 每个论点最多引用 ${config.maxEvidencePerPoint} 条证据；一段发言中，含引用的句子不超过全文的 ${Math.round(config.maxCitationRatio * 100)}%。
3. 同一个数据只讲一次。已经公开过的证据（你或队友讲过的）只需简短回指，不要重复展开。
4. 回应对方要打在对方推理链的具体环节上：指出哪一步推不出来、为什么，而不是只罗列相反的数据。

【引用规则 — 系统会逐条校验】
1. 事实依据只能来自本方证据库（每条都已打开网页核对过原文，队友检索到的同样可以引用）。库外的数据、研究、事件、引语一律不得使用，也不得编造编号。对方已公开的证据可以回指或反驳，但不能当作本方的证据。
2. 首次引用本方证据：先说出处（至少说出证据库里的「出处」名称），再讲具体内容，最后在句末用〔P1-3〕这样的格式标注编号。一个括号只写一个编号，编号不要当作名词写进正文。
   示例（内容虚构，仅示范写法）：据某市统计局发布的《2023年统计公报》，该市全年新增就业岗位12万个〔P1-5〕。这说明……（接着推理）
3. 没有证据支撑的内容只能以推理或价值判断的形式出现，不能包装成事实。
4. 提到某个论点时，用文字复述（如"对方一辩的第一个论点认为……"），并在句末标注论点编号，如〔CA2〕（PA 是正方立论的论点，CA 是反方立论的论点）；不得歪曲、虚构对方观点。
5. 被核查判定「不成立」的证据不得再引用。
6. 本方证据库在赛前准备结束时已经封存，比赛中不会再增加新证据。每方全场最多使用 ${config.maxEvidenceUsedPerSide} 条证据：一条本方证据第一次在发言中被引用就算用掉一条（不论是谁引用），之后回指不再计数；回指或反驳对方的证据不计入。额度用完后只能回指已公开的证据或用推理论证，超出的引用会被剔除并交裁判扣分。本方已用几条见【你的身份】；队友后面也要用，只把额度花在最关键的推理步骤上。

【证据质疑】每方全场最多质疑对方证据 ${config.maxChallengesPerSide} 次（你方剩余次数见【你的身份】）。只有当你有具体理由怀疑对方某条已公开证据不存在、来源不可靠或被歪曲时才质疑；系统会打开原网页并联网核查，结果当场公开。无理的质疑同样会被裁判看在眼里。

发言使用中文，逻辑清晰、有力，符合正式辩论赛风格。`;
}

/** 这位辩手的身份、职责与剩余质疑次数。 */
function identity(record: DebateRecord, me: DebaterState): string {
  const own = me.side === "pro" ? record.input.proStance : record.input.conStance;
  return `【你的身份】你是${me.name}，${SIDE_LABEL[me.side]}立场：${own}
你的职责：${ROLE_DUTY[me.position]}
${formatPersona(me.id)}
你方还可以质疑对方证据 ${challengesLeft(record, me.side)} 次。
本方证据已使用 ${evidenceUsed(record, me.side)}/${config.maxEvidenceUsedPerSide} 条，还可以首次引用 ${evidenceLeft(record, me.side)} 条。`;
}

/** 这位辩手自己此前的构思（私有记忆），帮助前后发言保持一致。 */
function formatOwnPlans(me: DebaterState): string {
  if (me.plans.length === 0) return "";
  const lines = me.plans.map(({ turn, plan }) => {
    const p = plan as PlanDraft;
    return `第 ${turn + 1} 段发言的构思：${p.points.map((x) => x.claim).join("；")}。权衡：${p.weighing}`;
  });
  return `【你之前的构思】（仅你本人可见）\n${lines.join("\n")}`;
}

// 材料按「全场相同 → 本方相同 → 本人」排列：发言记录对八位辩手都一样，本方证据库对四位队友都一样。
// 这样每次调用的长前缀都和上一次调用相同，能命中前缀缓存（同队四人用同一个模型），只有新增的部分按原价计费。
function context(record: DebateRecord, me: DebaterState): string {
  return [
    formatTranscript(record),
    formatTeamBank(record, me.side),
    formatOpponentDisclosed(record, me.side),
    identity(record, me),
    formatOwnPlans(me),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function lastOpponentTurn(record: DebateRecord, me: DebaterState) {
  return [...record.turns].reverse().find((t) => t.speaker.startsWith(opponentOf(me.side)));
}

/** 各环节要做什么。 */
function task(record: DebateRecord, me: DebaterState, spec: TurnSpec, planning: boolean): string {
  const { target, min, max } = openingTarget();
  const opp = SIDE_LABEL[opponentOf(me.side)];
  switch (spec.kind) {
    case "opening":
      return planning
        ? `现在轮到你【立论】。先私下构思立论框架：界定关键概念，提出判断标准，设计 2-3 个论点。每个论点写出 3-5 步推理链，并标明哪一步需要哪条证据支撑（每个论点最多 ${config.maxEvidencePerPoint} 条，不同论点不要用同一个数据）。最后想清楚对方最可能攻击哪里、如何化解。`
        : `现在轮到你【立论】。按你的构思写一篇完整的一辩立论稿：开场（问候、概念界定、判断标准）→ 各论点（按推理链一步步展开，证据只支撑关键一步）→ 结语。
【时长要求】按正常语速（每分钟约 ${config.speechCharsPerMinute} 字）${openingDurationLine()}：全文以约 ${target} 字为宜，不少于 ${min} 字、不超过 ${max} 字。〔编号〕标注和标点不计入字数。`;
    case "rebuttal":
      return planning
        ? `现在轮到你【驳论】。先私下构思：针对${opp}立论的每个论点（公开记录里有论点编号），找出其推理链中最薄弱的一环，想清楚它为什么推不出来、你用什么推理或证据攻破；同时想好如何修补己方被攻击的环节。如果你有具体理由怀疑${opp}某条已公开证据，可以在构思中提出质疑。`
        : `现在轮到你【驳论】。按你的构思写驳论稿，约 3 分钟（600-800 字）：逐一攻破对方论点推理链中的关键环节，再巩固己方立论。`;
    case "summary":
      return planning
        ? `现在轮到你【质询小结】。先私下构思：刚才的质询中${opp}做了哪些回答、让步或回避？这些回答如何动摇${opp}的推理链、支持我方？`
        : `现在轮到你【质询小结】。按你的构思写小结，约 2 分钟（400-550 字）：点明对方的关键让步与矛盾，说明它们对胜负的意义。`;
    case "closing":
      return planning
        ? `现在轮到你【总结陈词】。先私下构思：全场有哪 2-3 个核心交锋？每个交锋中双方的推理是什么、为什么我方更成立？最后在判断标准下做价值与影响的权衡。不要引入全新的论点。`
        : `现在轮到你【总结陈词】。按你的构思写总结陈词，约 3-4 分钟（700-950 字）：逐个梳理核心交锋，完成权衡，重申立场。`;
    case "question":
      return `现在是你的【质询】环节：你正在向${nameOf(spec.target ?? "")}提问（对 TA 的第 ${spec.round}/${spec.rounds} 问）。提出一个具体、封闭、让对方难以回避的问题，最好让对方无论怎么答都对我方有利；可以追问对方刚才的回答。只提问，不发表长篇论述。`;
    case "answer":
      return `${nameOf(spec.target ?? "")}在质询中向你提问：「${spec.question}」
请正面回答，不回避问题，同时守住己方立场；需要事实时可以引用本方证据。`;
    case "free": {
      const last = lastOpponentTurn(record, me);
      return `现在是【自由辩论】第 ${spec.round}/${spec.rounds} 轮，轮到你发言。${last ? `紧扣${nameOf(last.speaker)}刚才的话回应，` : ""}简短有力，一次只打一个点。如果你有具体理由怀疑对方某条已公开证据，可以提出质疑。`;
    }
  }
}

function formatPlanForWriting(plan: PlanDraft): string {
  const points = plan.points
    .map((p, i) => {
      const chain = p.logic_chain.map((s, j) => `   ${j + 1}. ${s}`).join("\n");
      const ev = p.evidence.map((e) => `   证据〔${e.evidence_id}〕：${e.proves}`).join("\n");
      return `论点${i + 1}：${p.claim}${p.responds_to ? `（回应：${p.responds_to}）` : ""}\n  推理链：\n${chain}${ev ? `\n${ev}` : ""}`;
    })
    .join("\n");
  const head = [plan.definitions && `概念界定：${plan.definitions}`, plan.criterion && `判断标准：${plan.criterion}`]
    .filter(Boolean)
    .join("\n");
  return `【你的构思】（发言要按这个推理链展开，证据只用在标明的那一步）\n${head ? `${head}\n` : ""}${points}\n权衡：${plan.weighing}`;
}

const withFeedback = (prompt: string, feedback?: string) => (feedback ? `${prompt}\n\n${feedback}` : prompt);

/** 调用模型 API 的真实辩手：用本方选定的模型与思考强度（整队统一）。 */
export class ModelDebater implements Debater {
  constructor(
    private record: DebateRecord,
    readonly id: string,
  ) {}

  private get me() {
    return debaterState(this.record, this.id);
  }

  async prepare(log?: ProgressLog) {
    const me = this.me;
    const found = await research(this.record, me, {
      focus: [PREP_FOCUS[me.position], DEBATER_PERSONAS[me.id]?.research].filter(Boolean).join("\n"),
      maxSearches: config.searchesPerDebater,
      maxNewEvidence: collectQuota(me.position),
      purpose: "赛前准备",
      log,
    });
    me.bank.push(...found);
  }

  async recheck(log?: ProgressLog) {
    await recheckEvidence(this.me, log);
  }

  plan(spec: TurnSpec, feedback?: string): Promise<PlanDraft> {
    const me = this.me;
    const { model, effort } = teamModel(this.record, me.side);
    return callStructured({
      model,
      effort,
      system: systemPrompt(this.record),
      prompt: withFeedback(`${context(this.record, me)}\n\n${task(this.record, me, spec, true)}`, feedback),
      schema: PlanDraft,
      usage: usageFor(this.record, "构思", model),
    });
  }

  async write(spec: TurnSpec, plan: PlanDraft | null, feedback?: string): Promise<WrittenTurn> {
    const me = this.me;
    const prompt = withFeedback(
      [
        context(this.record, me),
        plan ? formatPlanForWriting(plan) : "",
        task(this.record, me, spec, false),
        spec.kind === "opening" ? openingBudgetLine(plan?.points.length || 3) : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      feedback,
    );
    const { model, effort } = teamModel(this.record, me.side);
    const call = <S extends Parameters<typeof callStructured>[0]["schema"]>(schema: S) =>
      callStructured({
        model,
        effort,
        system: systemPrompt(this.record),
        prompt,
        schema,
        usage: usageFor(this.record, "发言", model),
      });

    switch (spec.kind) {
      case "opening": {
        const d = (await call(OpeningDraft)) as OpeningDraft;
        return { opening: d, text: [d.intro, ...d.arguments.map((a) => `${a.title}\n${a.reasoning}`), d.conclusion].join("\n\n") };
      }
      case "question":
        return { text: ((await call(QuestionDraft)) as QuestionDraft).question };
      case "answer":
        return { text: ((await call(AnswerDraft)) as AnswerDraft).answer };
      case "free": {
        const d = (await call(FreeDraft)) as FreeDraft;
        return { text: d.text, challenge: d.challenge };
      }
      default:
        return { text: ((await call(SpeechDraft)) as SpeechDraft).text, challenge: plan?.challenge ?? null };
    }
  }
}

export const turnLabel = (spec: TurnSpec) =>
  spec.kind === "question" ? `质询${nameOf(spec.target ?? "")}` : spec.kind === "answer" ? "答质询" : TURN_LABEL[spec.kind];
