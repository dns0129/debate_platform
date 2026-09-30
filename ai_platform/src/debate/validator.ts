import type { ChallengeRequest, TurnSpec, WrittenTurn } from "../agents/debater.js";
import type { PlanDraft } from "../agents/schemas.js";
import { config } from "../config.js";
import {
  SIDE_LABEL,
  opponentOf,
  type Argument,
  type DebateRecord,
  type DebaterState,
  type Evidence,
  type Turn,
  type Violation,
} from "../types.js";
import {
  citationRevisions,
  densityRevision,
  extractRefs,
  normalizeMarkers,
  openingBudget,
  openingLengthRevision,
  speechLengthRevision,
  sharedDataPoint,
  spokenChars,
  timing,
} from "./citation.js";
import { allEvidence, evidenceLeft, evidenceUsed, nameOf, teamEvidence } from "./transcript.js";

// 发言校验分两类：
// - 引用违规（issues）：引用了不存在的证据、看不到的证据（对方未公开的）、已被核查判定不成立的证据，
//   超出本方全场证据使用上限的证据，或提到了没出现过的论点。修正后仍存在的剔除并交给裁判组扣分。
// - 修改意见（revisions）：引用写法、引用密度、重复数据、每个论点的证据数、立论时长、构思的推理链是否完整。
//   只反馈给辩手修改，不计入违规。
// 证据与论点列表一律从正文里的编号提取，正文就是唯一依据。

export type Issue = Omit<Violation, "corrected">;

/** 这位辩手此刻可以引用的证据：本方共享的证据库 + 对方已公开的证据（已判不成立的除外）。 */
function visibleEvidence(record: DebateRecord, me: DebaterState): Map<string, Evidence> {
  const visible = allEvidence(record).filter((e) => !e.invalid && (e.side === me.side || e.disclosedAt !== undefined));
  return new Map(visible.map((e) => [e.id, e]));
}

const argumentIds = (record: DebateRecord) => new Set(record.turns.flatMap((t) => t.arguments?.map((a) => a.id) ?? []));

export interface CheckedTurn {
  turn: Omit<Turn, "index">;
  issues: Issue[];
  revisions: string[];
  /** 发言全文，辩手修改时作为「上一稿」 */
  preview: string;
}

