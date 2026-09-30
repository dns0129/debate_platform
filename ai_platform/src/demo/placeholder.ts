import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { PROJECT_ROOT } from "../config.js";
import type { Side } from "../types.js";

// 动态演示的占位数据：直接解析项目根目录下的辩论实录、评委点评和辩手资料文件夹。
// 修改这些 Markdown 文件后刷新演示页即可生效。

export const DEMO_FILES = {
  transcript: "辩论实录_难民管控.md",
  judging: "评委点评.md",
  materials: "辩手资料_难民管控",
};

export const demoPath = (name: string) => path.join(PROJECT_ROOT, name);

/** 占位文件缺失：错误信息直接告诉用户缺哪个文件、该放在哪里。 */
export class DemoFileMissingError extends Error {}

async function readRequired(name: string): Promise<string> {
  try {
    return await readFile(demoPath(name), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    throw new DemoFileMissingError(`找不到占位文件「${name}」，请把它放回项目文件夹：${PROJECT_ROOT}`);
  }
}

// ---------- 数据结构 ----------

export interface DemoMaterial {
  path: string; // 相对资料文件夹的路径
  fileName: string;
  title: string;
  type: string;
  source: string;
  usedIn: string[];
  body: string;
}

export interface DemoDebater {
  id: string; // pro-1 .. con-4
  side: Side;
  position: number;
  name: string; // 正方一辩
  short: string; // 正一
  materials: DemoMaterial[];
}

export interface DemoTurn {
  speaker: string;
  /** 质询时：提问对象；答问时：提问者 */
  target?: string;
  kind: "speech" | "question" | "answer" | "free";
  /** 实录中的环节名：立论 / 驳论 / 质询 / 质询小结 / 自由辩论 / 总结陈词 */
  phaseLabel: string;
  text: string;
}

export interface DemoPhase {
  key: string;
  label: string;
  turns: DemoTurn[];
}

export interface JudgingNotes {
  title: string;
  verdict: { winner: Side | "tie"; headline: string; body: string };
  clashes: { title: string; result: string; winner: Side | null; body: string }[];
  phaseComments: { phase: string; text: string }[];
  scores: { debater: string; score: number; comment: string }[];
  best: { debater: string; text: string } | null;
  improvements: Record<Side, { title: string; body: string }[]>;
}

export interface DemoScript {
  topic: string;
  stances: Record<Side, string>;
  debaters: DemoDebater[];
  phases: DemoPhase[];
  judging: JudgingNotes;
  /** found=false 表示资料文件夹不存在，演示照常进行，但资料公开环节为空 */
  folder: { name: string; total: number; found: boolean };
}

// ---------- 通用 ----------

const NUMERAL: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4 };

export function parseDebater(text: string) {
  const m = text.match(/(正方|反方)([一二三四])辩/);
  if (!m) return null;
  const side: Side = m[1] === "正方" ? "pro" : "con";
  const position = NUMERAL[m[2]];
  return { id: `${side}-${position}`, side, position, name: m[0], short: `${m[1][0]}${m[2]}` };
}

const sideOf = (text: string): Side | null => (text.includes("反方") ? "con" : text.includes("正方") ? "pro" : null);
const stripBold = (text: string) => text.replace(/\*\*/g, "");

/** 按「## 标题」切分，返回 [标题, 正文行] 列表。 */
function sections(md: string, level: "##" | "###") {
  const result: { heading: string; lines: string[] }[] = [];
  const pattern = new RegExp(`^${level}\\s+(.+)$`);
  for (const line of md.split(/\r?\n/)) {
    const m = line.match(pattern);
    if (m) result.push({ heading: m[1].trim(), lines: [] });
    else result.at(-1)?.lines.push(line);
  }
  return result;
}

/** 把连续的非空行视为段落。 */
function paragraphs(lines: string[]): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  for (const line of [...lines, ""]) {
    if (line.trim()) buf.push(line.trim());
    else if (buf.length) {
      out.push(buf.join(""));
      buf = [];
    }
  }
  return out;
}

// ---------- 辩论实录 ----------

const PHASE_OF: Record<string, { key: string; label: string }> = {
  立论: { key: "opening", label: "立论" },
  驳论: { key: "rebuttal", label: "驳论" },
  质询: { key: "cross", label: "质询与小结" },
  质询小结: { key: "cross", label: "质询与小结" },
  自由辩论: { key: "free", label: "自由辩论" },
  总结陈词: { key: "closing", label: "总结陈词" },
};

