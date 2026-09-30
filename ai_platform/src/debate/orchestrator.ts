import { PLANNED_KINDS, turnLabel, type ChallengeRequest, type Debater, type TurnSpec } from "../agents/debater.js";
import type { AgentFactory } from "../agents/index.js";
import { JUDGE_PERSONAS } from "../agents/judge.js";
import type { PlanDraft } from "../agents/schemas.js";
import { config } from "../config.js";
import { describeError } from "../llm/client.js";
import { defaultTeam, describeModel } from "../llm/models.js";
import {
  ALL_DEBATERS,
  SIDES,
  SIDE_LABEL,
  STAGE_LABEL,
  type Challenge,
  type DebateRecord,
  type Stage,
  type Turn,
} from "../types.js";
import { formatDuration } from "./citation.js";
import { tally, toJudgeResult } from "./scoring.js";
import type { DebateStore } from "./store.js";
import { allEvidence, debaterState, formatChallengeResult, nameOf, teamEvidence } from "./transcript.js";
import { formatUsage } from "./usage.js";
import { checkChallenge, checkPlan, checkTurn, feedbackFor, planFeedback, type Issue } from "./validator.js";

/**
 * 一场 8 人辩论的完整流程（与常见的四辩赛制一致）：
 *   赛前准备：8 位辩手各自检索、核对网页，证据汇入本方共享的证据库（并行）。这是全场唯一的检索机会
 *   封存证据库：每条证据再打开一次原网页复核，打不开、摘录不在或出处无法确定的删除，然后封存
 *   立论：正一 → 反一（从这里开始任何辩手都不能再收集新证据；每方全场最多使用 N 条证据）
 *   驳论：正二 → 反二
 *   质询与小结：正三质询反一、反二并小结；反三质询正一、正二并小结
 *   自由辩论：双方交替发言
 *   总结陈词：反四 → 正四
 *   评委评议：裁判组独立评分 → 计票 → 主裁判综述
 * 每段发言依次进行，后发言的辩手能听到之前所有公开发言。任何一方质疑对方证据后，当场核查并公开结果。
 */

// 自由辩论的发言顺序：正反交替，每人一次
const FREE_ORDER = ["pro-4", "con-4", "pro-2", "con-1", "pro-3", "con-2", "pro-1", "con-3"];
// 重要发言最多修改两次（立论时长较难一次到位），短发言最多一次
const MAX_REVISIONS = { planned: 2, short: 1 };

/**
 * 并行执行，等所有任务都结束后再抛出第一个错误。Promise.all 在第一个失败时立即返回，
 * 其余任务仍在后台调用模型、改写记录，而这时辩论已标记为中断、可以续跑，两边会同时改同一份记录。
 */
async function settleAll<T>(tasks: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(tasks);
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
  return results.map((r) => (r as PromiseFulfilledResult<T>).value);
}

/**
 * 运行一场辩论。也用于断点续跑：记录里已有的发言按赛程顺序快进（不调用模型），从第一段缺失的发言接着跑。
 * 赛程只由代码顺序和 record.rules 决定，快进时逐段核对发言人与类型，对不上就报错，不硬接。
 */