export function checkTurn(
  record: DebateRecord,
  me: DebaterState,
  spec: TurnSpec,
  written: WrittenTurn,
  turnIndex: number,
): CheckedTurn {
  const issues: Issue[] = [];
  const seen = new Set<string>();
  const addIssue = (kind: Issue["kind"], ref: string, detail: string) => {
    if (seen.has(`${kind}:${ref}`)) return;
    seen.add(`${kind}:${ref}`);
    issues.push({ turn: turnIndex, speaker: me.id, kind, ref, detail });
  };

  const visible = visibleEvidence(record, me);
  const all = new Map(allEvidence(record).map((e) => [e.id, e]));
  const knownArgs = argumentIds(record);
  const disclosedBefore = new Set(allEvidence(record).filter((e) => e.disclosedAt !== undefined).map((e) => e.id));

  const keepEvidence = (ids: string[]) =>
    ids.filter((id) => {
      if (visible.has(id)) return true;
      const e = all.get(id);
      if (e?.invalid) addIssue("invalid_evidence", id, `引用了已被核查判定不成立的证据「${id}」`);
      else if (e) addIssue("unknown_evidence", id, `引用了「${id}」，但这是${nameOf(e.owner)}尚未公开的证据，你方不可能看到`);
      else addIssue("unknown_evidence", id, `引用了不存在的证据「${id}」`);
      return false;
    });
  const keepArguments = (ids: string[]) =>
    ids.filter((id) => {
      if (knownArgs.has(id)) return true;
      addIssue("unknown_argument", id, `提及了辩论中从未出现过的论点「${id}」`);
      return false;
    });

  // 每方全场最多使用 N 条证据：按正文中出现的顺序，本段首次引用的本方证据超出剩余额度的部分剔除
  const used = evidenceUsed(record, me.side);
  const left = evidenceLeft(record, me.side);
  const withinLimit = (ids: string[]) => {
    const fresh = ids.filter((id) => visible.get(id)?.side === me.side && !disclosedBefore.has(id));
    const over = new Set(fresh.slice(left));
    for (const id of over) {
      addIssue(
        "over_limit",
        id,
        `首次引用了本方证据「${id}」，但每方全场最多使用 ${config.maxEvidenceUsedPerSide} 条证据，本方此前已用 ${used} 条，这段发言最多只能再首次引用 ${left} 条（本段首次引用了 ${fresh.length} 条）：请删去多出的引用，改用推理或回指已公开的证据`,
      );
    }
    return ids.filter((id) => !over.has(id));
  };

  const citeCtx = { evidence: visible, disclosed: disclosedBefore };
  const revisions = new Set<string>();

  let text: string;
  let parts: Turn["parts"];
  let args: Argument[] | undefined;

  if (spec.kind === "opening" && written.opening) {
    const prefix = me.side === "pro" ? "PA" : "CA";
    const d = written.opening;
    const intro = normalizeMarkers(d.intro);
    const conclusion = normalizeMarkers(d.conclusion);
    args = d.arguments.map((a, i) => ({ id: `${prefix}${i + 1}`, title: normalizeMarkers(a.title) }));
    parts = [
      { label: "开场", text: intro },
      ...d.arguments.map((a, i) => ({
        label: `论点${i + 1}`,
        argumentId: args![i].id,
        title: args![i].title,
        text: normalizeMarkers(a.reasoning),
      })),
      { label: "结语", text: conclusion },
    ];
    for (const p of parts) {
      if (!p.argumentId) continue;
      const own = extractRefs(p.text).evidence.filter((id) => visible.get(id)?.side === me.side);
      if (own.length > config.maxEvidencePerPoint) {
        revisions.add(`论点「${p.title}」引用了 ${own.length} 条证据，超过每个论点 ${config.maxEvidencePerPoint} 条的上限：保留最能支撑推理关键一步的证据，其余篇幅用来推理`);
      }
    }
    text = parts.map((p) => (p.title ? `${p.title}\n${p.text}` : p.text)).join("\n\n");
    const budget = openingBudget(d.arguments.length);
    const lengthRevision = openingLengthRevision(
      spokenChars(text),
      parts.map((p) => ({
        label: p.argumentId ? `${p.label}「${p.title}」` : p.label,
        chars: spokenChars(p.title ? `${p.title}\n${p.text}` : p.text),
        budget: p.argumentId ? budget.perArgument : p.label === "开场" ? budget.intro : budget.conclusion,
      })),
    );
    if (lengthRevision) revisions.add(lengthRevision);
  } else {
    text = normalizeMarkers(written.text);
    const lengthRevision = speechLengthRevision(spec.kind, spokenChars(text));
    if (lengthRevision) revisions.add(lengthRevision);
  }

  const refs = extractRefs(text);
  const evidenceIds = withinLimit(keepEvidence(refs.evidence));
  keepArguments(refs.arguments);

  for (const r of citationRevisions(text, citeCtx)) revisions.add(r);
  const density = densityRevision(text);
  if (density) revisions.add(density);

  const preview = parts ? parts.map((p) => `（${p.label}）${p.title ? `${p.title}\n` : ""}${p.text}`).join("\n\n") : text;
  return {
    turn: {
      stage: spec.stage,
      kind: spec.kind,
      speaker: me.id,
      target: spec.target,
      text,
      parts,
      arguments: args,
      evidenceIds,
      ...timing(spokenChars(text)),
    },
    issues,
    revisions: [...revisions],
    preview,
  };
}

