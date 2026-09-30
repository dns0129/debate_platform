import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { z } from "zod";
import { PROJECT_ROOT } from "../config.js";
import type { TokenUsage } from "../types.js";
import { PROVIDERS, lowerEffort, modelSpec, resolveEffort, type ModelSpec, type Provider } from "./models.js";

// DeepSeek、智谱、千问都兼容 OpenAI 格式，这里用 OpenAI SDK 分别指向各自的 base URL。
// 思考强度等参数是各家的扩展字段（SDK 的类型里没有），作为额外字段附加到请求体上。
const clients = new Map<Provider, OpenAI>();
// 延迟创建：演示模式或某家未配置密钥时，服务仍可启动。
function getClient(provider: Provider): OpenAI {
  const p = PROVIDERS[provider];
  if (!p.apiKey) {
    throw new ModelStopError(`未配置 ${p.keyEnv}：请在 .env 中填写${p.label} API Key，或换用已配置密钥的模型；也可以用 npm run demo 进入演示模式`);
  }
  let client = clients.get(provider);
  // 最高档的长思考可能超过 SDK 默认的 10 分钟超时，放宽到 20 分钟
  if (!client) clients.set(provider, (client = new OpenAI({ apiKey: p.apiKey, baseURL: p.baseUrl, timeout: 20 * 60_000 })));
  return client;
}

// 响应体读到一半连接被断开（Node 内置 fetch 报 TypeError: terminated），SDK 不会重试，这里补上
const NETWORK_RETRIES = 2;
const isDroppedConnection = (err: unknown) =>
  err instanceof TypeError && /terminated|fetch failed|other side closed|ECONNRESET/i.test(`${err.message} ${String(err.cause ?? "")}`);

async function create(
  spec: ModelSpec,
  effort: string,
  params: Omit<OpenAI.Chat.ChatCompletionCreateParamsNonStreaming, "model">,
): Promise<OpenAI.Chat.ChatCompletion> {
  const maxTokens = spec.maxTokens(effort);
  const body = {
    ...params,
    model: spec.id,
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    ...spec.thinkingParams(effort),
  } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;
  for (let attempt = 0; ; attempt++) {
    try {
      return await getClient(spec.provider).chat.completions.create(body);
    } catch (err) {
      if (isDroppedConnection(err) && attempt < NETWORK_RETRIES) {
        console.warn(`[${PROVIDERS[spec.provider].label}] 连接中途断开（${(err as Error).message}），${attempt + 1}/${NETWORK_RETRIES} 次重试`);
        await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
        continue;
      }
      throw err instanceof ModelStopError ? err : new ModelStopError(describeApiError(err, spec));
    }
  }
}

export class ModelStopError extends Error {}

function assertUsable(choice: OpenAI.Chat.ChatCompletion.Choice | undefined): OpenAI.Chat.ChatCompletion.Choice {
  if (!choice) throw new ModelStopError("模型未返回任何内容");
  if (choice.finish_reason === "length") throw new ModelStopError("模型输出超出长度上限被截断");
  if (choice.finish_reason === "content_filter") throw new ModelStopError("模型输出被内容审核拦截");
  return choice;
}

/** 把一次调用的 usage 累加到统计里。DeepSeek 用 prompt_cache_hit_tokens 报告命中前缀缓存的输入，智谱和千问用 prompt_tokens_details。 */
function addUsage(sink: TokenUsage | undefined, usage: OpenAI.CompletionUsage | undefined) {
  if (!sink || !usage) return;
  sink.calls++;
  sink.input += usage.prompt_tokens;
  sink.cachedInput +=
    (usage as { prompt_cache_hit_tokens?: number }).prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
  sink.output += usage.completion_tokens;
  sink.reasoning += usage.completion_tokens_details?.reasoning_tokens ?? 0;
}

