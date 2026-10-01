import { config } from "../config.js";
import { PF_GRACE_SEC, openingDurationLine } from "../debate/citation.js";
import { formatForJudges, nameOf } from "../debate/transcript.js";
import { usageFor } from "../debate/usage.js";
import { callStructured } from "../llm/client.js";
import { SIDE_LABEL, formatOf, type DebateFormat, type DebateRecord, type JudgePersona, type JudgeResult, type Verdict } from "../types.js";
import { JudgeDraft, VerdictSummaryDraft } from "./schemas.js";

// 裁判组：每位裁判有不同的评审侧重，彼此独立评分，互相看不到对方的判决。
// 裁判只看公开信息（发言、公开引用的证据、证据核查结果），看不到辩手的私有资料。
// 按人数取前 N 位，建议使用奇数人数以避免平票。
export const JUDGE_PERSONAS: JudgePersona[] = [
  {
    id: "logic",
    name: "逻辑裁判",
    focus: "论证结构与推理严密性",
    instructions:
      "重点审查每个论点是否有完整的推理链：前提是否成立、每一步能否推出下一步，是否存在偷换概念、以偏概全、因果倒置；只罗列引用而没有推理的论点要明显扣分。驳论是否打中对方推理链的具体环节。",
  },
  {
    id: "evidence",
    name: "证据裁判",
    focus: "证据质量与引用诚信",
    instructions:
      "重点审查证据是否权威、相关，是否用在推理的关键一步；引用时是否讲清出处，转述是否忠实于原文；同一数据反复讲不加分。被核查判定不成立的证据及依赖它的论证不予采信；无理的质疑也应在交锋维度扣分。",
  },
  {
    id: "clash",
    name: "交锋裁判",
    focus: "攻防与回应",
    instructions: "重点审查双方是否正面回应了对方最强的论点，哪些论点被驳倒后未能补救，质询中谁拿到了让步，哪一方掌握了辩论的主动权。",
  },
  {
    id: "audience",
    name: "观众代表",
    focus: "说服力与表达",
    instructions: "以一名理性普通听众的视角，评估哪一方的论述更清晰易懂、更有说服力。",
  },
  {
    id: "value",
    name: "价值裁判",
    focus: "价值权衡与现实影响",
    instructions: "重点审查双方是否讲清了论题背后的价值冲突，对现实影响的权衡是否全面、合理。",
  },
];

// 公共论坛制的评判惯例（NSDA）：论点要一路延续才算数，胜负取决于权衡
const PF_JUDGING = `这是一场公共论坛制（PF）辩论：正反各两位辩手，一辩负责立论和总结，二辩负责反驳和焦点总结，另有三轮交叉质询。公共论坛制的评判惯例：
- 只有一路延续到总结和焦点总结的论点才计入；焦点总结中首次出现的论点和证据不予考虑。
- 对方没有回应的论点视为成立；被攻击后本方在后续发言中没有回应的论点视为被打掉。后发言一方的反驳应当回应对方对本方立论的攻击。
- 交叉质询本身不直接计分，其中的让步只有被带进之后的发言才算数。
- 双方都有论点成立时，看谁的权衡更有说服力（规模、可能性、时间、可逆性），以及是否把双方放在同一把尺子上比较。
- 对照证据原文：发言对证据的转述超出原文的，那条证据只按原文实际说的内容采信。`;

function judgeSystem(persona: JudgePersona, format: DebateFormat): string {
  const pf = format === "pf";
  const roles = pf
    ? "给四位辩手分别打个人分（60-100 的整数），并各写一句点评，依据是 TA 在自己职责环节（一辩：立论与总结；二辩：反驳与焦点总结）和交叉质询中的表现。"
    : "给八位辩手分别打个人分（60-100 的整数），并各写一句点评，依据是 TA 在自己职责环节（立论、驳论、质询与小结、总结陈词）和自由辩论中的表现。";
  const timing = pf
    ? `- 规定时长：立论、反驳各 4 分钟，总结 3 分钟，焦点总结 2 分钟，各有 ${PF_GRACE_SEC} 秒宽限（记录中标注了每段发言按正常语速估算的时长）。在宽限内不因时长扣分；超过宽限的可在表达说服维度酌情扣分。`
    : `- 立论的标准时长${openingDurationLine()}（记录中标注了每段发言按正常语速估算的时长），在此范围内不因时长扣分；超出或不足这个范围可在表达说服维度酌情扣分。`;
  return `你是辩论赛裁判组成员「${persona.name}」，评审侧重：${persona.focus}。
${persona.instructions}
${pf ? `\n${PF_JUDGING}\n` : ""}
评分规则：
- 对正反双方分别在四个维度打分，每项 1-10 的整数：论证质量、证据运用、交锋反驳、表达说服。你的侧重维度应作为判断胜负的主要依据，但四项都要打分。
- ${roles}
- 只评估双方在本场辩论中的表现，你个人对论题的看法不得影响判决。
- 只依据辩论记录中实际出现的内容评判。没有公开证据支撑的事实性说法视为无依据。
- 「系统引用校验」中列出的未修正违规，必须在对应一方的证据运用维度扣分。
- 赛制规定证据只能在赛前收集，每方全场最多使用 ${config.maxEvidenceUsedPerSide} 条证据；超出上限的引用已被系统剔除，其内容视为无依据。
${timing}
- 必须判出胜方，不允许平局。`;
}

export function judge(record: DebateRecord, persona: JudgePersona): Promise<JudgeDraft> {
  return callStructured({
    model: config.judgeModel,
    effort: config.judgeEffort,
    system: judgeSystem(persona, formatOf(record)),
    prompt: `${formatForJudges(record)}\n\n请给出你的评分与判决。`,
    schema: JudgeDraft,
    usage: usageFor(record, "评议", config.judgeModel),
  });
}

/** 主裁判综述。胜负已由投票确定，这里只负责写评议，不能改判。 */
export async function summarize(
  record: DebateRecord,
  results: JudgeResult[],
  tally: Omit<Verdict, "summary">,
): Promise<string> {
  const ballots = results
    .map(
      (r) =>
        `${r.name}（${r.focus}）投票：${SIDE_LABEL[r.winner]}；正方 ${r.scores.pro.total} 分，反方 ${r.scores.con.total} 分。理由：${r.reason}`,
    )
    .join("\n");
  const outcome =
    tally.winner === "tie"
      ? "平局"
      : `${SIDE_LABEL[tally.winner]}获胜（${tally.votes.pro}:${tally.votes.con}${tally.decidedBy === "score_tiebreak" ? "，票数相同按平均总分判定" : ""}）`;
  const best = tally.best ? `最佳辩手：${nameOf(tally.best)}` : "";

  const draft = await callStructured({
    model: config.judgeModel,
    effort: config.judgeEffort,
    system: "你是辩论赛主裁判，负责宣读裁判组的综合评议。胜负和最佳辩手已由裁判组评分决定，你不能更改结果，只需解释。",
    prompt: `论题：${record.input.topic}

各位裁判的判决：
${ballots}

最终结果：${outcome}
${best}

请写一段综合评议：说明胜负的关键原因、双方各自的亮点与不足。`,
    schema: VerdictSummaryDraft,
    usage: usageFor(record, "评议", config.judgeModel),
  });
  return draft.summary;
}
