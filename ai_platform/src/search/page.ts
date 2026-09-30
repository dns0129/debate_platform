import { config } from "../config.js";

// 网页核验：实际打开网页、提取正文，用来确认「网页能打开」和「摘录确实出现在正文里」。
// 平台运行在用户本机，所以这里能打开的网页，用户在同一网络下也能打开。

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const MAX_BYTES = 3_000_000;
const CONCURRENCY = 6;

export interface PageText {
  ok: boolean;
  status?: number;
  /** 去掉标签后的正文 */
  text: string;
  error?: string;
}

export function isBlocked(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return true;
  }
  return config.blockedDomains.some((d) => host === d || host.endsWith(`.${d}`));
}

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", mdash: "—", hellip: "…", middot: "·" };

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|template)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
      if (code[0] === "#") {
        const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[code.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function charsetOf(contentType: string, head: string): string {
  const m = /charset=["']?([\w-]+)/i.exec(contentType) ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
  const cs = (m?.[1] ?? "utf-8").toLowerCase();
  return cs === "gb2312" || cs === "gbk" ? "gb18030" : cs;
}

async function readLimited(res: Response): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => {});
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export async function fetchPageText(url: string): Promise<PageText> {
  if (isBlocked(url)) return { ok: false, text: "", error: "该站点在屏蔽名单中（转载站、文库或学术数据库，不是可直接核对的原始出处）" };
  let res: Response;
  try {
    res = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8", Accept: "text/html,application/xhtml+xml,*/*" },
      signal: AbortSignal.timeout(config.pageFetchTimeoutMs),
    });
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    const reason = e.name === "TimeoutError" ? "打开超时" : `无法连接（${e.cause?.code ?? e.message}）`;
    return { ok: false, text: "", error: reason };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return { ok: false, status: res.status, text: "", error: `网页返回 ${res.status}` };
  }
  const type = res.headers.get("content-type") ?? "";
  if (!/html|text\/plain|xml/i.test(type)) {
    await res.body?.cancel().catch(() => {});
    return { ok: false, status: res.status, text: "", error: `不是网页（${type || "未知类型"}）` };
  }
  try {
    const bytes = await readLimited(res);
    const head = new TextDecoder("latin1").decode(bytes.slice(0, 4000));
    let decoder: TextDecoder;
    try {
      decoder = new TextDecoder(charsetOf(type, head));
    } catch {
      decoder = new TextDecoder("utf-8");
    }
    const text = htmlToText(decoder.decode(bytes));
    if (text.length < 200) return { ok: false, status: res.status, text, error: "网页正文为空（可能需要登录或由脚本渲染）" };
    return { ok: true, status: res.status, text };
  } catch (err) {
    return { ok: false, status: res.status, text: "", error: `读取失败：${(err as Error).message}` };
  }
}

/** 同时打开多个网页，限制并发。 */
export async function fetchPages(urls: string[]): Promise<Map<string, PageText>> {
  const out = new Map<string, PageText>();
  const queue = [...new Set(urls)];
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (let url = queue.shift(); url; url = queue.shift()) out.set(url, await fetchPageText(url));
    }),
  );
  return out;
}

const IGNORED = /[\s\p{P}\p{S}]/u;

/** 比较用：去掉空白与标点，全角字母数字转半角，统一小写。index[i] 是规范化后第 i 个字符在原文中的位置。 */
export function normalizeWithIndex(text: string): { norm: string; index: number[] } {
  let norm = "";
  const index: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let c = text[i];
    const code = c.charCodeAt(0);
    if (code >= 0xff01 && code <= 0xff5e) c = String.fromCharCode(code - 0xfee0);
    if (IGNORED.test(c)) continue;
    norm += c.toLowerCase();
    index.push(i);
  }
  return { norm, index };
}

export const normalize = (text: string) => normalizeWithIndex(text).norm;

/** 摘录是否出现在网页正文中（忽略空白、标点与全半角差异）。normalizedPage 是 normalize 过的正文。 */
export function quoteInPage(normalizedPage: string, quote: string): boolean {
  const q = normalize(quote);
  return q.length >= 8 && normalizedPage.includes(q);
}

/**
 * 从正文中截取与搜索摘要最相关的一段，交给模型整理证据。
 * 摘要里的句子在正文中都找不到，说明摘要与网页对不上（常见于脚本渲染页面），返回 null。
 */
export function excerptAround(pageText: string, summary: string, length = 1500): string | null {
  const { norm, index } = normalizeWithIndex(pageText);
  const probes = summary
    .split(/[。！？!?；;\n]/)
    .map((s) => normalize(s))
    .filter((s) => s.length >= 12)
    .slice(0, 4);
  for (const probe of probes) {
    const at = norm.indexOf(probe.slice(0, 16));
    if (at < 0) continue;
    const start = Math.max(0, index[at] - 300);
    return pageText.slice(start, start + length);
  }
  return null;
}
