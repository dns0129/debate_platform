import { config } from "../config.js";
import type { DebateFormat, Evidence, SpeechTiming, TurnKind } from "../types.js";

// 发言的引用写法、论证密度与时长：
// - 首次公开一条证据，要像正式辩论那样先说出处、再讲具体内容；已经公开过的证据只需简短回指，不要重复展开；
// - 编号只作为句末的〔P1-3〕标注，不当作名词写进正文；
// - 引用只是论证的材料，一段发言里「引用句」的比例有上限，其余篇幅要用来推理；
// - 同一条证据、同一个数据点在一段发言里只讲一次。

// 证据编号 P1-3 = 正方一辩的第 3 条证据；论点编号 PA2 / CA1
const ID = "[PC](?:A\\d{1,2}|[1-4]-\\d{1,2})";
const BRACKETED = new RegExp(`[〔［\\[【（(]\\s*(${ID})\\s*[〕］\\]】）)]`, "g");
const MARKER = new RegExp(`〔(${ID})〕`, "g");
const BARE = new RegExp(`(?<![\\w-])(${ID})(?![\\w-])`, "g");

export const isArgumentId = (id: string) => /^[PC]A/.test(id);

/** 各种括号包着的单个编号统一成〔P1-3〕标注；一个括号里写多个编号的不算标注，会被当作正文里的编号。 */
export function normalizeMarkers(text: string): string {
  return text.trim().replace(BRACKETED, "〔$1〕");
}

/** 正文中出现的全部编号（标注和裸写的都算），按证据 / 论点分开。 */
export function extractRefs(text: string) {
  const evidence = new Set<string>();
  const args = new Set<string>();
  for (const [, ref] of text.matchAll(BARE)) (isArgumentId(ref) ? args : evidence).add(ref);
  return { evidence: [...evidence], arguments: [...args] };
}

// ---------- 时长 ----------

/** 朗读字数：去掉〔编号〕标注、空白和标点符号。 */
export function spokenChars(text: string): number {
  return text.replace(MARKER, "").replace(/[\s\p{P}\p{S}]/gu, "").length;
}

export function timing(chars: number): Required<SpeechTiming> {
  return { spokenChars: chars, durationSec: Math.round((chars / config.speechCharsPerMinute) * 60) };
}

export function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m ? `${m} 分 ${String(s).padStart(2, "0")} 秒` : `${s} 秒`;
}

// 公共论坛制（NSDA Public Forum）各段发言的规定时长（分钟）。和真实比赛一样有 10 秒宽限：超过宽限就算超时；
// 短于规定时长的 75% 说明没把时间用足，要求展开
export const PF_MINUTES: Partial<Record<TurnKind, number>> = { opening: 4, rebuttal: 4, pf_summary: 3, final_focus: 2 };
export const PF_GRACE_SEC = 10;
const PF_MIN_SHARE = 0.75;

const charsFor = (minutes: number) => Math.round(config.speechCharsPerMinute * minutes);

/** PF 一段发言的字数范围：规定时长 × 正常语速，上限含 10 秒宽限。 */
export function pfRange(kind: TurnKind) {
  const minutes = PF_MINUTES[kind];
  if (!minutes) return null;
  const target = charsFor(minutes);
  return { minutes, target, min: Math.round(target * PF_MIN_SHARE), max: charsFor(minutes + PF_GRACE_SEC / 60) };
}

/** 立论目标字数：目标时长 × 正常语速；落在可接受时长范围内都不要求修改。 */
export function openingTarget(format: DebateFormat = "four") {
  if (format === "pf") {
    const { target, min, max } = pfRange("opening")!;
    return { target, min, max };
  }
  const target = charsFor(config.openingMinutes);
  // 范围配置得不含目标时长时，以目标为界
  return { target, min: Math.min(charsFor(config.openingMinMinutes), target), max: Math.max(charsFor(config.openingMaxMinutes), target) };
}

/** 立论时长要求的文字说明，如「约 8 分钟（6-9 分钟均可）」。 */
export function openingDurationLine(format: DebateFormat = "four"): string {
  if (format === "pf") return `4 分钟（另有 ${PF_GRACE_SEC} 秒宽限，不少于 3 分钟）`;
  const { min, max } = openingTarget();
  const minutes = (chars: number) => Math.round((chars / config.speechCharsPerMinute) * 10) / 10;
  return `约 ${config.openingMinutes} 分钟（${minutes(min)}-${minutes(max)} 分钟均可）`;
}

