import { execFile } from "node:child_process";
import express from "express";
import { liveAgents } from "./agents/index.js";
import { JUDGE_PERSONAS } from "./agents/judge.js";
import { config } from "./config.js";
import { runDebate } from "./debate/orchestrator.js";
import { DebateStore, LockError } from "./debate/store.js";
import { DEMO_FILES, DemoFileMissingError, demoPath, loadDemoScript } from "./demo/placeholder.js";
import { MODELS, PROVIDERS, defaultTeam, describeModel, findModel, isConfigured, resolveEffort, teamModel } from "./llm/models.js";
import { mockAgents } from "./mock/mockAgents.js";
import { SIDES, SIDE_LABEL, type DebateInput, type DebateRecord, type Side, type TeamModel } from "./types.js";

// Node 21 等旧版本自带的 fetch（undici 5.x）有个已知缺陷：网页读取中途被取消、超时或连接异常时，
// 内部仍会往已关闭的流里写数据，抛出「Controller is already closed」。这个错误发生在 Node 内部，
// 调用处 catch 不到，默认会让整个服务退出。它只影响那一次网页读取（调用方已拿到结果或错误），
// 所以只忽略这一种错误，其他未处理的 Promise 拒绝照常抛出、让服务退出。
process.on("unhandledRejection", (reason) => {
  const err = reason as (Error & { code?: string }) | undefined;
  if (err?.code === "ERR_INVALID_STATE" && err.message?.includes("Controller is already closed") && err.stack?.includes("undici")) {
    console.warn("[网页读取] 已忽略 Node 内置 fetch 的已知问题（Controller is already closed），辩论继续（建议升级 Node.js 到 22 或更新的 LTS 版本）");
    return;
  }
  throw reason;
});

const store = new DebateStore(config.dataDir);
const agents = config.mock ? mockAgents : liveAgents;
const app = express();

/** 在后台运行一场辩论，运行期间持有跨进程锁。续跑时带上 resumeMessage。 */
async function start(record: DebateRecord, resumeMessage?: string) {
  await store.lock(record.id);
  if (resumeMessage) store.resume(record, resumeMessage);
  void runDebate(record, agents, store).finally(() => store.unlock(record.id));
}

app.use(express.json({ limit: "32kb" }));
app.use(express.static(config.publicDir));

app.get("/api/config", (_req, res) => {
  res.json({
    mock: config.mock,
    // 可选模型：演示模式不调用 API，全部可选；否则只有配置了密钥的厂商可选
    models: MODELS.map((m) => ({
      id: m.id,
      label: m.label,
      provider: PROVIDERS[m.provider].label,
      efforts: m.efforts,
      defaultEffort: m.defaultEffort,
      available: config.mock || isConfigured(m),
      keyEnv: PROVIDERS[m.provider].keyEnv,
    })),
    defaultTeam: defaultTeam(),
    judgeModel: findModel(config.judgeModel)?.label ?? config.judgeModel,
    webSearch: Boolean(config.bochaApiKey),
    maxChallengesPerSide: config.maxChallengesPerSide,
    evidencePerSide: config.evidencePerSide,
    maxEvidenceUsedPerSide: config.maxEvidenceUsedPerSide,
    judges: JUDGE_PERSONAS.map(({ id, name, focus }) => ({ id, name, focus })),
  });
});

/** 真实模式下，这些模型的密钥都要配置好，否则跑到一半才会失败。 */
function missingKey(models: string[]): string | null {
  if (config.mock) return null;
  for (const id of models) {
    const spec = findModel(id);
    if (spec && !isConfigured(spec)) return `模型 ${spec.label} 需要在 .env 中配置 ${PROVIDERS[spec.provider].keyEnv}`;
  }
  return null;
}

/** 一方的模型与思考强度：整队统一。只能选页面上列出的模型（或 .env 里的默认模型），思考强度必须是该模型支持的档位。 */
function parseTeam(value: unknown, side: Side): TeamModel {
  const fallback = defaultTeam();
  const v = (value ?? {}) as Record<string, unknown>;
  const model = typeof v.model === "string" && v.model ? v.model : fallback.model;
  const spec = findModel(model);
  if (!spec || (model !== fallback.model && !MODELS.some((m) => m.id === model))) {
    throw new Error(`${SIDE_LABEL[side]}的模型「${model}」不在可选列表中`);
  }
  const effort = typeof v.effort === "string" && v.effort ? v.effort : resolveEffort(spec);
  if (!spec.efforts.some((e) => e.value === effort)) {
    throw new Error(`${spec.label} 的思考强度只能是 ${spec.efforts.map((e) => e.value).join(" / ")}`);
  }
  return { model: spec.id, effort };
}

function parseInput(body: unknown): DebateInput | string {
  const b = (body ?? {}) as Record<string, unknown>;
  const text = (key: string, label: string) => {
    const value = typeof b[key] === "string" ? (b[key] as string).trim() : "";
    if (!value) throw new Error(`请填写${label}`);
    if (value.length > 500) throw new Error(`${label}不能超过 500 字`);
    return value;
  };
  try {
    const judgeCount = Number(b.judgeCount ?? 3);
    if (!Number.isInteger(judgeCount) || judgeCount < 1 || judgeCount > JUDGE_PERSONAS.length) {
      throw new Error(`裁判人数需为 1-${JUDGE_PERSONAS.length} 的整数`);
    }
    const teamsBody = (b.teams ?? {}) as Record<string, unknown>;
    const teams = Object.fromEntries(SIDES.map((side) => [side, parseTeam(teamsBody[side], side)])) as Record<Side, TeamModel>;
    const missing = missingKey([teams.pro.model, teams.con.model, config.judgeModel]);
    if (missing) throw new Error(missing);
    return {
      topic: text("topic", "论题"),
      proStance: text("proStance", "正方观点"),
      conStance: text("conStance", "反方观点"),
      judgeCount,
      teams,
    };
  } catch (err) {
    return (err as Error).message;
  }
}

