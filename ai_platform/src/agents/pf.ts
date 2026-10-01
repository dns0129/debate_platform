import { config } from "../config.js";
import { PF_GRACE_SEC, openingTarget, pfRange } from "../debate/citation.js";
import { nameOf } from "../debate/transcript.js";
import { SIDE_LABEL, opponentOf, type DebateRecord, type DebaterState, type Side } from "../types.js";
import type { TurnSpec } from "./debater.js";

// 公共论坛制（Public Forum，PF）的辩手提示：正反各两位辩手，一辩负责立论和总结，二辩负责反驳和焦点总结，
// 三轮交叉质询（一辩之间、二辩之间、全场四人）的每一问、每一答都由对应辩手独立作答。
// 规则与要求参照 NSDA 公共论坛制：论点要延续到总结和焦点总结才算数，胜负取决于权衡，焦点总结不得有新论点、新证据。

export const PF_RULES = `【公共论坛制的规则】
1. 赛程：立论（4 分钟）→ 一辩交叉质询 → 反驳（4 分钟）→ 二辩交叉质询 → 总结（3 分钟）→ 全场交叉质询 → 焦点总结（2 分钟）。哪一方先发言由掷硬币决定。每段发言有 ${PF_GRACE_SEC} 秒宽限，超时部分评委不听。
2. 评委是能听懂常识、但不一定懂辩论术语的人：用清楚的口语讲推理，不要堆术语和数字。
3. 论点是一条因果链：现状如何 → 我方立场带来什么改变 → 这个改变导致什么影响 → 影响有多大、落在谁身上。证据只支撑链条中需要事实的那一环。
4. 只有一路延续下来的论点才算数：想在焦点总结里讲的论点，必须在总结里讲过；总结里放弃的论点不能在焦点总结里复活。对方没有回应的论点视为成立；本方被攻击后没有回应的论点视为被打掉。
5. 胜负取决于权衡：双方都有论点成立时，评委比较影响的大小（涉及多少人、程度多深）、可能性、发生快慢、能否逆转。权衡要把双方放在同一把尺子上比较，而不是只说自己的影响大。
6. 交叉质询中对方的让步，只有在之后的发言中明确提出来才算数。
7. 焦点总结不得提出新论点、首次引用新证据。`;

const DUTY: Record<number, string> = {
  1: "一辩：立论——提出 2-3 个论点，每个都讲清现状、因果链接和影响；一辩交叉质询中与对方一辩直接问答；总结——收拢到本方最关键的 1-2 个论点，完整延续推理链、回应对方的攻击，开始权衡。",
  2: "二辩：反驳——逐点攻击对方立论（防守：削弱对方的链接或影响；进攻：把对方的机制反转成对我方有利），后发言的一方还要回应对方反驳对本方论点的攻击；二辩交叉质询中与对方二辩直接问答；焦点总结——与本方总结保持一致，完成权衡，告诉评委为什么投给我方，不提出新论点、新证据。",
};

export const pfDuty = (position: number) => DUTY[position] ?? "";

/** 先发言的一方（掷硬币决定，开赛时存进 record.rules）。 */
export const firstSide = (record: DebateRecord): Side => record.rules?.first ?? "pro";

const lengthLine = (kind: TurnSpec["kind"]) => {
  const r = pfRange(kind);
  if (!r) return "";
  return `【时长要求】${r.minutes} 分钟：按每分钟约 ${config.speechCharsPerMinute} 字，约 ${r.target} 字（${PF_GRACE_SEC} 秒宽限内最多约 ${r.max} 字，不少于 ${r.min} 字）。〔编号〕标注和标点不计入字数。`;
};