// 四辩制立论以外发言的篇幅要求（字），与辩手提示词中的要求一致。明显超出时要求删减；
// 驳论、小结和总结陈词明显不足时要求展开（质询、答问和自由辩论短一些无妨）
const SPEECH_LENGTH: Partial<Record<TurnKind, { min: number; max: number; enforceMin: boolean }>> = {
  rebuttal: { min: 600, max: 800, enforceMin: true },
  summary: { min: 400, max: 550, enforceMin: true },
  closing: { min: 700, max: 950, enforceMin: true },
  question: { min: 60, max: 150, enforceMin: false },
  answer: { min: 80, max: 250, enforceMin: false },
  free: { min: 80, max: 200, enforceMin: false },
};

// PF 交叉质询的一问一答要短：问题一句话，回答一到三句
const PF_SHORT: Partial<Record<TurnKind, { min: number; max: number }>> = {
  question: { min: 20, max: 100 },
  answer: { min: 20, max: 160 },
};

export function speechLengthRevision(kind: TurnKind, chars: number, format: DebateFormat = "four"): string | null {
  if (format === "pf") {
    const range = pfRange(kind);
    if (range) {
      const over = timing(chars).durationSec - range.minutes * 60;
      if (chars > range.max) {
        return `全文约 ${chars} 字，按正常语速约 ${formatDuration(timing(chars).durationSec)}，超出规定的 ${range.minutes} 分钟 ${over} 秒（宽限只有 ${PF_GRACE_SEC} 秒，超时部分评委不会听）：请删减到 ${range.target} 字左右，先删重复讲述的证据和铺垫，保留推理主干`;
      }
      if (chars < range.min) return `全文约 ${chars} 字，只用了规定 ${range.minutes} 分钟的不到四分之三，请把推理展开到 ${range.target} 字左右（不是堆更多引用）`;
      return null;
    }
    const short = PF_SHORT[kind];
    if (short && chars > short.max * 1.2) return `这一句约 ${chars} 字，交叉质询要短：请压缩到 ${short.max} 字以内，一次只问（答）一个点`;
    return null;
  }
  const range = SPEECH_LENGTH[kind];
  if (!range) return null;
  const { min, max, enforceMin } = range;
  if (chars > max * 1.2) return `全文约 ${chars} 字，超出要求的 ${min}-${max} 字，请删减到 ${max} 字以内：保留推理主干，删掉重复的铺垫和复述`;
  if (enforceMin && chars < min * 0.7) return `全文约 ${chars} 字，少于要求的 ${min}-${max} 字，请把推理展开`;
  return null;
}

/**
 * 立论各部分的字数预算：开场约 20%，结语约 8%，其余平均分给各论点。
 * 模型实际写出的篇幅通常比预算长一成左右，所以预算按目标字数的 92% 分配。
 */
export function openingBudget(argumentCount: number, format: DebateFormat = "four") {
  const target = openingTarget(format).target * 0.92;
  const round10 = (n: number) => Math.round(n / 10) * 10;
  const intro = round10(target * 0.2);
  const conclusion = round10(target * 0.08);
  return { intro, conclusion, perArgument: round10((target - intro - conclusion) / Math.max(1, argumentCount)) };
}

export function openingBudgetLine(argumentCount: number, format: DebateFormat = "four"): string {
  const b = openingBudget(argumentCount, format);
  return `【字数预算】开场约 ${b.intro} 字；每个论点约 ${b.perArgument} 字（共 ${argumentCount} 个）；结语约 ${b.conclusion} 字。写每一部分时都按预算控制篇幅。`;
}

export interface SectionLength {
  label: string;
  chars: number;
  budget: number;
}

export function openingLengthRevision(chars: number, sections: SectionLength[] = [], format: DebateFormat = "four"): string | null {
  const { target, min, max } = openingTarget(format);
  if (chars >= min && chars <= max) return null;
  const long = chars > max;
  // 模型删减时往往只改几个字，所以按略低于目标的字数要求删减，并要求整句删除
  const fix = long
    ? `偏长，请删减约 ${chars - Math.round(target * 0.95)} 字：整句删掉重复的铺垫、复述和过渡句，不要只改几个字`
    : `偏短，请扩充约 ${target - chars} 字（把推理展开，而不是堆更多引用）`;
  // 指出偏离预算最多的部分，修改时先改这些
  const off = sections
    .filter((s) => (long ? s.chars > s.budget * 1.15 : s.chars < s.budget * 0.85))
    .sort((a, b) => Math.abs(b.chars - b.budget) - Math.abs(a.chars - a.budget))
    .map((s) => `${s.label} ${s.chars} 字（预算约 ${s.budget} 字）`);
  const where = off.length ? `。${long ? "超出" : "不足"}预算的部分：${off.join("、")}，请${long ? "压缩" : "扩充"}这些部分` : "";
  return `立论全文约 ${chars} 字，按每分钟 ${config.speechCharsPerMinute} 字的正常语速约 ${formatDuration(timing(chars).durationSec)}；要求${openingDurationLine(format)}，即 ${min}-${max} 字，最好在 ${target} 字左右。当前${fix}${where}`;
}

