import { z } from "zod";

// 模型的结构化输出格式。编号（证据 P1-3、论点 PA1）由系统分配，模型只负责引用。

export const ResearchDraft = z.object({
  findings: z.array(
    z.object({
      claim: z.string().describe("一句中文事实陈述，必须能被摘录的原文直接支撑，不夸大、不外推"),
      attribution: z
        .string()
        .describe("出处：最初发布这条信息的机构、媒体或报告名称，必须原样出现在该网页的标题、站点名或正文节选中"),
      source_id: z.string().describe("来源编号，如 S3，必须来自下面列出的网页"),
      quote: z.string().describe("从该网页「正文节选」中逐字摘录的一段连续原文，20-150 字，不得改写、翻译、拼接或使用省略号"),
    }),
  ),
});
export type ResearchDraft = z.infer<typeof ResearchDraft>;

const ChallengeDraft = z
  .object({
    evidence_id: z.string().describe("要质疑的对方证据编号，必须是对方已经在发言中公开引用过的证据"),
    reason: z.string().describe("质疑理由：为什么怀疑这条证据不存在、来源不可靠或被歪曲"),
  })
  .nullable()
  .describe("对对方证据的质疑；没有把握时填 null，不要滥用");

/** 发言前的私有构思：先想清楚逻辑链，再决定每条证据证明哪一步。 */
export const PlanDraft = z.object({
  definitions: z.string().describe("关键概念界定（仅立论需要，其他环节填空字符串）"),
  criterion: z.string().describe("判断标准（仅立论需要，其他环节填空字符串）"),
  points: z.array(
    z.object({
      claim: z.string().describe("这一点要成立的主张，一句话"),
      responds_to: z.string().describe("回应的是对方哪个论点或说法（写明编号或原话）；立论填空字符串"),
      logic_chain: z
        .array(z.string())
        .describe("推理链：3-5 步，每步一句，前一步能推出后一步，最后一步就是主张。写推理，不要写引用"),
      evidence: z
        .array(
          z.object({
            evidence_id: z.string().describe("你自己证据库中的证据编号"),
            proves: z.string().describe("这条证据证明的是推理链中的哪一步、证明了什么"),
          }),
        )
        .describe("支撑推理链的证据，最多 2 条；推理本身足够清楚的步骤不需要证据"),
    }),
  ),
  weighing: z.string().describe("权衡：为什么这些点足以让我方在判断标准下胜出，对方最强的反击是什么、如何化解"),
  challenge: ChallengeDraft,
});
export type PlanDraft = z.infer<typeof PlanDraft>;

// 编号标注写法：证据〔P1-3〕、论点〔CA2〕，只放在句末，由代码核对；证据和论点列表都从正文标注中提取。
const CITE_RULE =
  "首次引用证据时先说出处、再讲具体内容，句末用〔P1-3〕这样的格式标注；已经公开过的证据只需简短回指；编号不要当作名词写进正文";

export const OpeningDraft = z.object({
  intro: z.string().describe("开场：问候，界定辩题中的关键概念，提出判断标准"),
  arguments: z.array(
    z.object({
      title: z.string().describe("论点标题，一句话"),
      reasoning: z.string().describe(`该论点的完整论证：按构思中的推理链一步步展开，证据只用来支撑其中的关键一步。${CITE_RULE}`),
    }),
  ),
  conclusion: z.string().describe("结语：总结全部论点，重申立场"),
});
export type OpeningDraft = z.infer<typeof OpeningDraft>;

export const SpeechDraft = z.object({
  text: z.string().describe(`完整发言稿，分段写。${CITE_RULE}；提及论点时用文字复述并在句末标注〔PA1〕`),
});
export type SpeechDraft = z.infer<typeof SpeechDraft>;

export const QuestionDraft = z.object({
  question: z.string().describe("一个具体、封闭、让对方难以回避的问题，60-150 字"),
});
export type QuestionDraft = z.infer<typeof QuestionDraft>;

export const AnswerDraft = z.object({
  answer: z.string().describe("正面回答，80-250 字，不回避问题；需要时可以引用自己的证据"),
});
export type AnswerDraft = z.infer<typeof AnswerDraft>;

export const FreeDraft = z.object({
  text: z.string().describe("自由辩论发言，80-200 字，紧扣上一位对方辩手的话"),
  challenge: ChallengeDraft,
});
export type FreeDraft = z.infer<typeof FreeDraft>;

export const FactCheckDraft = z.object({
  verdict: z.enum(["成立", "部分成立", "不成立"]).describe("核查结论"),
  explanation: z.string().describe("100 字以内的核查说明：网页能否打开、原文是否存在、证据和发言是否忠实于原文、有无其他来源佐证"),
});
export type FactCheckDraft = z.infer<typeof FactCheckDraft>;

const SideScoresDraft = z.object({
  argument: z.number().int().describe("论证质量，1-10"),
  evidence: z.number().int().describe("证据运用，1-10"),
  clash: z.number().int().describe("交锋反驳，1-10"),
  delivery: z.number().int().describe("表达说服，1-10"),
});

export const JudgeDraft = z.object({
  pro: SideScoresDraft,
  con: SideScoresDraft,
  debaters: z
    .array(
      z.object({
        id: z.string().describe("辩手编号，如 pro-1、con-3"),
        score: z.number().int().describe("该辩手的个人得分，60-100"),
        comment: z.string().describe("一句话点评"),
      }),
    )
    .describe("八位辩手的个人得分，每人一条"),
  winner: z.enum(["pro", "con"]).describe("胜方：pro=正方，con=反方"),
  reason: z.string().describe("200 字以内的判决理由"),
  key_moments: z.array(z.string()).describe("决定胜负的 2-4 个关键交锋，每条一句话"),
});
export type JudgeDraft = z.infer<typeof JudgeDraft>;

export const VerdictSummaryDraft = z.object({
  summary: z.string().describe("150-250 字的裁判组综合评议"),
});