/** 质询与自由辩论：逐行解析「**问X：**」「1. 问题」「**X：** 发言」，续行并入上一条。 */
function parseExchanges(lines: string[], phaseLabel: string, asker?: string): DemoTurn[] {
  const turns: DemoTurn[] = [];
  let target: string | undefined;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let m = line.match(/^\*\*问(.+?)[:：]\*\*$/);
    if (m) {
      target = parseDebater(m[1])?.id;
      continue;
    }
    m = line.match(/^\d+[.、]\s*(.+)$/);
    if (asker && m) {
      turns.push({ speaker: asker, target, kind: "question", phaseLabel, text: stripBold(m[1]) });
      continue;
    }
    m = line.match(/^\*\*(.+?)[:：]\*\*\s*(.*)$/);
    const speaker = m && parseDebater(m[1]);
    if (m && speaker) {
      turns.push({
        speaker: speaker.id,
        target: asker,
        kind: asker ? "answer" : "free",
        phaseLabel,
        text: stripBold(m[2]),
      });
      continue;
    }
    const last = turns.at(-1);
    if (last) last.text += `\n\n${stripBold(line)}`;
  }
  return turns;
}

export function parseTranscript(md: string) {
  const topic = md.match(/^#\s+(?:辩论实录[:：])?\s*(.+)$/m)?.[1].trim() ?? "未命名辩题";
  const quote = md
    .split(/\r?\n/)
    .filter((l) => l.startsWith(">"))
    .map((l) => l.replace(/^>\s?/, ""))
    .join("");
  const stanceMatch = quote.match(/正方[:：]\s*([^｜|]+?)\s*[｜|]\s*反方[:：]\s*([^。]+)/);
  const stances: Record<Side, string> = {
    pro: stanceMatch?.[1].trim() ?? "正方",
    con: stanceMatch?.[2].trim() ?? "反方",
  };

  const phases: DemoPhase[] = [];
  const push = (phaseName: string, turns: DemoTurn[]) => {
    const phase = PHASE_OF[phaseName] ?? { key: phaseName, label: phaseName };
    const last = phases.at(-1);
    if (last && last.key === phase.key) last.turns.push(...turns);
    else phases.push({ ...phase, turns });
  };

  for (const { heading, lines } of sections(md, "##")) {
    if (heading.startsWith("自由辩论")) {
      push("自由辩论", parseExchanges(lines, "自由辩论"));
      continue;
    }
    const [who, phaseName = ""] = heading.split(/\s*[·・]\s*/);
    const speaker = parseDebater(who);
    if (!speaker) continue;
    if (phaseName === "质询") {
      push(phaseName, parseExchanges(lines, phaseName, speaker.id));
    } else {
      const text = paragraphs(lines).map(stripBold).join("\n\n");
      push(phaseName, [{ speaker: speaker.id, kind: "speech", phaseLabel: phaseName, text }]);
    }
  }
  return { topic, stances, phases };
}

// ---------- 评委点评 ----------

export function parseJudging(md: string): JudgingNotes {
  const notes: JudgingNotes = {
    title: md.match(/^##\s+(.+)$/m)?.[1].trim() ?? "评委点评",
    verdict: { winner: "tie", headline: "", body: "" },
    clashes: [],
    phaseComments: [],
    scores: [],
    best: null,
    improvements: { pro: [], con: [] },
  };

  for (const { heading, lines } of sections(md, "###")) {
    const paras = paragraphs(lines);

    if (heading.includes("判决")) {
      const m = paras[0]?.match(/^\*\*(.+?)\*\*\s*(.*)$/);
      const headline = (m?.[1] ?? paras[0] ?? "").replace(/[。.]$/, "");
      notes.verdict = {
        winner: sideOf(headline) ?? "tie",
        headline,
        body: [m?.[2] ?? "", ...paras.slice(1)].filter(Boolean).join("\n\n"),
      };
    } else if (heading.includes("胜负关键")) {
      for (const p of paras) {
        const m = p.match(/^\*\*(.+?)(?:（(.+?)）)?[。.]?\*\*\s*(.*)$/);
        if (m) {
          notes.clashes.push({ title: m[1], result: m[2] ?? "", winner: sideOf(m[2] ?? ""), body: m[3] });
        } else if (notes.clashes.length) {
          const last = notes.clashes[notes.clashes.length - 1];
          last.body = [last.body, p].filter(Boolean).join("\n\n");
        }
      }
    } else if (heading.includes("环节")) {
      for (const line of lines) {
        const m = line.match(/^\s*[-*]\s*\*\*(.+?)\*\*[:：]\s*(.+)$/);
        if (m) notes.phaseComments.push({ phase: m[1], text: m[2].trim() });
      }
    } else if (heading.includes("评分")) {
      for (const line of lines) {
        const cells = line.split("|").map((c) => c.trim());
        const debater = parseDebater(cells[1] ?? "");
        const score = Number(cells[2]);
        if (debater && Number.isFinite(score)) {
          notes.scores.push({ debater: debater.id, score, comment: cells[3] ?? "" });
        }
      }
      const best = paras.find((p) => p.startsWith("**最佳辩手"));
      const m = best?.match(/^\*\*最佳辩手[:：]\s*(.+?)[。.]?\*\*\s*(.*)$/);
      const debater = m && parseDebater(m[1]);
      if (m && debater) notes.best = { debater: debater.id, text: m[2] };
    } else if (heading.includes("改进")) {
      let side: Side | null = null;
      for (const line of lines) {
        const t = line.trim();
        const header = t.match(/^\*\*(正方|反方)[:：]\*\*$/);
        if (header) {
          side = sideOf(header[1]);
          continue;
        }
        const item = t.match(/^\d+[.、]\s*\*\*(.+?)\*\*\s*(.*)$/);
        if (side && item) notes.improvements[side].push({ title: item[1].replace(/[。.]$/, ""), body: item[2] });
      }
    }
  }
  return notes;
}

// ---------- 辩手资料 ----------

function parseMaterial(relPath: string, text: string): DemoMaterial {
  const fileName = path.basename(relPath);
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const meta: Record<string, string> = {};
  for (const line of (m?.[1] ?? "").split(/\r?\n/)) {
    const kv = line.match(/^([^:：]+)[:：]\s*(.*)$/);
    if (kv) meta[kv[1].trim()] = kv[2].trim();
  }
  return {
    path: relPath,
    fileName,
    title: meta["标题"] || fileName.replace(/\.md$/, ""),
    type: meta["类型"] ?? "",
    source: meta["来源"] ?? "",
    usedIn: (meta["使用环节"] ?? "").split(/[,，、]/).map((s) => s.trim()).filter(Boolean),
    body: (m?.[2] ?? text).trim(),
  };
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort((a, b) => a.localeCompare(b, "zh-CN"));
  } catch {
    return [];
  }
}

/** 资料文件夹结构：<正方|反方>/<X方Y辩>/*.md，每位辩手只拥有自己文件夹里的文件。 */
async function loadMaterials(root: string): Promise<Map<string, DemoMaterial[]>> {
  const byDebater = new Map<string, DemoMaterial[]>();
  for (const sideDir of await listDir(root)) {
    for (const debaterDir of await listDir(path.join(root, sideDir))) {
      const debater = parseDebater(debaterDir);
      if (!debater) continue;
      const files = (await listDir(path.join(root, sideDir, debaterDir))).filter((f) => f.endsWith(".md"));
      const materials = await Promise.all(
        files.map(async (f) => {
          const rel = path.join(sideDir, debaterDir, f);
          return parseMaterial(rel, await readFile(path.join(root, rel), "utf8"));
        }),
      );
      byDebater.set(debater.id, materials);
    }
  }
  return byDebater;
}

export async function loadDemoScript(): Promise<DemoScript> {
  const [transcriptMd, judgingMd, materials] = await Promise.all([
    readRequired(DEMO_FILES.transcript),
    readRequired(DEMO_FILES.judging),
    loadMaterials(demoPath(DEMO_FILES.materials)),
  ]);
  const { topic, stances, phases } = parseTranscript(transcriptMd);

  const debaters: DemoDebater[] = (["pro", "con"] as Side[]).flatMap((side) =>
    [1, 2, 3, 4].map((position) => {
      const info = parseDebater(`${side === "pro" ? "正方" : "反方"}${"一二三四"[position - 1]}辩`)!;
      return { ...info, materials: materials.get(info.id) ?? [] };
    }),
  );

  return {
    topic,
    stances,
    debaters,
    phases,
    judging: parseJudging(judgingMd),
    folder: {
      name: DEMO_FILES.materials,
      total: debaters.reduce((n, d) => n + d.materials.length, 0),
      found: await access(demoPath(DEMO_FILES.materials)).then(
        () => true,
        () => false,
      ),
    },
  };
}