/** PF 各环节要做什么。planning = 发言前的私下构思。 */
export function pfTask(record: DebateRecord, me: DebaterState, spec: TurnSpec, planning: boolean): string {
  const opp = SIDE_LABEL[opponentOf(me.side)];
  const speaksSecond = firstSide(record) !== me.side;
  const order = `本场${SIDE_LABEL[firstSide(record)]}先发言，你方${speaksSecond ? "后" : "先"}发言。`;
  switch (spec.kind) {
    case "opening": {
      const { target, min, max } = openingTarget("pf");
      return planning
        ? `现在轮到你【立论】（4 分钟）。${order}先私下构思：界定影响胜负的关键概念，给出判断标准（评委应当用什么尺子比较双方），设计 2-3 个论点。每个论点写出 3-5 步推理链：现状 → 我方立场带来的改变 → 影响及其大小，并标明哪一步需要哪条证据（每个论点最多 ${config.maxEvidencePerPoint} 条）。立论只用最关键的 4-6 条证据，其余留给反驳和总结。最后想清楚对方最可能攻击哪一环、如何预先化解。`
        : `现在轮到你【立论】。按你的构思写一篇 4 分钟的立论稿：开场（问候、概念界定、判断标准、一句话路线图）→ 各论点（按推理链一步步展开，证据只支撑关键一步）→ 结语（预先权衡：即使对方……我方的影响仍然更重要，因为……）。
【时长要求】4 分钟：按每分钟约 ${config.speechCharsPerMinute} 字，全文约 ${target} 字（${PF_GRACE_SEC} 秒宽限内最多约 ${max} 字，不少于 ${min} 字）。〔编号〕标注和标点不计入字数。`;
    }
    case "rebuttal": {
      const frontline = speaksSecond
        ? `你方后发言：${opp}的反驳已经攻击了我方立论，你必须用大约一半的时间回应这些攻击（逐条说明对方说了什么、为什么不成立），否则这些攻击视为成立。`
        : "你方先发言：集中火力攻击对方立论，不要重讲本方立论。";
      return planning
        ? `现在轮到你【反驳】（4 分钟）。先私下构思：针对${opp}立论的每个论点（公开记录里有论点编号），找出推理链中最薄弱的一环——现状不成立、因果链接推不出，还是影响被夸大——想清楚用什么推理或证据攻破；能把对方的机制反转成对我方有利的，优先反转。${frontline}如果你有具体理由怀疑${opp}某条已公开证据，可以在构思中提出质疑。`
        : `现在轮到你【反驳】。按你的构思写反驳稿：用路标说明你在回应哪个论点（如「先看对方第一个论点……」），逐个攻破。${frontline}
${lengthLine("rebuttal")}`;
    }
    case "question": {
      const grand = spec.stage === "grand_crossfire" ? "这是全场交叉质询，四位辩手都可以发言：聚焦将决定胜负的一两个交锋，为本方焦点总结铺路。" : "";
      return `现在是【交叉质询】第 ${spec.round}/${spec.rounds} 问，你向${nameOf(spec.target ?? "")}提问。${grand}问一个具体、简短的问题（一句话），目的是暴露对方推理链中没有支撑的一环、对方证据实际说的比对方声称的少的地方，或对方两位辩手之间的矛盾；可以追问对方刚才的回答。只提问，不发表论述。`;
    }
    case "answer":
      return `${nameOf(spec.target ?? "")}在交叉质询中问你：「${spec.question}」
请用一到三句话正面回答，不回避问题，守住本方立场。对方说得对的小地方可以坦然承认，但要说明为什么不影响我方结论；需要事实时优先回指已公开的证据。`;
    case "pf_summary": {
      const defense = speaksSecond
        ? ""
        : "你方先发言：你在总结里没有延续的防守，焦点总结里就不能再用。";
      return planning
        ? `现在轮到你【总结】（3 分钟）。先私下构思：到目前为止，本方哪 1-2 个论点最站得住？只选这 1-2 个延续（其余明确放弃），写出它们完整的推理链，以及对方对它们的每一次攻击和我方的回应。再选出我方对${opp}论点最有力的攻击（削弱或反转）。最后想好权衡：用哪个标准（规模、可能性、时间、可逆性）比较双方，为什么我方更重。${defense}`
        : `现在轮到你【总结】。按你的构思写总结稿：先延续本方 1-2 个论点（讲清推理链，提到证据时说出出处、简短回指，不要重读原文），回应对方对它们的攻击；再延续对${opp}论点的攻击；最后开始比较性权衡。${defense}
${lengthLine("pf_summary")}`;
    }
    case "final_focus":
      return planning
        ? `现在轮到你【焦点总结】（2 分钟，本方最后一次发言）。先私下构思：与本方总结保持一致——同样的论点、同样的权衡。想清楚评委应当投给我方的理由：即使对方赢了某一点，为什么我方仍然胜出。只能用本场已经出现过的论点和已经公开的证据，不得有新论点、新证据。`
        : `现在轮到你【焦点总结】。按你的构思写焦点总结：像替评委写判决理由一样，讲清本方赢在哪里、为什么比对方更重要。只回指已经公开的证据，不得提出新论点、首次引用新证据（会被系统剔除并交裁判扣分）。
${lengthLine("final_focus")}`;
    default:
      return "";
  }
}