app.post("/api/debates", async (req, res) => {
  const input = parseInput(req.body);
  if (typeof input === "string") {
    res.status(400).json({ error: input });
    return;
  }
  const record = store.create(input, config.mock);
  await start(record);
  res.status(201).json({ id: record.id });
});

// 断点续跑：已完成的发言原样保留，从第一段缺失的发言接着跑
app.post("/api/debates/:id/resume", async (req, res) => {
  const record = await store.get(req.params.id);
  const refuse = (status: number, error: string) => void res.status(status).json({ error });
  if (!record) return refuse(404, "辩论不存在");
  if (record.version !== 2) return refuse(400, "旧版记录不支持续跑");
  if (record.status === "done") return refuse(400, "这场辩论已经结束");
  if (store.isRunning(record.id)) return refuse(409, "这场辩论正在进行中");
  if (record.mock !== config.mock) {
    return refuse(400, record.mock ? "这是演示模式的辩论，请用 npm run demo 启动服务后再续跑" : "当前是演示模式，不能续跑真实辩论");
  }
  const missing = missingKey([...SIDES.map((side) => teamModel(record, side).model), config.judgeModel]);
  if (missing) return refuse(400, `无法续跑：${missing}`);
  const spoken = record.turns.filter((t) => t.kind !== "check").length;
  try {
    await start(record, `从断点继续：保留已完成的 ${spoken} 段发言，从中断处接着进行`);
  } catch (err) {
    if (err instanceof LockError) return refuse(409, err.message);
    throw err;
  }
  res.status(202).json({ id: record.id });
});

app.get("/api/debates", async (_req, res) => {
  res.json(await store.list());
});

app.get("/api/debates/:id", async (req, res) => {
  const record = await store.get(req.params.id);
  if (!record) {
    res.status(404).json({ error: "辩论不存在" });
    return;
  }
  res.json(record);
});

// SSE：连接后立即推送当前快照，之后每次更新推送完整记录，结束后关闭。
app.get("/api/debates/:id/stream", async (req, res) => {
  const record = await store.get(req.params.id);
  if (!record) {
    res.status(404).end();
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  send(record);
  if (record.status !== "running") {
    res.end();
    return;
  }
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
  const unsubscribe = store.subscribe(record.id, (updated) => {
    send(updated);
    if (updated.status !== "running") cleanup();
  });
  function cleanup() {
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  }
  req.on("close", cleanup);
});

// ---------- 动态演示（占位数据） ----------

app.get("/api/demo", async (_req, res) => {
  try {
    res.json(await loadDemoScript());
  } catch (err) {
    const message = err instanceof DemoFileMissingError ? err.message : `读取演示占位文件失败：${(err as Error).message}`;
    res.status(500).json({ error: message });
  }
});

// 本地使用：在访达中打开辩手资料文件夹（路径固定，不接受任何参数）
app.post("/api/demo/open-folder", (_req, res) => {
  if (process.platform !== "darwin") {
    res.status(501).json({ error: "仅支持 macOS" });
    return;
  }
  execFile("open", [demoPath(DEMO_FILES.materials)], (err) => {
    if (err) res.status(500).json({ error: err.message });
    else res.status(204).end();
  });
});

app.listen(config.port, () => {
  console.log(`AI 辩论模拟平台已启动：http://localhost:${config.port}`);
  if (config.mock) {
    console.log("当前为演示模式（DEBATE_MOCK=1）：不会调用模型 API，也不会联网搜索。");
    return;
  }
  const { model, effort } = defaultTeam();
  const configured = Object.values(PROVIDERS).filter((p) => p.apiKey).map((p) => p.label);
  console.log(
    `默认辩手模型：${describeModel(model, effort)}（发起辩论时可按队伍更换）　裁判：${describeModel(config.judgeModel, resolveEffort(findModel(config.judgeModel) ?? MODELS[0], config.judgeEffort))}　联网搜索：${config.bochaApiKey ? "博查" : "未配置"}`,
  );
  console.log(`已配置密钥：${configured.length ? configured.join("、") : "无"}`);
  for (const [key, id] of [
    ["DEBATE_MODEL", config.debateModel],
    ["JUDGE_MODEL", config.judgeModel],
  ]) {
    if (!findModel(id)) console.warn(`${key}=${id} 不是支持的模型（需以 deepseek、glm 或 qwen 开头），请在 .env 中修改。`);
  }
  const judge = findModel(config.judgeModel);
  if (judge && !isConfigured(judge)) {
    console.warn(`裁判模型 ${judge.label} 需要 ${PROVIDERS[judge.provider].keyEnv}，未配置时无法发起辩论。请在 .env 中配置，或使用 npm run demo 进入演示模式。`);
  }
  if (!config.bochaApiKey) {
    console.warn("未检测到 BOCHA_API_KEY：资料检索环节将跳过，辩手只能进行推理论证。");
  }
});
