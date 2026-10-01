import type { JudgeDraft } from "../agents/schemas.js";
import {
  CRITERIA,
  SIDES,
  type DebaterScore,
  type JudgePersona,
  type JudgeResult,
  type Side,
  type SideScores,
  type Verdict,
} from "../types.js";

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));
const round1 = (n: number) => Math.round(n * 10) / 10;

function toSideScores(raw: Record<(typeof CRITERIA)[number], number>): SideScores {
  const scores = Object.fromEntries(CRITERIA.map((c) => [c, clamp(raw[c], 1, 10)])) as SideScores;
  scores.total = CRITERIA.reduce((sum, c) => sum + scores[c], 0);
  return scores;
}

/** debaterIds：本场的辩手（四辩制 8 人，公共论坛制 4 人），按展示顺序。 */
export function toJudgeResult(persona: JudgePersona, draft: JudgeDraft, debaterIds: string[]): JudgeResult {
  // 只保留本场辩手的分数，每人一条；模型漏掉的辩手不补分
  const byId = new Map<string, DebaterScore>();
  for (const d of draft.debaters) {
    const id = d.id.trim().toLowerCase();
    if (debaterIds.includes(id) && !byId.has(id)) {
      byId.set(id, { debater: id, score: clamp(d.score, 60, 100), comment: d.comment.trim() });
    }
  }
  return {
    judgeId: persona.id,
    name: persona.name,
    focus: persona.focus,
    scores: { pro: toSideScores(draft.pro), con: toSideScores(draft.con) },
    debaterScores: debaterIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])),
    winner: draft.winner,
    reason: draft.reason.trim(),
    keyMoments: draft.key_moments,
  };
}

/**
 * 计票：多数票决定胜负；票数相同（偶数裁判）时比较平均总分；仍相同则平局。
 * 辩手个人分取各裁判平均，最高者为最佳辩手。胜负完全由代码确定，主裁判的综述不能改判。
 */
export function tally(results: JudgeResult[], debaterIds: string[]): Omit<Verdict, "summary"> {
  const votes: Record<Side, number> = { pro: 0, con: 0 };
  for (const r of results) votes[r.winner]++;

  const averageScores = Object.fromEntries(
    SIDES.map((side) => {
      const avg = Object.fromEntries(
        [...CRITERIA, "total" as const].map((c) => [
          c,
          round1(results.reduce((sum, r) => sum + r.scores[side][c], 0) / Math.max(results.length, 1)),
        ]),
      ) as SideScores;
      return [side, avg];
    }),
  ) as Record<Side, SideScores>;

  const debaterScores: DebaterScore[] = debaterIds.flatMap((id) => {
    const given = results.flatMap((r) => r.debaterScores.filter((s) => s.debater === id));
    if (!given.length) return [];
    const score = round1(given.reduce((n, s) => n + s.score, 0) / given.length);
    return [{ debater: id, score, comment: given.map((s) => s.comment).join(" / ") }];
  });
  const best = debaterScores.reduce<DebaterScore | undefined>((a, b) => (!a || b.score > a.score ? b : a), undefined)?.debater;

  const base = { votes, averageScores, debaterScores, best };
  if (votes.pro !== votes.con) {
    return { ...base, winner: votes.pro > votes.con ? "pro" : "con", decidedBy: "majority" };
  }
  const diff = averageScores.pro.total - averageScores.con.total;
  if (diff !== 0) return { ...base, winner: diff > 0 ? "pro" : "con", decidedBy: "score_tiebreak" };
  return { ...base, winner: "tie", decidedBy: "tie" };
}
