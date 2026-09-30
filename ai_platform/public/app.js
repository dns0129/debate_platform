// 前端：界面完全由服务端推送的 DebateRecord 快照渲染。

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const safeUrl = (u) => (/^https?:\/\//i.test(u) ? u : "#");
const timeOf = (iso) => new Date(iso).toLocaleTimeString("zh-CN", { hour12: false });

const SIDES = ["pro", "con"];
const SIDE = { pro: "正方", con: "反方" };
const PHASES = [
  ["research", "资料检索"],
  ["opening", "立论"],
  ["rebuttal", "驳论"],
  ["closing", "总结陈词"],
  ["judging", "裁判评议"],
];
const CRITERIA = [
  ["argument", "论证质量"],
  ["evidence", "证据运用"],
  ["clash", "交锋反驳"],
  ["delivery", "表达说服"],
];
const MARKED_REF_PATTERN = /〔([PC]A?\d{1,2})〕|\b([PC]A?\d{1,2})\b/g;

const main = $("#main");
const introHtml = main.innerHTML;
let stream = null;
let appConfig = null;

// ---------------- 初始化与路由 ----------------

async function init() {
  appConfig = await fetch("/api/config").then((r) => r.json());
  const badge = $("#mode-badge");
  if (appConfig.mock) {
    badge.textContent = "演示模式 · 不联网";
    badge.classList.add("mock");
  } else {
    badge.textContent = `裁判 ${appConfig.judgeModel} · ${appConfig.webSearch ? "博查搜索" : "未配置联网搜索"}`;
  }
  setupTeamModels();
  updateJudgeHint();
  $("#debate-form select[name=judgeCount]").addEventListener("change", updateJudgeHint);
  $("#debate-form").addEventListener("submit", onSubmit);
  main.addEventListener("click", onRefClick);
  window.addEventListener("hashchange", route);
  loadHistory();
  route();
}

// ---------------- 双方模型 ----------------

const TEAM_STORAGE_KEY = "debate.teamModels";
const modelOf = (id) => appConfig.models.find((m) => m.id === id);
const teamSelect = (side, kind) => $(`#debate-form select[name=${side}${kind}]`);

/** 模型下拉：没有配置密钥的厂商不可选。思考强度下拉随所选模型变化（各家档位不同）。 */
function setupTeamModels() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(TEAM_STORAGE_KEY) ?? "{}") ?? {};
  } catch {
    // 浏览器禁用存储时用默认选项
  }
  for (const side of SIDES) {
    const modelSelect = teamSelect(side, "Model");
    modelSelect.innerHTML = appConfig.models
      .map(
        (m) =>
          `<option value="${esc(m.id)}" ${m.available ? "" : "disabled"}>${esc(m.label)}${m.available ? "" : `（未配置 ${esc(m.keyEnv)}）`}</option>`,
      )
      .join("");
    const pick = [saved[side], appConfig.defaultTeam].find((t) => t && modelOf(t.model)?.available);
    const fallback = appConfig.models.find((m) => m.available);
    modelSelect.value = pick?.model ?? fallback?.id ?? appConfig.defaultTeam.model;
    fillEfforts(side, pick?.effort);
    modelSelect.addEventListener("change", () => fillEfforts(side, teamSelect(side, "Effort").value));
    teamSelect(side, "Effort").addEventListener("change", saveTeamModels);
  }
  const unavailable = appConfig.models.filter((m) => !m.available);
  $("#team-hint").textContent = [
    "思考强度用于该队的构思与发言，档位越高推理越充分，也更慢、更贵。",
    unavailable.length ? `使用${[...new Set(unavailable.map((m) => m.provider))].join("、")}模型需先在 .env 中配置 API Key。` : "",
    `裁判与证据核查固定使用 ${appConfig.judgeModel}。`,
  ].join("");
}

/** 换模型时保留原来的档位（新模型也有这一档时），否则用该模型的默认档位。 */
function fillEfforts(side, preferred) {
  const model = modelOf(teamSelect(side, "Model").value);
  const select = teamSelect(side, "Effort");
  if (!model) return;
  select.innerHTML = model.efforts
    .map((e) => `<option value="${esc(e.value)}">思考强度：${esc(e.label)} · ${esc(e.value)}${e.value === model.defaultEffort ? "（默认）" : ""}</option>`)
    .join("");
  select.value = model.efforts.some((e) => e.value === preferred) ? preferred : model.defaultEffort;
  saveTeamModels();
}

