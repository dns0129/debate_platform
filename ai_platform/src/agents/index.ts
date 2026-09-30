import type { Challenge, DebateRecord, Evidence, JudgePersona, JudgeResult, ProgressLog, Verdict } from "../types.js";
import { ModelDebater, type Debater } from "./debater.js";
import { factCheck, type CheckResult } from "./factcheck.js";
import { judge, summarize } from "./judge.js";
import type { JudgeDraft } from "./schemas.js";

/**
 * 编排器依赖的全部 Agent：
 * - 8 位辩手，各自一个独立的 Debater 实例；
 * - 中立的证据核查员；
 * - 裁判组与主裁判。
 * 真实实现调用各方选定的模型（DeepSeek、智谱或千问；检索走博查搜索），演示模式换成本地占位实现。
 */
export interface AgentFactory {
  debater(record: DebateRecord, id: string): Debater;
  factCheck(record: DebateRecord, challenge: Challenge, evidence: Evidence, log?: ProgressLog): Promise<CheckResult>;
  judge(record: DebateRecord, persona: JudgePersona): Promise<JudgeDraft>;
  summarize(record: DebateRecord, results: JudgeResult[], tally: Omit<Verdict, "summary">): Promise<string>;
}

export const liveAgents: AgentFactory = {
  debater: (record, id) => new ModelDebater(record, id),
  factCheck,
  judge,
  summarize,
};
