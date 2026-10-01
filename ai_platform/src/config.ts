import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// 所有路径以项目根目录为基准，不依赖服务从哪个目录启动
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(PROJECT_ROOT, ".env") });

const int = (value: string | undefined, fallback: number) => {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const num = (value: string | undefined, fallback: number) => {
  const n = Number.parseFloat(value ?? "");
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
// 思考强度按所选模型的档位解析（见 src/llm/models.ts），这里只做清洗
const effort = (value: string | undefined) => value?.trim().toLowerCase() || undefined;
const list = (value: string | undefined) =>
  (value ?? "")
    .split(/[,，\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

// 检索时直接跳过的站点（按根域名匹配，子域名一并屏蔽）。证据要用能直接打开的原始出处
const DEFAULT_BLOCKED_DOMAINS = [
  // 转载、自媒体与社区平台：多是转发他人的内容，应当去找最初发布的机构或媒体
  "toutiao.com",
  "sohu.com",
  "163.com",
  "qq.com",
  "sina.com.cn",
  "sina.cn",
  "ifeng.com",
  "baijiahao.baidu.com",
  "zhihu.com",
  "jianshu.com",
  "csdn.net",
  "douban.com",
  "360doc.com",
  "360doc.cn",
  "bihai123.com",
  "inwwin.com.cn",
  "tanpaifang.com",
  "xueshu.com.cn",
  "x-mol.com",
  // 文库与报告聚合站：全文要登录、付费或下载才能看
  "docin.com",
  "doc88.com",
  "book118.com",
  "renrendoc.com",
  "wenku.baidu.com",
  "baogaobox.com",
  "xuehi.cn",
  "waitang.com",
  "taodocs.com",
  "jinchutou.com",
  "mayiwenku.com",
  "wendangku.net",
  "doc.mbalib.com",
  "docer.com",
  // 学术数据库：要登录才能看原文
  "cnki.net",
  "cnki.com.cn",
  "wanfangdata.com.cn",
  "researchgate.net",
];

export const config = {
  port: int(process.env.PORT, 3000),
  mock: process.env.DEBATE_MOCK === "1",
  // 三家模型 API 的密钥与地址：只需配置要用的那几家
  deepseekApiKey: process.env.DEEPSEEK_API_KEY?.trim() ?? "",
  deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
  zhipuApiKey: (process.env.ZHIPU_API_KEY || process.env.ZHIPUAI_API_KEY)?.trim() ?? "",
  zhipuBaseUrl: process.env.ZHIPU_BASE_URL || "https://open.bigmodel.cn/api/paas/v4",
  dashscopeApiKey: process.env.DASHSCOPE_API_KEY?.trim() ?? "",
  dashscopeBaseUrl: process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1",

  // 辩手的模型与思考强度在发起辩论时按队伍选择（同队四人一致），这里只是页面上的默认选项；
  // 思考强度用于该队的构思与发言。裁判组与证据核查员固定使用 JUDGE_MODEL
  debateModel: process.env.DEBATE_MODEL || "deepseek-flash",
  debateEffort: effort(process.env.DEBATE_REASONING_EFFORT),
  judgeModel: process.env.JUDGE_MODEL || "deepseek-flash",
  judgeEffort: effort(process.env.JUDGE_REASONING_EFFORT),

  // 博查 Web Search API；未配置时跳过联网检索，辩手没有证据
  bochaApiKey: process.env.BOCHA_API_KEY?.trim() ?? "",
  webSearchResultsPerQuery: int(process.env.WEB_SEARCH_RESULTS_PER_QUERY, 8),
  // 每位辩手赛前检索次数
  searchesPerDebater: int(process.env.SEARCHES_PER_DEBATER, 3),

  // 证据规则：只有赛前准备可以检索，立论开始前证据库封存，之后任何辩手都不能再收集新证据。
  // 每方证据库最多收集多少条（默认 20，最多 30），按辩位平均分给本方辩手（四辩制每人 1/4，公共论坛制每人 1/2）；每方全场最多使用（在发言中首次引用）多少条
  evidencePerSide: Math.min(int(process.env.EVIDENCE_PER_SIDE, 20), 30),
  maxEvidenceUsedPerSide: int(process.env.MAX_EVIDENCE_USED_PER_SIDE, 9),
  // 网页核验：打开网页并核对摘录原文
  pageFetchTimeoutMs: int(process.env.PAGE_FETCH_TIMEOUT_MS, 8000),
  blockedDomains: [...DEFAULT_BLOCKED_DOMAINS, ...list(process.env.BLOCKED_DOMAINS)],

  // 赛制
  crossQuestionsPerTarget: int(process.env.CROSS_QUESTIONS_PER_TARGET, 2),
  freeDebateTurns: int(process.env.FREE_DEBATE_TURNS, 8),
  // 公共论坛制：每场交叉质询（一辩、二辩、全场）中每方各提几问，每问一答
  pfCrossfireQuestions: int(process.env.PF_CROSSFIRE_QUESTIONS, 2),
  maxChallengesPerSide: int(process.env.MAX_CHALLENGES_PER_SIDE, 3),

  // 论证质量约束：每个论点最多引用几条证据；一段发言里「引用句」最多占多少
  maxEvidencePerPoint: int(process.env.MAX_EVIDENCE_PER_POINT, 2),
  maxCitationRatio: num(process.env.MAX_CITATION_RATIO, 0.45),

  // 正常语速（字/分钟），用于估算发言时长；立论目标时长与可接受范围（分钟）
  speechCharsPerMinute: int(process.env.SPEECH_CHARS_PER_MINUTE, 240),
  openingMinutes: num(process.env.OPENING_MINUTES, 8),
  openingMinMinutes: num(process.env.OPENING_MIN_MINUTES, 6),
  openingMaxMinutes: num(process.env.OPENING_MAX_MINUTES, 9),

  dataDir: path.join(PROJECT_ROOT, "data/debates"),
  publicDir: path.join(PROJECT_ROOT, "public"),
};
