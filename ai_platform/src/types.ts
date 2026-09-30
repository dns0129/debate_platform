// 领域模型：一场 8 人辩论从输入到裁决的全部数据。
// 辩论的主体是 8 位辩手：每人检索出自己的证据，同队四人共享证据库；对方的证据只有在发言中引用后才会公开。
// 前端完全由 DebateRecord 渲染，服务端每次更新都推送完整快照。

export type Side = "pro" | "con";
export const SIDES: Side[] = ["pro", "con"];
export const SIDE_LABEL: Record<Side, string> = { pro: "正方", con: "反方" };
export const opponentOf = (side: Side): Side => (side === "pro" ? "con" : "pro");

/** 一方四位辩手使用的模型与思考强度：整队统一，不能按辩手单独设置。 */
export interface TeamModel {
  model: string;
  /** 该模型 API 的原生档位，如 DeepSeek 的 high、千问的 xhigh */
  effort: string;
}

export interface DebateInput {
  topic: string;
  proStance: string;
  conStance: string;
  judgeCount: number;
  /** 旧记录没有，运行时按当前默认配置补上 */
  teams?: Record<Side, TeamModel>;
}

export type ProgressLog = (message: string, level?: "info" | "warn") => void;

// ---------- 辩手 ----------

export const POSITION_LABEL = ["一辩", "二辩", "三辩", "四辩"];

export interface DebaterInfo {
  id: string; // pro-1 .. con-4
  side: Side;
  position: number; // 1-4
  name: string; // 正方一辩
  short: string; // 正一
}

export function debaterInfo(side: Side, position: number): DebaterInfo {
  const numeral = "一二三四"[position - 1];
  return {
    id: `${side}-${position}`,
    side,
    position,
    name: `${SIDE_LABEL[side]}${numeral}辩`,
    short: `${SIDE_LABEL[side][0]}${numeral}`,
  };
}

export const ALL_DEBATERS: DebaterInfo[] = SIDES.flatMap((side) => [1, 2, 3, 4].map((p) => debaterInfo(side, p)));

// ---------- 证据 ----------

/** 一条来源：quote 是从网页原文中逐字摘录、并在实际打开的网页里核对过的片段。 */
export interface EvidenceSource {
  url: string;
  title: string;
  quote: string;
  site?: string;
  published?: string;
  /** 核对时间（ISO）：此时网页能打开，且正文里找得到摘录 */
  checkedAt?: string;
}

/** 证据卡片：辩手基于检索结果写出的一句结论 + 支撑它的原文来源。存在找到它的辩手名下，同队辩手都能使用。 */
export interface Evidence {
  id: string; // P1-3 = 正方一辩的第 3 条证据
  owner: string; // 辩手 id
  side: Side;
  claim: string;
  /** 出处：最初发布这条信息的机构、媒体或报告名，经核对确实出现在来源网页中 */
  attribution?: string;
  sources: EvidenceSource[];
  /** 第一次在发言中被引用、从而公开的发言序号；未引用则只有本方辩手看得到 */
  disclosedAt?: number;
  /** 被对方质疑且核查不成立：此后不能再引用，裁判不予采信 */
  invalid?: boolean;
}

/** 一次博查搜索调用的记录。 */
export interface SearchCall {
  query: string;
  /** 调用时间（ISO），便于和博查控制台的账单明细对照 */
  at?: string;
  /** 博查为这次请求分配的编号 log_id */
  logId?: string;
  ok: boolean;
  results: number;
  newPages: number;
  ms: number;
  error?: string;
  /** 哪个环节发起的：赛前准备、证据核查 */
  purpose?: string;
}

/** 检索时被丢弃的网页及原因（打不开、正文里找不到摘录、被屏蔽的站点等），赛后公开以便核对。 */
export interface RejectedPage {
  url: string;
  title: string;
  reason: string;
}

/** 辩手的状态：证据库（本方共享）、检索记录、每次发言前的构思（仅本人可见）。赛后公开。 */
export interface DebaterState extends DebaterInfo {
  bank: Evidence[];
  searchCalls: SearchCall[];
  rejectedPages: RejectedPage[];
  /** 每次发言前的论证构思（发言序号 → 构思） */
  plans: { turn: number; plan: unknown }[];
  /** 赛前准备已完成（续跑时不再检索） */
  prepared?: boolean;
}

// ---------- 发言 ----------

export type Stage = "research" | "opening" | "rebuttal" | "cross" | "free" | "closing" | "judging" | "finished";
export const STAGE_LABEL: Record<Stage, string> = {
  research: "赛前准备",
  opening: "立论",
  rebuttal: "驳论",
  cross: "质询与小结",
  free: "自由辩论",
  closing: "总结陈词",
  judging: "评委评议",
  finished: "结束",
};

export type TurnKind = "opening" | "rebuttal" | "question" | "answer" | "summary" | "free" | "closing" | "check";
export const TURN_LABEL: Record<TurnKind, string> = {
  opening: "立论",
  rebuttal: "驳论",
  question: "质询",
  answer: "答质询",
  summary: "质询小结",
  free: "自由辩论",
  closing: "总结陈词",
  check: "证据核查",
};