function teamModels() {
  return Object.fromEntries(SIDES.map((side) => [side, { model: teamSelect(side, "Model").value, effort: teamSelect(side, "Effort").value }]));
}

function saveTeamModels() {
  try {
    localStorage.setItem(TEAM_STORAGE_KEY, JSON.stringify(teamModels()));
  } catch {
    // 记不住也不影响使用
  }
}

function updateJudgeHint() {
  const n = Number($("#debate-form select[name=judgeCount]").value);
  $("#judge-hint").textContent = appConfig.judges.slice(0, n).map((j) => j.name).join("、");
}

function route() {
  const match = location.hash.match(/^#\/debate\/([\w-]+)$/);
  if (stream) stream.close();
  stream = null;
  if (match) openDebate(match[1]);
  else main.innerHTML = introHtml;
}

async function onSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const btn = $("#submit-btn");
  const errorEl = $("#form-error");
  errorEl.hidden = true;
  btn.disabled = true;
  try {
    const fields = Object.fromEntries(new FormData(form));
    const body = {
      topic: fields.topic,
      proStance: fields.proStance,
      conStance: fields.conStance,
      judgeCount: Number(fields.judgeCount),
      teams: teamModels(),
    };
    const res = await fetch("/api/debates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "创建失败");
    location.href = `live.html#${data.id}`;
    loadHistory();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

async function loadHistory() {
  const list = await fetch("/api/debates").then((r) => r.json());
  const statusText = (d) =>
    d.status === "running" ? "进行中" : d.status === "error" ? "失败" : d.winner === "tie" ? "平局" : `${SIDE[d.winner]}胜`;
  $("#history").innerHTML = list.length
    ? list
        .slice(0, 20)
        .map(
          (d) => `<li><a href="${d.version === 2 ? `live.html#${esc(d.id)}` : `#/debate/${esc(d.id)}`}">
            <span class="h-topic">${esc(d.topic)}</span>
            <span class="h-meta">${new Date(d.createdAt).toLocaleString("zh-CN", { hour12: false })} · ${statusText(d)}${d.mock ? " · 演示" : ""}</span>
          </a></li>`,
        )
        .join("")
    : `<li class="empty">暂无记录</li>`;
}

function openDebate(id) {
  main.innerHTML = `<section class="card"><div class="status-line"><span class="spinner"></span>加载中…</div></section>`;
  const es = new EventSource(`/api/debates/${id}/stream`);
  stream = es;
  es.onmessage = (e) => {
    const record = JSON.parse(e.data);
    // 八位辩手版的记录在直播页查看
    if (record.version === 2) {
      es.close();
      location.replace(`live.html#${id}`);
      return;
    }
    render(record);
    // 结束后必须主动关闭，否则 EventSource 会不断自动重连
    if (record.status !== "running") {
      es.close();
      loadHistory();
    }
  };
  es.onerror = async () => {
    if (es.readyState === EventSource.CLOSED || stream !== es) return;
    const res = await fetch(`/api/debates/${id}`);
    if (res.status === 404) {
      es.close();
      main.innerHTML = `<section class="card"><div class="error-box">辩论不存在</div></section>`;
    }
  };
}

// ---------------- 渲染 ----------------

function render(record) {
  // 重新渲染前记下展开的原文，避免实时更新把用户展开的内容折叠
  const openKeys = new Set([...main.querySelectorAll("details[open]")].map((d) => d.dataset.key));

  const ctx = buildIndex(record);
  main.innerHTML = [
    renderHead(record),
    record.error ? `<section class="card"><div class="error-box">辩论中断：${esc(record.error)}</div></section>` : "",
    renderVerdict(record),
    renderResearch(record, ctx),
    renderOpening(record, ctx),
    renderRebuttal(record, ctx),
    renderClosing(record, ctx),
    renderViolations(record),
    renderJudges(record),
    renderLog(record),
  ].join("");

  main.querySelectorAll("details[data-key]").forEach((d) => {
    if (openKeys.has(d.dataset.key)) d.open = true;
  });
  const log = main.querySelector(".log");
  if (log) log.scrollTop = log.scrollHeight;
}

function buildIndex(record) {
  const evidence = new Map();
  const args = new Map();
  for (const side of SIDES) {
    for (const e of record.research[side]?.evidence ?? []) evidence.set(e.id, e);
    for (const a of record.opening[side]?.arguments ?? []) args.set(a.id, { ...a, side });
  }
  return { evidence, args };
}

/**
 * 转义文本，并把编号渲染成可点击的标签：
 * 句末的〔P1〕标注显示为上标脚注；旧记录里直接写在正文中的编号显示为行内标签。
 */
function withRefs(text, ctx) {
  return esc(text).replace(MARKED_REF_PATTERN, (_, marked, bare) => refChip(marked ?? bare, ctx, Boolean(marked)));
}

function refChip(ref, ctx, footnote = false) {
  const tag = footnote ? "sup" : "span";
  const cls = footnote ? "ref fn" : "ref";
  if (ref.includes("A")) {
    const a = ctx.args.get(ref);
    return a
      ? `<${tag} class="${cls} arg-${a.side}" data-ref="${ref}" title="${esc(a.title)}">${ref}</${tag}>`
      : `<${tag} class="${cls} invalid" title="辩论中不存在该论点">${ref}</${tag}>`;
  }
  const e = ctx.evidence.get(ref);
  return e
    ? `<${tag} class="${cls} ev-${e.side}" data-ref="${ref}" title="${esc(`${sourceNameOf(e)}：${e.claim}`)}">${ref}</${tag}>`
    : `<${tag} class="${cls} invalid" title="证据池中不存在该编号">${ref}</${tag}>`;
}

/** 出处名称：研究员核对过的出处，没有时用网站名或网页标题。 */
const sourceNameOf = (e) => e.attribution || e.sources?.[0]?.site || e.sources?.[0]?.title || e.id;

/** 发言下方的「引用来源」：每条证据的出处、网页标题、网站、日期和原文链接。 */
function sourceList(ids, ctx) {
  const items = (ids ?? [])
    .map((id) => ctx.evidence.get(id))
    .filter(Boolean)
    .map((e) => {
      const s = e.sources[0];
      const meta = [s.site, s.published].filter(Boolean).map(esc).join(" · ");
      return `<li>${refChip(e.id, ctx)} <b>${esc(sourceNameOf(e))}</b>
        <span class="src-meta">《${esc(s.title)}》${meta ? ` · ${meta}` : ""}</span>
        <a href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener noreferrer">原文</a></li>`;
    });
  return items.length ? `<div class="src-block"><div class="src-label">引用来源</div><ul class="src-list">${items.join("")}</ul></div>` : "";
}

const formatDuration = (sec) => {
  const m = Math.floor(sec / 60);
  return m ? `${m} 分 ${String(sec % 60).padStart(2, "0")} 秒` : `${sec} 秒`;
};
const durationBadge = (speech) =>
  speech?.durationSec ? `<span class="duration" title="按正常语速估算">约 ${formatDuration(speech.durationSec)} · ${speech.spokenChars} 字</span>` : "";

function phaseIndex(record) {
  return PHASES.findIndex(([p]) => p === record.phase);
}

/** 某方在某环节的内容尚未生成时的占位。 */
function placeholder(record, phase) {
  const cur = record.phase === "finished" ? PHASES.length : phaseIndex(record);
  const idx = PHASES.findIndex(([p]) => p === phase);
  if (record.status === "running" && idx === cur) {
    return `<div class="pending"><span class="status-line" style="margin:0"><span class="spinner"></span>生成中…</span></div>`;
  }
  return `<div class="pending">${record.status === "error" && idx >= cur ? "未进行" : "等待中"}</div>`;
}

function renderHead(record) {
  const cur = record.phase === "finished" ? PHASES.length : phaseIndex(record);
  const steps = PHASES.map(([, label], i) => {
    let cls = "";
    if (i < cur || record.status === "done") cls = "done";
    else if (i === cur) cls = record.status === "error" ? "failed" : "active";
    return `<div class="step ${cls}">${cls === "done" ? "✓ " : ""}${label}</div>`;
  }).join("");
  const last = record.log.at(-1);
  const status =
    record.status === "running"
      ? `<div class="status-line"><span class="spinner"></span>${esc(last?.message ?? "准备中")}</div>`
      : "";
  return `<section class="card debate-head">
    <h1>${esc(record.input.topic)}${record.mock ? ` <span class="badge mock">演示数据</span>` : ""}</h1>
    <div class="stances">
      <div class="stance pro"><span class="side-tag pro">正方</span> ${esc(record.input.proStance)}</div>
      <div class="stance con"><span class="side-tag con">反方</span> ${esc(record.input.conStance)}</div>
    </div>
    <div class="stepper">${steps}</div>
    ${status}
  </section>`;
}

function scoreTable(scores, highlight) {
  const rows = [...CRITERIA, ["total", "总分"]]
    .map(([key, label]) => {
      const p = scores.pro[key];
      const c = scores.con[key];
      return `<tr class="${key === "total" ? "total" : ""}"><td>${label}</td>
        <td class="${highlight && p > c ? "win" : ""}">${p}</td>
        <td class="${highlight && c > p ? "win" : ""}">${c}</td></tr>`;
    })
    .join("");
  return `<table class="scores"><thead><tr><th></th><th>正方</th><th>反方</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderVerdict(record) {
  const v = record.verdict;
  if (!v) return "";
  const title = v.winner === "tie" ? "平局" : `${SIDE[v.winner]}获胜`;
  const how = { majority: "多数票决定", score_tiebreak: "票数相同，按平均总分判定", tie: "票数与平均分均相同" }[v.decidedBy];
  return `<section class="card verdict ${v.winner}">
    <div class="verdict-title">🏆 ${title}</div>
    <div class="verdict-sub">裁判组投票 正方 ${v.votes.pro} : 反方 ${v.votes.con}（${how}）· 下表为各裁判平均分</div>
    ${scoreTable(v.averageScores, true)}
    <p>${esc(v.summary)}</p>
  </section>`;
}

function twoColumns(title, count, renderSide) {
  return `<section class="card phase">
    <h2>${title}${count ? ` <span class="count">${count}</span>` : ""}</h2>
    <div class="columns">${SIDES.map(
      (side) => `<div class="column"><h3><span class="side-tag ${side}">${SIDE[side]}</span></h3>${renderSide(side)}</div>`,
    ).join("")}</div>
  </section>`;
}

function searchLog(record, r) {
  if (r.webSearchEnabled === false) {
    return `<div class="search-log warn">未配置 BOCHA_API_KEY，没有进行联网检索</div>`;
  }
  const calls = r.searchCalls;
  if (!calls) {
    // 旧记录只保存了搜索词
    return r.searchQueries.length
      ? `<div class="queries">搜索：${r.searchQueries.map((q) => `<code>${esc(q)}</code>`).join("")}</div>`
      : "";
  }
  const engine = record.mock ? "演示搜索" : "博查搜索";
  const ok = calls.filter((c) => c.ok).length;
  const head = `${engine} ${calls.length} 次${ok === calls.length ? "，全部成功" : `，成功 ${ok} 次`} · 查阅 ${r.consultedSources.length} 个网页`;
  const rows = calls
    .map(
      (c) => `<li class="${c.ok ? "ok" : "fail"}"><span class="q">${c.ok ? "✓" : "✗"} ${esc(c.query)}</span>
        <span class="r">${c.ok ? `${c.results} 条结果 · 新增 ${c.newPages} 个网页` : esc(c.error ?? "失败")}${record.mock ? "" : ` · ${(c.ms / 1000).toFixed(1)} 秒`}</span>
        ${c.at || c.logId ? `<span class="call-id">${c.at ? new Date(c.at).toLocaleString("zh-CN", { hour12: false }) : ""}${c.logId ? ` · log_id ${esc(c.logId)}` : ""}</span>` : ""}</li>`,
    )
    .join("");
  return `<details class="search-log" data-key="search-${r.side}">
    <summary>${head}</summary><ol>${rows}</ol></details>`;
}

function renderResearch(record, ctx) {
  const total = ctx.evidence.size;
  return twoColumns("资料检索 · 证据池", total ? `共 ${total} 条证据，均带网页原文出处` : "", (side) => {
    const r = record.research[side];
    if (!r) return placeholder(record, "research");
    const items = r.evidence.length
      ? r.evidence
          .map(
            (e) => `<div class="item ${side}" id="item-${e.id}">
              <div class="item-head"><span class="id-chip">${e.id}</span><span>${esc(e.claim)}</span></div>
              <div class="attribution">出处：${esc(sourceNameOf(e))}</div>
              ${e.sources
                .map(
                  (s, i) => `<details class="source" data-key="${e.id}-${i}">
                    <summary>网页：${esc(s.title)}${s.site ? ` · ${esc(s.site)}` : ""}${s.published ? ` · ${esc(s.published)}` : ""}</summary>
                    <blockquote>${esc(s.quote)}</blockquote>
                    <a class="src-link" href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener noreferrer">${esc(s.url)}</a>
                  </details>`,
                )
                .join("")}
            </div>`,
          )
          .join("")
      : `<div class="pending">未检索到带出处的证据，该方只能进行推理论证</div>`;
    return searchLog(record, r) + items;
  });
}

function renderOpening(record, ctx) {
  return twoColumns("立论", "", (side) => {
    const s = record.opening[side];
    if (!s) return placeholder(record, "opening");
    const part = (label, text) =>
      text ? `<div class="item ${side} speech-part"><div class="part-label">${label}</div><p>${withRefs(text, ctx)}</p></div>` : "";
    const args = s.arguments
      .map(
        (a) => `<div class="item ${side}" id="item-${a.id}">
          <div class="item-head"><span class="id-chip">${a.id}</span><span class="item-title">${esc(a.title)}</span></div>
          <p>${withRefs(a.reasoning, ctx)}</p>
          ${sourceList(a.evidenceIds, ctx)}
        </div>`,
      )
      .join("");
    return `${durationBadge(s)}${part("开场", s.intro)}${args}${part("结语", s.conclusion)}`;
  });
}

function renderRebuttal(record, ctx) {
  return twoColumns("驳论", "", (side) => {
    const s = record.rebuttal[side];
    if (!s) return placeholder(record, "rebuttal");
    if (!s.rebuttals.length) return `<div class="pending">未提出有效驳论</div>`;
    return (
      durationBadge(s) +
      s.rebuttals
        .map((r) => {
          const target = ctx.args.get(r.targetArgumentId);
          return `<div class="item ${side}">
          <div class="target">针对 ${refChip(r.targetArgumentId, ctx)} ${esc(target?.title ?? "")}</div>
          <p>${withRefs(r.response, ctx)}</p>
          ${sourceList(r.evidenceIds, ctx)}
        </div>`;
        })
        .join("")
    );
  });
}

function renderClosing(record, ctx) {
  return twoColumns("总结陈词", "", (side) => {
    const s = record.closing[side];
    if (!s) return placeholder(record, "closing");
    return `${durationBadge(s)}<div class="item ${side}">
      <p>${withRefs(s.statement, ctx)}</p>
      ${sourceList(s.evidenceIds, ctx)}
    </div>`;
  });
}

function renderViolations(record) {
  if (!record.violations.length) return "";
  const phaseLabel = Object.fromEntries(PHASES);
  const items = record.violations
    .map(
      (v) => `<li class="${v.corrected ? "fixed" : "open"}">
        <span class="tag">${v.corrected ? "已修正" : "未修正·已提交裁判"}</span>
        ${SIDE[v.side]}${phaseLabel[v.phase] ?? ""}：${esc(v.detail)}
      </li>`,
    )
    .join("");
  return `<section class="card">
    <h2>引用校验记录</h2>
    <ul class="violations">${items}</ul>
  </section>`;
}

function renderJudges(record) {
  const expected = record.input.judgeCount;
  if (record.phase !== "judging" && record.phase !== "finished" && !record.judges.length) return "";
  const cards = record.judges
    .map(
      (j) => `<div class="judge">
        <div class="judge-head">
          <div><b>${esc(j.name)}</b> <span class="judge-focus">${esc(j.focus)}</span></div>
          <span class="side-tag ${j.winner}">投${SIDE[j.winner]}</span>
        </div>
        ${scoreTable(j.scores, true)}
        <p>${esc(j.reason)}</p>
        <ul>${j.keyMoments.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>
      </div>`,
    )
    .join("");
  const waiting =
    record.status === "running" && record.judges.length < expected
      ? `<div class="pending"><span class="status-line" style="margin:0"><span class="spinner"></span>已有 ${record.judges.length}/${expected} 位裁判提交评分</span></div>`
      : "";
  return `<section class="card">
    <h2>裁判组评分</h2>
    <div class="judges">${cards}</div>
    ${waiting}
  </section>`;
}

function renderLog(record) {
  const items = record.log
    .map((l) => `<li class="${l.level}"><time>${timeOf(l.time)}</time><span>${esc(l.message)}</span></li>`)
    .join("");
  return `<section class="card"><details data-key="log" ${record.status === "running" ? "open" : ""}>
    <summary><b>运行日志</b></summary>
    <ul class="log">${items}</ul>
  </details></section>`;
}

// 点击证据/论点标签，滚动到对应卡片并高亮
function onRefClick(event) {
  const chip = event.target.closest(".ref[data-ref]");
  if (!chip) return;
  const target = document.getElementById(`item-${chip.dataset.ref}`);
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.remove("flash");
  void target.offsetWidth;
  target.classList.add("flash");
}

init();
