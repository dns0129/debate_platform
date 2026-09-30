import { config } from "../config.js";

// 博查 Web Search API。响应格式兼容 Bing：{ code, log_id, msg, data: { webPages: { value: [...] } } }
const ENDPOINT = "https://api.bocha.cn/v1/web-search";
// 免费档（累计充值 0 元）限 1 QPS / 30 QPM：所有搜索排队串行，并与上一次请求保持间隔
const MIN_INTERVAL_MS = 1100;
const RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_BACKOFF_MS = 3000;

export class SearchError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }

  /** Key 缺失、无效、无权限或余额不足：继续搜索也不会成功。 */
  get fatal() {
    return this.status === 400 || this.status === 401 || this.status === 403;
  }
}

/** 一次搜索的返回：logId 是博查为这次请求分配的编号，可用于在博查控制台或向博查客服核对调用。 */
export interface SearchResponse {
  results: SearchResult[];
  logId?: string;
}

export interface SearchResult {
  url: string;
  title: string;
  site: string;
  published?: string;
  /** 网页摘要（summary），没有摘要时用片段（snippet） */
  text: string;
}

interface BochaWebPage {
  name?: string;
  url?: string;
  snippet?: string;
  summary?: string;
  siteName?: string;
  datePublished?: string;
}

interface BochaResponse {
  code?: number | string;
  log_id?: string;
  msg?: string | null;
  message?: string;
  data?: { webPages?: { value?: BochaWebPage[] } };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let queue: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

function throttled<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return task();
  });
  queue = run.catch(() => {});
  return run;
}

export async function bochaSearch(query: string, count: number): Promise<SearchResponse> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await throttled(() => request(query, count));
    } catch (err) {
      if (err instanceof SearchError && err.status === 429 && attempt < RATE_LIMIT_RETRIES) {
        await sleep(RATE_LIMIT_BACKOFF_MS);
        continue;
      }
      throw err;
    }
  }
}

async function request(query: string, count: number): Promise<SearchResponse> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.bochaApiKey}`, "Content-Type": "application/json" },
      // exclude：在搜索时就排除转载站、文库、学术数据库等不能作为原始出处的站点（「|」分隔，最多 100 个）
      body: JSON.stringify({
        query,
        freshness: "noLimit",
        summary: true,
        count,
        ...(config.blockedDomains.length ? { exclude: config.blockedDomains.slice(0, 100).join("|") } : {}),
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new SearchError(`无法连接博查搜索服务：${(err as Error).message}`);
  }

  const body = (await res.json().catch(() => null)) as BochaResponse | null;
  const code = res.ok ? Number(body?.code ?? res.status) : res.status;
  const logId = body?.log_id ? String(body.log_id) : undefined;
  if (code !== 200) {
    const message = describeStatus(code, body?.msg ?? body?.message);
    throw new SearchError(logId ? `${message}（log_id: ${logId}）` : message, code);
  }

  const results = (body?.data?.webPages?.value ?? []).flatMap((page) => {
    const text = (page.summary || page.snippet || "").trim();
    if (!page.url || !text) return [];
    return [
      {
        url: page.url,
        title: page.name?.trim() || page.url,
        site: page.siteName?.trim() ?? "",
        published: page.datePublished?.slice(0, 10),
        text,
      },
    ];
  });
  return { results, logId };
}

function describeStatus(status: number, detail?: string | null): string {
  if (status === 401) return "博查 API Key 无效：请检查 .env 中的 BOCHA_API_KEY";
  if (status === 429) return "触发博查搜索限流，请稍后重试";
  return `博查搜索失败（${status}）${detail ? `：${detail}` : ""}`;
}