/** 立论的论点：编号 PA1 / CA1 由系统分配，其他辩手用〔PA1〕指代。 */
export interface Argument {
  id: string;
  title: string;
}

/** 按正常语速估算的发言长度：字数不含标点、空白和〔编号〕标注。 */
export interface SpeechTiming {
  spokenChars?: number;
  durationSec?: number;
}

/** 公开的一段发言（或一次证据核查结果）。 */
export interface Turn extends SpeechTiming {
  index: number;
  stage: Stage;
  kind: TurnKind;
  /** 发言辩手 id；证据核查为 "referee" */
  speaker: string;
  /** 质询：被问的辩手；答质询：提问的辩手 */
  target?: string;
  /** 发言全文，引用处带〔P1-3〕〔CA2〕标注 */
  text: string;
  /** 立论的分段：开场、各论点、结语 */
  parts?: { label: string; argumentId?: string; title?: string; text: string }[];
  arguments?: Argument[];
  evidenceIds: string[];
  /** 这段发言里发起的质疑 / 证据核查对应的质疑编号 */
  challengeId?: number;
}

// ---------- 证据质疑 ----------

export type CheckVerdict = "成立" | "部分成立" | "不成立";

export interface Challenge {
  id: number;
  side: Side; // 质疑方
  by: string; // 质疑的辩手
  turn: number; // 在哪段发言中提出
  evidenceId: string;
  owner: string; // 被质疑证据的所有者
  reason: string;
  status: "checking" | "done";
  verdict?: CheckVerdict;
  explanation?: string;
  pageReachable?: boolean;
  quoteOnPage?: boolean;
  corroboration?: { url: string; title: string }[];
}

/** 引用违规：引用了不存在或不可见的证据、回应了没出现过的论点、超出本方证据使用上限。 */
export interface Violation {
  turn: number;
  speaker: string;
  kind: "unknown_evidence" | "unknown_argument" | "invalid_evidence" | "over_limit";
  ref: string;
  detail: string;
  /** true = 辩手收到反馈后自行修正；false = 仍然存在，已被系统剔除并计入裁判评分依据 */
  corrected: boolean;
}

// ---------- 裁判 ----------

export type Criterion = "argument" | "evidence" | "clash" | "delivery";
export const CRITERIA: Criterion[] = ["argument", "evidence", "clash", "delivery"];
export const CRITERION_LABEL: Record<Criterion, string> = {
  argument: "论证质量",
  evidence: "证据运用",
  clash: "交锋反驳",
  delivery: "表达说服",
};

export type SideScores = Record<Criterion, number> & { total: number };

export interface JudgePersona {
  id: string;
  name: string;
  focus: string;
  instructions: string;
}

export interface DebaterScore {
  debater: string;
  score: number;
  comment: string;
}

export interface JudgeResult {
  judgeId: string;
  name: string;
  focus: string;
  scores: Record<Side, SideScores>;
  debaterScores: DebaterScore[];
  winner: Side;
  reason: string;
  keyMoments: string[];
}

export interface Verdict {
  winner: Side | "tie";
  votes: Record<Side, number>;
  averageScores: Record<Side, SideScores>;
  /** 各辩手在所有裁判中的平均分 */
  debaterScores: DebaterScore[];
  best?: string;
  decidedBy: "majority" | "score_tiebreak" | "tie";
  summary: string;
}

// ---------- 辩论记录 ----------

export interface LogEntry {
  time: string;
  level: "info" | "warn" | "error";
  message: string;
}

/** 一类模型调用累计的 token 用量（按模型 API 返回的 usage 统计）。 */
export interface TokenUsage {
  calls: number;
  input: number;
  /** 输入中命中前缀缓存的部分，按缓存价计费 */
  cachedInput: number;
  output: number;
  /** 输出中的思考部分 */
  reasoning: number;
}

/** 决定赛程的规则，开赛时从配置取一次存进记录，续跑时沿用。 */
export interface DebateRules {
  crossQuestionsPerTarget: number;
  freeDebateTurns: number;
}

export interface DebateRecord {
  version: 2;
  id: string;
  createdAt: string;
  mock: boolean;
  status: "running" | "done" | "error";
  stage: Stage;
  input: DebateInput;
  /** 旧记录没有，续跑时按当前配置补上 */
  rules?: DebateRules;
  debaters: DebaterState[];
  turns: Turn[];
  challenges: Challenge[];
  violations: Violation[];
  /** 证据库封存时间（ISO）：赛前准备结束、复核完毕后封存，此后任何辩手都不能再检索新证据 */
  evidenceLockedAt?: string;
  /** 当前正在进行的工作（谁在检索、构思、撰写或核查），供页面显示齿轮动画 */
  activity?: { debater?: string; label: string };
  judges: JudgeResult[];
  verdict?: Verdict;
  error?: string;
  /** 各环节（检索、构思、发言、核查、评议）按模型分开统计的 token 用量 */
  usage?: Record<string, TokenUsage>;
  log: LogEntry[];
}