// JSON 模式只保证输出合法 JSON，不校验结构（千问在思考模式下连这一点也不保证）：把 JSON Schema 写进提示词，
// 返回后再用 zod 校验，解析不了就修复或重试。
// 格式要求放在用户消息末尾，不放进系统提示：各类调用的 Schema 不同，放在前面会打断前缀，
// 后面的长上下文（发言记录、证据库）就命中不了前缀缓存。
function withJsonFormat(prompt: string, schema: z.ZodType): string {
  return `${prompt}

【输出格式】只输出一个 json 对象，不要输出任何其他文字。字符串里需要引号时用中文引号“”或「」、书名号《》，不要用英文双引号；换行写成 \\n。该对象必须符合以下 JSON Schema（description 是各字段的要求）：
${JSON.stringify(z.toJSONSchema(schema))}`;
}

type Parsed<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * 长篇中文发言放进 JSON 时，模型偶尔会在字符串里直接写英文双引号或真实换行，导致整段无法解析。
 * 这里做一次保守修复：去掉代码块标记；字符串内部的换行、制表符转义；
 * 字符串内部的英文双引号，若其后（跳过空白）不是 , : } ] 之一，视为正文里的引号并转义。
 */
export function repairJson(raw: string): string {
  let text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) text = text.slice(start, end + 1);

  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (ch === "\\") {
      out += ch + (text[i + 1] ?? "");
      i++;
    } else if (ch === '"') {
      const next = text.slice(i + 1).match(/^\s*(.)/)?.[1];
      if (next === undefined || ",:}]".includes(next)) {
        inString = false;
        out += ch;
      } else {
        out += '\\"';
      }
    } else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else out += ch;
  }
  return out;
}

function parseJson<S extends z.ZodType>(content: string | null, schema: S): Parsed<z.infer<S>> {
  if (!content?.trim()) return { ok: false, error: "输出为空" };
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    try {
      value = JSON.parse(repairJson(content));
    } catch (err) {
      return { ok: false, error: `不是合法的 JSON（${(err as Error).message}）` };
    }
  }
  const result = schema.safeParse(value);
  return result.success ? { ok: true, data: result.data } : { ok: false, error: z.prettifyError(result.error) };
}