/** 构思是否把逻辑链想清楚了：推理链步数、每点证据数、证据是否在本方证据库中、不同论点有没有用同一个数据。 */
export function checkPlan(record: DebateRecord, me: DebaterState, spec: TurnSpec, plan: PlanDraft): string[] {
  const out: string[] = [];
  const team = new Map(teamEvidence(record, me.side).filter((e) => !e.invalid).map((e) => [e.id, e]));
  if (plan.points.length === 0) out.push("构思里没有任何论点");
  if (spec.kind === "opening" && (plan.points.length < 2 || plan.points.length > 4)) {
    out.push(`立论应有 2-4 个论点，当前有 ${plan.points.length} 个`);
  }
  if (spec.kind === "opening" && (!plan.definitions.trim() || !plan.criterion.trim())) {
    out.push("立论构思缺少概念界定或判断标准");
  }
  const used: Evidence[] = [];
  const fresh = new Set<string>();
  plan.points.forEach((p, i) => {
    const label = `第 ${i + 1} 点「${p.claim.slice(0, 20)}」`;
    if (p.logic_chain.length < 3) out.push(`${label}的推理链只有 ${p.logic_chain.length} 步：请写出 3-5 步，说明前提如何一步步推出主张`);
    if (p.evidence.length > config.maxEvidencePerPoint) out.push(`${label}用了 ${p.evidence.length} 条证据，最多 ${config.maxEvidencePerPoint} 条`);
    for (const ref of p.evidence) {
      const e = team.get(ref.evidence_id.trim().toUpperCase());
      if (!e) {
        out.push(`${label}用到的「${ref.evidence_id}」不在本方证据库中（或已被判定不成立）`);
        continue;
      }
      const dup = used.find((u) => u.id === e.id || sharedDataPoint(u, e));
      if (dup) out.push(`${label}的「${e.id}」与「${dup.id}」重复（同一条证据或同一个数据），每个数据只用一次`);
      used.push(e);
      if (e.disclosedAt === undefined) fresh.add(e.id);
    }
  });
  const left = evidenceLeft(record, me.side);
  if (fresh.size > left) {
    out.push(
      left === 0
        ? `本方 ${config.maxEvidenceUsedPerSide} 条证据的额度已经用完，构思里却要首次使用 ${fresh.size} 条（${[...fresh].join("、")}）：只能回指已公开的证据，其余步骤用推理支撑`
        : `构思里要首次使用 ${fresh.size} 条本方证据（${[...fresh].join("、")}），但每方全场最多使用 ${config.maxEvidenceUsedPerSide} 条，本方只剩 ${left} 条：只保留最关键的 ${left} 条，其余步骤用推理支撑或回指已公开的证据`,
    );
  }
  return out;
}

/** 质疑是否有效：对象必须是对方已公开、尚未被质疑过、仍然有效的证据，且本方还有质疑次数。 */
export function checkChallenge(record: DebateRecord, me: DebaterState, req: ChallengeRequest): string | null {
  const id = req.evidence_id.trim().toUpperCase();
  const e = allEvidence(record).find((x) => x.id === id);
  const left = config.maxChallengesPerSide - record.challenges.filter((c) => c.side === me.side).length;
  if (left <= 0) return `${SIDE_LABEL[me.side]}的 ${config.maxChallengesPerSide} 次质疑已经用完`;
  if (!e || e.side !== opponentOf(me.side)) return `「${id}」不是对方的证据`;
  if (e.disclosedAt === undefined) return `「${id}」对方尚未公开引用`;
  if (e.invalid) return `「${id}」已被判定不成立`;
  if (record.challenges.some((c) => c.evidenceId === id)) return `「${id}」已经被质疑过`;
  if (!req.reason.trim()) return "质疑没有给出理由";
  return null;
}

/** 给辩手的修改提示：附上一稿全文，要求在此基础上修改。 */
export function feedbackFor(issues: Issue[], revisions: string[], preview: string): string {
  const lines = [...issues.map((i) => i.detail), ...revisions].map((line) => `- ${line}`).join("\n");
  return `【你的上一稿未通过系统校验】
上一稿全文：
<<<
${preview}
>>>

需要修改的问题：
${lines}

请在上一稿的基础上逐条修改，输出修改后的完整发言。`;
}

export function planFeedback(problems: string[]): string {
  return `【你的上一版构思有问题】\n${problems.map((p) => `- ${p}`).join("\n")}\n请修正后重新输出完整构思。`;
}