// ---------- 出处 ----------

/** 去掉网页标题末尾的站点后缀，如「…报告 - 知乎」「…_腾讯新闻」。 */
export function cleanTitle(title: string, site = ""): string {
  const parts = title
    .split(/\s*[|｜_]\s*|\s+[-–—]\s+|-(?=[^-\s\d][^-\s]{1,11}$)/)
    .map((p) => p.trim())
    .filter(Boolean);
  while (parts.length > 1) {
    const last = parts[parts.length - 1];
    if (last.length <= 12 || (site && (last.includes(site) || site.includes(last)))) parts.pop();
    else break;
  }
  return parts.join(" ") || title.trim();
}

/** 辩手引用时推荐说出的出处名称。 */
export function sourceName(e: Evidence): string {
  const s = e.sources[0];
  return e.attribution || s?.site || (s ? cleanTitle(s.title, s.site) : e.id);
}

const squash = (text: string) => text.replace(/[\s《》〈〉「」『』“”"'‘’]/g, "").toLowerCase();
const hasCjk = (text: string) => /\p{Script=Han}/u.test(text);
// 机构名里常见、单独出现不足以指认来源的片段
const GENERIC_GRAMS = new Set(["研究所", "研究院", "委员会", "统计局", "有限公", "限公司", "事务所", "出版社", "新闻网", "研究中", "究中心", "大学的"]);
const GENERIC_WORDS = new Set(["the", "and", "for", "global", "world", "international", "institute", "report", "news", "university", "research", "center", "centre", "org"]);

/** 机构/媒体名允许简称（如「麦肯锡」指代「麦肯锡全球研究所」）；中文按连续三字匹配，英文按词匹配。 */
function mentionsEntity(window: string, name: string): boolean {
  const n = squash(name);
  if (n.length < 2) return false;
  if (window.includes(n) || n.length <= 3) return window.includes(n);
  if (hasCjk(n)) {
    for (let i = 0; i + 3 <= n.length; i++) {
      const gram = n.slice(i, i + 3);
      if (!GENERIC_GRAMS.has(gram) && window.includes(gram)) return true;
    }
    return false;
  }
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((word) => word.length >= 3 && !GENERIC_WORDS.has(word) && window.includes(word));
}

/** 叙述里有没有说出证据的出处：机构/媒体/站点名可用简称，网页标题要完整说出。 */
function mentionsSource(text: string, e: Evidence): boolean {
  const window = squash(text);
  const entities = [e.attribution, ...e.sources.map((s) => s.site)].filter((n): n is string => Boolean(n));
  if (entities.some((name) => mentionsEntity(window, name))) return true;
  return e.sources.some((s) => {
    const title = squash(cleanTitle(s.title, s.site));
    return title.length >= 2 && window.includes(title);
  });
}

const sharesSource = (a: Evidence, b: Evidence) =>
  (a.attribution && a.attribution === b.attribution) || a.sources.some((s) => b.sources.some((t) => t.url === s.url));

// ---------- 数据点 ----------

/**
 * 证据里的「数据点」：带单位的数字、百分比、小数或三位以上的数，不含年份。
 * 两条证据有相同的数据点，通常是同一个统计被不同网页转载，不应作为两条独立证据重复讲。
 */
export function dataPoints(text: string): Set<string> {
  const out = new Set<string>();
  const re = /(\d+(?:\.\d+)?)\s*(%|％|个百分点|万亿|亿|万|倍|美元|元|人次|人|名|起|家|个)?/g;
  for (const m of text.matchAll(re)) {
    const [, n, unit] = m;
    const isYear = /^(19|20)\d{2}$/.test(n) && (!unit || unit === "年");
    if (isYear) continue;
    if (unit || n.includes(".") || n.length >= 3) out.add(`${n}${unit === "％" ? "%" : unit ?? ""}`);
  }
  return out;
}

export function sharedDataPoint(a: Evidence, b: Evidence): string | null {
  const pa = dataPoints(a.claim);
  for (const p of dataPoints(b.claim)) if (pa.has(p)) return p;
  return null;
}

// ---------- 发言检查 ----------

// 叙述一条新证据至少要有这么多字（含出处），只写「据某某〔P1-3〕」不算讲出内容
const MIN_NARRATION_CHARS = 15;
const WINDOW_CHARS = 250;

export interface CitationContext {
  /** 这位辩手此刻可以引用的证据：自己的证据库 + 已经公开的证据 */
  evidence: Map<string, Evidence>;
  /** 在本段发言之前已经公开过的证据编号 */
  disclosed: Set<string>;
}

/**
 * 检查一段发言的引用写法，返回需要修改的地方（给辩手的修改意见，不计入引用违规）：
 * 1. 编号只能出现在〔 〕标注里，不能当作名词写进正文；
 * 2. 首次公开的证据：标注前的叙述要说出出处并讲出内容（紧接着引用同一来源的可以说「该报告还显示」）；
 * 3. 同一条证据在一段发言里只标注一次；不同证据讲的是同一个数据点也只讲一次。
 */
export function citationRevisions(text: string, ctx: CitationContext): string[] {
  const out = new Set<string>();

  for (const [, id] of text.replace(MARKER, "").matchAll(BARE)) {
    out.add(
      isArgumentId(id)
        ? `正文里把论点编号「${id}」当作名词使用了：请用文字复述这个论点（如"对方一辩的第一个论点认为……"），编号只放在句末的〔${id}〕里`
        : `正文里把证据编号「${id}」当作名词使用了：请用文字说出这条证据是什么，编号只放在句末的〔${id}〕里`,
    );
  }

  const seen = new Map<string, Evidence>();
  let prevEnd = 0;
  let prev: { evidence: Evidence; lineStart: number } | null = null;
  for (const m of text.matchAll(MARKER)) {
    const id = m[1];
    const index = m.index ?? 0;
    const lineStart = text.lastIndexOf("\n", index) + 1;
    const narration = text.slice(Math.max(prevEnd, lineStart, index - WINDOW_CHARS), index);
    prevEnd = index + m[0].length;

    const e = isArgumentId(id) ? undefined : ctx.evidence.get(id);
    if (!e) continue; // 论点标注不查出处；不存在的证据编号由引用校验处理

    if (seen.has(id)) {
      out.add(`〔${id}〕在这段发言里标注了不止一次：同一条证据只讲一次，后文如需再提，用文字简短回指、不再标注`);
    } else {
      for (const other of seen.values()) {
        const point = sharedDataPoint(other, e);
        if (point) out.add(`〔${other.id}〕和〔${id}〕讲的是同一个数据（${point}），同一个数据只讲一次，请删去其中一处，把篇幅留给推理`);
      }
    }
    seen.set(id, e);

    // 已公开过的证据只需回指，不查出处
    if (!ctx.disclosed.has(id)) {
      const continuing = prev && prev.lineStart === lineStart && sharesSource(prev.evidence, e);
      if (!continuing && !mentionsSource(narration, e)) {
        out.add(`引用〔${id}〕时没有说明出处：首次引用请在这句话里讲明证据来自哪里（如「${sourceName(e)}」），再具体讲出内容`);
      } else if (squash(narration).length < MIN_NARRATION_CHARS) {
        out.add(`引用〔${id}〕时没有具体讲出证据内容：请把其中的数据、结论或案例细节说清楚`);
      }
    }
    prev = { evidence: e, lineStart };
  }
  return [...out];
}

/** 引用句（含证据标注的句子）占全文的比例。 */
export function citationRatio(text: string): number {
  const sentences = text.split(/(?<=[。！？；!?;])|\n+/).filter((s) => s.trim());
  const total = sentences.reduce((n, s) => n + spokenChars(s), 0);
  if (!total) return 0;
  const cited = sentences.filter((s) => [...s.matchAll(MARKER)].some((m) => !isArgumentId(m[1])));
  return cited.reduce((n, s) => n + spokenChars(s), 0) / total;
}

export function densityRevision(text: string): string | null {
  // 短发言（质询、答问、自由辩论）不查比例
  if (spokenChars(text) < 300) return null;
  const ratio = citationRatio(text);
  if (ratio <= config.maxCitationRatio) return null;
  return `引用句占全文约 ${Math.round(ratio * 100)}%，超过 ${Math.round(config.maxCitationRatio * 100)}% 的上限：论证过于依赖堆砌引用。请删减次要引用，用推理把论点串起来——说明前提如何推出结论、证据证明的是推理中的哪一步、为什么这一步成立`;
}