// 解析失败的原始输出存到 data/debug，便于排查
async function saveFailedOutput(content: string | null | undefined, error: string) {
  try {
    const dir = path.join(PROJECT_ROOT, "data/debug");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.txt`);
    await writeFile(file, `${error}\n\n${content ?? ""}`);
  } catch {
    // 只是排查用，写不进去不影响辩论
  }
}

const STRUCTURED_ATTEMPTS = 3;

/** 单次结构化调用：输出按 zod schema 解析。辩手、裁判和证据整理都走这里。 */
export async function callStructured<S extends z.ZodType>(opts: {
  model: string;
  system: string;
  prompt: string;
  schema: S;
  /** 思考强度，按该模型支持的档位解析；不填用模型默认档位 */
  effort?: string;
  /** 累加本次调用的 token 用量 */
  usage?: TokenUsage;
}): Promise<z.infer<S>> {
  const spec = modelSpec(opts.model);
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: opts.system },
    { role: "user", content: withJsonFormat(opts.prompt, opts.schema) },
  ];
  // JSON 模式偶尔返回空内容、无法解析或不合结构的对象：把问题告诉模型后重试
  let lastError = "";
  let effort = resolveEffort(spec, opts.effort);
  for (let attempt = 0; attempt < STRUCTURED_ATTEMPTS; attempt++) {
    const completion = await create(spec, effort, {
      response_format: { type: "json_object" },
      messages: lastError
        ? [
            ...messages,
            {
              role: "user",
              content: `上一次输出无法使用：${lastError}。请重新完整输出一个合法的 json 对象；字符串内不要用英文双引号，换行写成 \\n。`,
            },
          ]
        : messages,
    });
    addUsage(opts.usage, completion.usage);
    // 思考太长把 max_tokens 用完：降一档思考强度重试，不让一段发言中止整场辩论
    const lower = lowerEffort(spec, effort);
    if (completion.choices[0]?.finish_reason === "length" && lower) {
      console.warn(`[${spec.label}] 输出超出 max_tokens 被截断，思考强度 ${effort} → ${lower} 重试`);
      effort = lower;
      continue;
    }
    const content = assertUsable(completion.choices[0]).message.content;
    const parsed = parseJson(content, opts.schema);
    if (parsed.ok) return parsed.data;
    lastError = parsed.error;
    await saveFailedOutput(content, lastError);
  }
  throw new ModelStopError(`模型输出无法解析为预期结构：${lastError}`);
}

export interface FunctionTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * 函数调用循环：模型发起工具调用 → 本地执行 → 结果送回，直到模型不再调用工具。
 * 调用方只要工具执行的副作用（检索结果），不要模型最后的回复：工具调用次数用完就直接结束，
 * 不再多请求一次让模型收尾（智谱也不支持 tool_choice: none）。
 * DeepSeek 思考模式要求带 tools 的多轮对话把每一轮的 reasoning_content 原样送回，
 * 所以直接把返回的 message 对象追加进历史（其中包含 reasoning_content；智谱、千问会忽略）。
 */
export async function callWithTools(opts: {
  model: string;
  system: string;
  prompt: string;
  tools: FunctionTool[];
  maxToolCalls: number;
  execute: (name: string, args: unknown) => Promise<string>;
  effort?: string;
  usage?: TokenUsage;
}): Promise<void> {
  const spec = modelSpec(opts.model);
  const effort = resolveEffort(spec, opts.effort);
  const tools: OpenAI.Chat.ChatCompletionTool[] = opts.tools.map((fn) => ({ type: "function", function: fn }));
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.prompt },
  ];

  let calls = 0;
  // 模型每轮至少调用一次工具，所以轮数也以调用上限为界
  for (let round = 0; round < opts.maxToolCalls && calls < opts.maxToolCalls; round++) {
    const completion = await create(spec, effort, { messages, tools });
    addUsage(opts.usage, completion.usage);
    const { message } = assertUsable(completion.choices[0]);
    messages.push(message);
    if (!message.tool_calls?.length) return;

    for (const call of message.tool_calls) {
      let content: string;
      if (call.type !== "function") {
        content = "不支持的工具类型";
      } else if (calls >= opts.maxToolCalls) {
        content = "工具调用次数已用完。";
      } else {
        calls++;
        content = await runTool(call.function, opts.execute);
      }
      messages.push({ role: "tool", tool_call_id: call.id, content });
    }
  }
}

async function runTool(
  fn: { name: string; arguments: string },
  execute: (name: string, args: unknown) => Promise<string>,
): Promise<string> {
  let args: unknown;
  try {
    args = JSON.parse(fn.arguments || "{}");
  } catch {
    return "参数不是合法的 JSON，请重新调用";
  }
  return execute(fn.name, args);
}

/** 把模型 API 的异常翻译成中文说明，带上是哪家、哪个模型。 */
function describeApiError(err: unknown, spec: ModelSpec): string {
  const { label, keyEnv } = PROVIDERS[spec.provider];
  if (err instanceof OpenAI.AuthenticationError) return `${label} API 认证失败：请检查 .env 中的 ${keyEnv}`;
  if (err instanceof OpenAI.PermissionDeniedError) return `当前 ${keyEnv} 无权使用模型 ${spec.id}：${err.message}`;
  if (err instanceof OpenAI.NotFoundError) return `${label}没有模型 ${spec.id}，或接口地址有误：${err.message}`;
  // 智谱余额不足也返回 429，把原始说明带上
  if (err instanceof OpenAI.RateLimitError) return `${label} API 限流或额度不足（${spec.id}）：${err.message}`;
  if (err instanceof OpenAI.BadRequestError) return `${label} 请求参数错误（${spec.id}）：${err.message}`;
  if (err instanceof OpenAI.APIConnectionError) return `无法连接${label} API，请检查网络或代理设置`;
  if (err instanceof OpenAI.APIError) {
    if (err.status === 402) return `${label}账户余额不足，请充值后重试`;
    return `${label} API 错误（${err.status}，${spec.id}）：${err.message}`;
  }
  if (err instanceof Error) return `${label} 调用失败（${spec.id}）：${err.message}`;
  return String(err);
}

/** 展示给用户的错误说明。模型调用的异常在 create 里已经翻译好。 */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