export async function runDebate(record: DebateRecord, agents: AgentFactory, store: DebateStore) {
  // 影响赛程的规则随记录保存：续跑时沿用开赛时的规则，不受之后修改 .env 的影响
  const rules = (record.rules ??= {
    crossQuestionsPerTarget: config.crossQuestionsPerTarget,
    freeDebateTurns: config.freeDebateTurns,
  });
  // 双方的模型同理：开赛时选定，续跑沿用（旧记录没有，按当前默认配置补上）
  const teams = (record.input.teams ??= { pro: defaultTeam(), con: defaultTeam() });
  const done = record.turns.filter((t) => t.kind !== "check");
  let cursor = 0;
  const replaying = () => cursor < done.length;

  const log = (message: string, level: "info" | "warn" = "info") => store.update(record, message, level);
  const activity = (label?: string, debater?: string) => {
    record.activity = label ? { label, debater } : undefined;
    store.update(record);
  };
  const enter = (stage: Stage) => {
    record.stage = stage;
    if (!replaying()) log(`进入「${STAGE_LABEL[stage]}」环节`);
  };
  const debaters = new Map<string, Debater>(ALL_DEBATERS.map((d) => [d.id, agents.debater(record, d.id)]));
  const agent = (id: string) => debaters.get(id)!;

  /** 快进一段已完成的发言：核对它就是赛程此处应有的发言；中断时还没核查完的质疑补跑核查。 */
  async function replay(id: string, spec: TurnSpec): Promise<Turn> {
    const turn = done[cursor++];
    if (turn.speaker !== id || turn.kind !== spec.kind || (turn.target ?? "") !== (spec.target ?? "")) {
      const expected = `${nameOf(id)}${turnLabel(spec)}`;
      const actual = `${nameOf(turn.speaker)}${turnLabel({ kind: turn.kind as TurnSpec["kind"], stage: turn.stage, target: turn.target })}`;
      throw new Error(`记录与赛程不一致，无法续跑：第 ${turn.index + 1} 段应为${expected}，记录里是${actual}`);
    }
    const challenge = record.challenges.find((c) => c.id === turn.challengeId && c.turn === turn.index);
    if (challenge?.status === "checking") await runCheck(challenge);
    return turn;
  }

  /** 一位辩手发言：构思（重要发言）→ 撰写 → 校验与修改 → 公开 → 处理质疑。 */
  async function speak(id: string, spec: TurnSpec): Promise<Turn> {
    if (replaying()) return replay(id, spec);
    const me = debaterState(record, id);
    const label = `${me.name}${turnLabel(spec)}`;
    const index = record.turns.length;
    const planned = PLANNED_KINDS.includes(spec.kind);

    let plan: PlanDraft | null = null;
    // 续跑：中断前已经完成的构思直接沿用（构思用最高推理强度，重做最贵）
    const saved = planned ? me.plans.find((p) => p.turn === index) : undefined;
    if (saved) {
      plan = saved.plan as PlanDraft;
    } else if (planned) {
      activity(`${me.name}正在构思${turnLabel(spec)}的逻辑链`, id);
      plan = await agent(id).plan(spec);
      let problems = checkPlan(record, me, spec, plan);
      if (problems.length) {
        log(`${label}构思有 ${problems.length} 处需完善（${problems[0]}${problems.length > 1 ? " 等" : ""}），已要求重新构思`, "warn");
        activity(`${me.name}正在完善构思`, id);
        plan = await agent(id).plan(spec, planFeedback(problems));
        problems = checkPlan(record, me, spec, plan);
        if (problems.length) log(`${label}构思仍有 ${problems.length} 处未达要求：${problems.join("；")}`, "warn");
      }
      me.plans.push({ turn: index, plan });
    }

    activity(`${me.name}正在撰写${turnLabel(spec)}`, id);
    let written = await agent(id).write(spec, plan);
    let checked = checkTurn(record, me, spec, written, index);
    const everIssues = new Map<string, Issue>();
    const maxRevisions = planned ? MAX_REVISIONS.planned : MAX_REVISIONS.short;
    for (let round = 1; round <= maxRevisions && (checked.issues.length || checked.revisions.length); round++) {
      for (const i of checked.issues) everIssues.set(`${i.kind}:${i.ref}`, i);
      const problems = [
        checked.issues.length ? `${checked.issues.length} 处无效引用` : "",
        checked.revisions.length ? `${checked.revisions.length} 处需修改（${checked.revisions[0]}${checked.revisions.length > 1 ? " 等" : ""}）` : "",
      ].filter(Boolean);
      log(`${label}第 ${round} 稿有 ${problems.join("、")}，已要求修改`, "warn");
      activity(`${me.name}正在修改${turnLabel(spec)}（第 ${round + 1} 稿）`, id);
      written = await agent(id).write(spec, plan, feedbackFor(checked.issues, checked.revisions, checked.preview));
      checked = checkTurn(record, me, spec, written, index);
    }
    const remaining = new Set(checked.issues.map((i) => `${i.kind}:${i.ref}`));
    for (const [key, issue] of everIssues) if (!remaining.has(key)) record.violations.push({ ...issue, corrected: true });
    record.violations.push(...checked.issues.map((i) => ({ ...i, corrected: false })));
    if (checked.issues.length) log(`${label}仍有 ${checked.issues.length} 处无效引用，已剔除并提交裁判组`, "warn");
    if (checked.revisions.length) log(`${label}修改后仍有 ${checked.revisions.length} 处未达要求：${checked.revisions.join("；")}`, "warn");

    // 公开发言；本方证据首次被引用时随之公开（不论是谁检索到的）
    const turn: Turn = { index, ...checked.turn };
    record.turns.push(turn);
    const team = teamEvidence(record, me.side);
    for (const eid of turn.evidenceIds) {
      const e = team.find((x) => x.id === eid);
      if (e && e.disclosedAt === undefined) e.disclosedAt = index;
    }
    activity();
    log(`${label}${turn.durationSec ? `（约 ${formatDuration(turn.durationSec)}）` : ""}`);

    const challenge = written.challenge ?? (planned ? plan?.challenge : null);
    if (challenge) await raiseChallenge(id, challenge, index);
    return turn;
  }

  /** 质疑对方证据：校验是否合规，然后由中立的核查员打开原网页、联网搜索，当场公开结果。 */
  async function raiseChallenge(id: string, req: ChallengeRequest, raisedAt: number) {
    const me = debaterState(record, id);
    const problem = checkChallenge(record, me, req);
    if (problem) {
      log(`${me.name}提出的质疑未受理：${problem}`, "warn");
      return;
    }
    const evidenceId = req.evidence_id.trim().toUpperCase();
    const evidence = allEvidence(record).find((e) => e.id === evidenceId)!;
    const challenge: Challenge = {
      id: record.challenges.length + 1,
      side: me.side,
      by: me.id,
      turn: raisedAt,
      evidenceId,
      owner: evidence.owner,
      reason: req.reason.trim(),
      status: "checking",
    };
    record.challenges.push(challenge);
    record.turns[raisedAt].challengeId = challenge.id;
    log(`${me.name}质疑${nameOf(evidence.owner)}的证据〔${evidenceId}〕：${challenge.reason}`);
    await runCheck(challenge);
  }

  /** 核查一次质疑并公开结果。 */
  async function runCheck(challenge: Challenge) {
    const { evidenceId } = challenge;
    const evidence = allEvidence(record).find((e) => e.id === evidenceId)!;
    activity(`证据核查中：打开〔${evidenceId}〕的原网页并联网搜索`);

    const result = await agents.factCheck(record, challenge, evidence, log);
    Object.assign(challenge, { status: "done", ...result });
    if (result.verdict === "不成立") evidence.invalid = true;
    record.turns.push({
      index: record.turns.length,
      stage: record.stage,
      kind: "check",
      speaker: "referee",
      text: formatChallengeResult(challenge),
      evidenceIds: [evidenceId],
      challengeId: challenge.id,
    });
    activity();
    log(
      `证据核查：〔${evidenceId}〕${result.verdict}${result.verdict === "不成立" ? "，此后不得再引用" : ""}`,
      result.verdict === "成立" ? "info" : "warn",
    );
  }

  /** 封存证据库：复核每条证据后按顺序重新编号（此时还没有证据公开，编号可以安全调整），此后不能再检索。 */
  async function lockEvidence() {
    activity("封存前复核：重新打开每条证据的原网页");
    await settleAll(ALL_DEBATERS.map((d) => agent(d.id).recheck(log)));
    for (const d of record.debaters) {
      const prefix = `${d.side === "pro" ? "P" : "C"}${d.position}`;
      d.bank.forEach((e, i) => (e.id = `${prefix}-${i + 1}`));
    }
    record.evidenceLockedAt = new Date().toISOString();
    const counts = SIDES.map((side) => `${SIDE_LABEL[side]} ${teamEvidence(record, side).length} 条`).join("、");
    log(
      `证据库已封存：${counts}（每方最多收集 ${config.evidencePerSide} 条）。立论开始后任何辩手都不能再检索；每方全场最多使用 ${config.maxEvidenceUsedPerSide} 条证据`,
    );
    activity();
  }

  try {
    // 赛前准备：8 位辩手并行（博查搜索在全局排队限速）。
    // 已有发言就说明证据库早已封存（旧版记录没有 evidenceLockedAt），绝不能再封存一次：封存会给证据重新编号，已有发言里的引用会全部错位
    if (!record.evidenceLockedAt && done.length === 0) {
      if (record.log.length === 0) {
        log(SIDES.map((side) => `${SIDE_LABEL[side]}：${describeModel(teams[side].model, teams[side].effort)}`).join("　"));
      }
      enter("research");
      activity("八位辩手正在独立检索资料、打开网页核对原文");
      await settleAll(
        ALL_DEBATERS.map(async (d) => {
          const me = debaterState(record, d.id);
          if (me.prepared) return; // 续跑：中断前已经准备完成的辩手不再检索
          await agent(d.id).prepare(log);
          me.prepared = true;
          const ok = me.searchCalls.filter((c) => c.ok).length;
          log(
            `${d.name}准备完成：博查搜索 ${ok}/${me.searchCalls.length} 次成功，丢弃 ${me.rejectedPages.length} 个无法核对的网页，证据库 ${me.bank.length} 条`,
            me.bank.length ? "info" : "warn",
          );
        }),
      );
      await lockEvidence();
    }

    enter("opening");
    await speak("pro-1", { kind: "opening", stage: "opening" });
    await speak("con-1", { kind: "opening", stage: "opening" });

    enter("rebuttal");
    for (const id of ["pro-2", "con-2"]) await speak(id, { kind: "rebuttal", stage: "rebuttal" });

    enter("cross");
    const rounds = rules.crossQuestionsPerTarget;
    for (const [asker, targets] of [
      ["pro-3", ["con-1", "con-2"]],
      ["con-3", ["pro-1", "pro-2"]],
    ] as const) {
      for (const target of targets) {
        for (let round = 1; round <= rounds; round++) {
          const q = await speak(asker, { kind: "question", stage: "cross", target, round, rounds });
          await speak(target, { kind: "answer", stage: "cross", target: asker, question: q.text });
        }
      }
      await speak(asker, { kind: "summary", stage: "cross" });
    }

    enter("free");
    for (let i = 0; i < rules.freeDebateTurns; i++) {
      await speak(FREE_ORDER[i % FREE_ORDER.length], { kind: "free", stage: "free", round: i + 1, rounds: rules.freeDebateTurns });
    }

    enter("closing");
    await speak("con-4", { kind: "closing", stage: "closing" });
    await speak("pro-4", { kind: "closing", stage: "closing" });

    enter("judging");
    activity("评委组正在独立评议");
    const personas = JUDGE_PERSONAS.slice(0, record.input.judgeCount);
    const results = await settleAll(
      personas.map(async (persona) => {
        // 续跑：中断前已经交卷的裁判不再重评
        const existing = record.judges.find((j) => j.judgeId === persona.id);
        if (existing) return existing;
        const result = toJudgeResult(persona, await agents.judge(record, persona));
        record.judges.push(result);
        log(`${persona.name}投票给${SIDE_LABEL[result.winner]}（正方 ${result.scores.pro.total} : 反方 ${result.scores.con.total}）`);
        return result;
      }),
    );
    record.judges = results; // 按裁判固定顺序展示

    const counted = tally(results);
    activity("主裁判正在撰写综合评议");
    const summary = await agents.summarize(record, results, counted);
    record.verdict = { ...counted, summary };
    record.stage = "finished";
    record.status = "done";
    activity();
    log(counted.winner === "tie" ? "裁判组判定：平局" : `裁判组判定：${SIDE_LABEL[counted.winner]}获胜`);
  } catch (err) {
    record.status = "error";
    record.error = describeError(err);
    record.activity = undefined;
    console.error(`辩论 ${record.id} 失败：`, err);
    store.update(record, record.error, "error");
  }
  const usage = formatUsage(record);
  if (usage) {
    console.log(`[用量] 辩论 ${record.id} ${usage}`);
    log(usage);
  }
}
