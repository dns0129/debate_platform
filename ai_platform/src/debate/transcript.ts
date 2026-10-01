import { config } from "../config.js";
import {
  ALL_DEBATERS,
  FORMAT_LABEL,
  SIDE_LABEL,
  TEAM_SIZE,
  formatOf,
  turnKindLabel,
  type Challenge,
  type DebateRecord,
  type DebaterState,
  type Evidence,
  type Side,
  type Turn,
} from "../types.js";
import { cleanTitle, formatDuration, sourceName } from "./citation.js";

// 把辩论记录渲染成给模型看的纯文本，并严格区分可见范围：
// - 公开信息：所有发言、已在发言中引用（公开）的证据、证据核查结果——所有辩手和裁判都能看到；
// - 本方信息：同队辩手共享的证据库（含尚未公开的证据）——对方看不到；
// - 私有信息：每位辩手自己的构思——只有本人能看到。
// 给辩手的材料按「全场相同 → 本方相同 → 本人」的顺序排列，DeepSeek 才能对前面的长前缀命中缓存。

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

export const nameOf = (id: string) => (id === "referee" ? "证据核查" : ALL_DEBATERS.find((d) => d.id === id)?.name ?? id);

export function debaterState(record: DebateRecord, id: string): DebaterState {
  const d = record.debaters.find((x) => x.id === id);
  if (!d) throw new Error(`未知辩手 ${id}`);
  return d;
}

export function allEvidence(record: DebateRecord): Evidence[] {
  return record.debaters.flatMap((d) => d.bank);
}

/** 本方辩手共享的证据（含尚未公开的）。 */
export function teamEvidence(record: DebateRecord, side: Side): Evidence[] {
  return record.debaters.filter((d) => d.side === side).flatMap((d) => d.bank);
}

/** 已经在发言中公开的证据。 */
export function disclosedEvidence(record: DebateRecord): Evidence[] {
  return allEvidence(record).filter((e) => e.disclosedAt !== undefined);
}

/**
 * 本方已经使用的证据条数：一条证据第一次在发言中被引用（公开）就算用掉一条，不论是谁引用的；
 * 之后再回指不重复计数，引用或反驳对方的证据不计入。
 */
export function evidenceUsed(record: DebateRecord, side: Side): number {
  return teamEvidence(record, side).filter((e) => e.disclosedAt !== undefined).length;
}

/** 本方还能首次引用几条证据。 */
export function evidenceLeft(record: DebateRecord, side: Side): number {
  return Math.max(0, config.maxEvidenceUsedPerSide - evidenceUsed(record, side));
}

/** 证据卡片。给辩手的是精简版：不带网页标题和链接（撰写发言用不到），原文摘录也截短。 */
function formatEvidenceCard(e: Evidence, full = true): string {
  const s = e.sources[0];
  const meta = [s?.site, s?.published].filter(Boolean).join("，");
  const status = e.invalid ? "【已被核查判定不成立，不得再引用】" : "";
  const lines = [`[${e.id}]${status} ${e.claim}`, `    出处：${sourceName(e)}${!full && meta ? `（${meta}）` : ""}`];
  if (s && full) lines.push(`    网页：《${cleanTitle(s.title, s.site)}》${meta ? `（${meta}）` : ""} ${s.url}`);
  if (s) lines.push(`    原文：「${clip(s.quote, full ? 300 : 200)}」`);
  return lines.join("\n");
}

/** 本方共享的证据库：本方辩手各自检索、核对的证据，同队都可以引用。同队辩手看到的内容完全相同。 */
export function formatTeamBank(record: DebateRecord, side: Side): string {
  const bank = teamEvidence(record, side);
  if (bank.length === 0) return "【本方证据库】\n（为空：本方没有检索到可核对的证据，只能进行推理论证）";
  const cards = bank.map((e) => {
    const used = e.disclosedAt !== undefined ? `已在第 ${e.disclosedAt + 1} 段发言中公开，再提时简短回指即可` : "尚未公开";
    return `${formatEvidenceCard(e, false)}\n    （${nameOf(e.owner)}检索；${used}）`;
  });
  const members = TEAM_SIZE[formatOf(record)] === 2 ? "两" : "四";
  return `【本方证据库】（${SIDE_LABEL[side]}${members}位辩手共享，尚未公开的部分对方看不到；每条都已打开网页核对过原文。只能用这些证据作为事实依据）\n${cards.join("\n")}`;
}

/** 对方已公开的证据：可以回指、反驳或质疑，但不能当作本方的证据。 */
export function formatOpponentDisclosed(record: DebateRecord, side: Side): string {
  const cards = disclosedEvidence(record)
    .filter((e) => e.side !== side)
    .map((e) => `${formatEvidenceCard(e, false)}\n    （${nameOf(e.owner)}检索）`);
  if (cards.length === 0) return "【对方已公开的证据】\n（暂无）";
  return `【对方已公开的证据】（来自公开发言；可以回指、反驳或质疑，不能当作本方的证据）\n${cards.join("\n")}`;
}

const lengthNote = (t: Turn) => (t.durationSec ? `（约 ${formatDuration(t.durationSec)}）` : "");

function formatTurn(record: DebateRecord, t: Turn): string {
  if (t.kind === "check") return `【第 ${t.index + 1} 段 · 证据核查】\n${t.text}`;
  const target =
    t.kind === "question" ? ` → ${nameOf(t.target ?? "")}` : t.kind === "answer" ? `（答${nameOf(t.target ?? "")}）` : "";
  const args = t.arguments?.length ? `\n本立论的论点编号：${t.arguments.map((a) => `${a.id}「${a.title}」`).join("；")}` : "";
  return `【第 ${t.index + 1} 段 · ${nameOf(t.speaker)} · ${turnKindLabel(formatOf(record), t.kind)}${target}】${lengthNote(t)}${args}\n${t.text}`;
}

/** 公开的发言记录。 */
export function formatTranscript(record: DebateRecord): string {
  if (record.turns.length === 0) return "【公开发言记录】\n（比赛刚开始，还没有人发言）";
  return `【公开发言记录】\n${record.turns.map((t) => formatTurn(record, t)).join("\n\n")}`;
}

export function formatChallengeResult(c: Challenge): string {
  const verdict = c.verdict ? `核查结论：${c.verdict}。${c.explanation ?? ""}` : "核查中";
  return `${nameOf(c.by)}质疑${nameOf(c.owner)}的证据〔${c.evidenceId}〕，理由：${c.reason}\n${verdict}`;
}

export function formatViolations(record: DebateRecord): string {
  const open = record.violations.filter((v) => !v.corrected);
  if (open.length === 0) return "【系统引用校验】所有辩手均未出现未修正的引用违规。";
  const lines = open.map((v) => `- ${nameOf(v.speaker)}（第 ${v.turn + 1} 段）：${v.detail}`);
  return `【系统引用校验】以下违规在辩手修正后仍然存在，相关引用已被剔除：\n${lines.join("\n")}`;
}

/** 裁判看到的全部材料：只有公开信息。 */
export function formatForJudges(record: DebateRecord): string {
  const { topic, proStance, conStance } = record.input;
  const disclosed = disclosedEvidence(record);
  const evidence = disclosed.length
    ? `【辩论中公开引用的证据】（均为辩手检索、打开网页核对过原文）\n${disclosed
        .map((e) => `${formatEvidenceCard(e)}\n    （${nameOf(e.owner)}检索）`)
        .join("\n")}`
    : "【辩论中公开引用的证据】\n（无）";
  const checks = record.challenges.length
    ? `【证据质疑与核查】\n${record.challenges.map(formatChallengeResult).join("\n\n")}`
    : "【证据质疑与核查】\n（本场无人质疑证据）";
  return `赛制：${FORMAT_LABEL[formatOf(record)]}
论题：${topic}
正方立场：${proStance}
反方立场：${conStance}
辩手：${record.debaters.map((d) => `${d.id}=${d.name}`).join("，")}

${formatTranscript(record)}

${evidence}

${checks}

${formatViolations(record)}`;
}
