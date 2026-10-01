// 辩论直播：订阅服务端推送的辩论记录，按发言顺序逐段呈现辩手的发言（四辩制 8 人，公共论坛制 4 人）。
// 比赛中只显示公开信息；辩手的资料（本方共享的证据库、检索记录、个人构思）在赛后统一公开。

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const safeUrl = (u) => (/^https?:\/\//i.test(u) ? u : "#");
const timeOf = (iso) => new Date(iso).toLocaleTimeString("zh-CN", { hour12: false });
const dateTimeOf = (iso) => new Date(iso).toLocaleString("zh-CN", { hour12: false });

const svg = (body, cls = "icon") =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON = {
  lock: svg('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  file: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
  eye: svg('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  x: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
  bulb: svg('<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/>'),
  chip: svg('<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>'),
};
const GEAR = `<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="16" fill="none" stroke="currentColor" stroke-width="8" stroke-dasharray="5.2 3.18"/><circle cx="24" cy="24" r="12" fill="currentColor"/><circle cx="24" cy="24" r="5" fill="var(--gear-hole)"/></svg>`;
const GEARS = `<div class="gears"><span class="g big">${GEAR}</span><span class="g small">${GEAR}</span></div>`;

const SIDE = { pro: "正方", con: "反方" };
const FOUR_STAGES = [
  ["research", "赛前准备"],
  ["opening", "立论"],
  ["rebuttal", "驳论"],
  ["cross", "质询与小结"],
  ["free", "自由辩论"],
  ["closing", "总结陈词"],
  ["judging", "评委评议"],
];
// 公共论坛制：三轮交叉质询的问与答都由辩手独立作答
const PF_STAGES = [
  ["research", "赛前准备"],
  ["opening", "立论"],
  ["crossfire1", "一辩交叉质询"],
  ["rebuttal", "反驳"],
  ["crossfire2", "二辩交叉质询"],
  ["pf_summary", "总结"],
  ["grand_crossfire", "全场交叉质询"],
  ["final_focus", "焦点总结"],
  ["judging", "评委评议"],
];
const TURN_LABEL = {
  opening: "立论",
  rebuttal: "驳论",
  question: "质询",
  answer: "答质询",
  summary: "质询小结",
  free: "自由辩论",
  closing: "总结陈词",
  pf_summary: "总结",
  final_focus: "焦点总结",
  check: "证据核查",
};
const PF_TURN_LABEL = { rebuttal: "反驳", question: "交叉质询", answer: "答交叉质询" };
const CRITERIA = [
  ["argument", "论证质量"],
  ["evidence", "证据运用"],
  ["clash", "交锋反驳"],
  ["delivery", "表达说服"],
];
const MARK = /〔([PC](?:A\d{1,2}|[1-4]-\d{1,2}))〕/g;

const debateId = decodeURIComponent(location.hash.slice(1));
const feed = $("#feed");
let record = null;
let appConfig = {};
let renderedTurns = 0;
let lastStage = null;
let initialRender = true;
let afterRendered = false;
let following = true;

// ---------------- 数据索引 ----------------

const isPf = () => record?.input?.format === "pf";
const stages = () => (isPf() ? PF_STAGES : FOUR_STAGES);
const stageLabel = (stage) => Object.fromEntries(stages())[stage] ?? stage;
const turnLabel = (kind) => (isPf() && PF_TURN_LABEL[kind]) || TURN_LABEL[kind];
/** 「八位辩手」「四位辩手」 */
const crowd = () => `${record.debaters.length === 4 ? "四" : "八"}位辩手`;

const debaterOf = (id) => record.debaters.find((d) => d.id === id);
const nameOf = (id) => (id === "referee" ? "证据核查" : debaterOf(id)?.name ?? id);
const allEvidence = () => record.debaters.flatMap((d) => d.bank);
const evidenceOf = (id) => allEvidence().find((e) => e.id === id);
const argumentOf = (id) => record.turns.flatMap((t) => t.arguments ?? []).find((a) => a.id === id);
const sourceNameOf = (e) => e.attribution || e.sources?.[0]?.site || e.sources?.[0]?.title || e.id;
const formatDuration = (sec) => {
  const m = Math.floor(sec / 60);
  return m ? `${m} 分 ${String(sec % 60).padStart(2, "0")} 秒` : `${sec} 秒`;
};

// ---------------- 文本渲染 ----------------

function refChip(id) {
  if (/^[PC]A/.test(id)) {
    const a = argumentOf(id);
    const side = id.startsWith("P") ? "pro" : "con";
    return `<sup class="ref fn arg-${side}" title="${esc(a?.title ?? "未知论点")}">${id}</sup>`;
  }
  const e = evidenceOf(id);
  if (!e) return `<sup class="ref fn invalid" title="不存在的证据">${id}</sup>`;
  return `<sup class="ref fn ev-${e.side}${e.invalid ? " struck" : ""}" data-ev="${id}" title="${esc(`${sourceNameOf(e)}：${e.claim}`)}">${id}</sup>`;
}

const withRefs = (text) => esc(text).replace(MARK, (_, id) => refChip(id));
const paras = (text) =>
  text
    .split(/\n+/)
    .filter((p) => p.trim())
    .map((p, i) => `<p style="--i:${i}">${withRefs(p)}</p>`)
    .join("");

/** 发言中引用的证据：出处、网页、网站、日期、原文链接和核对状态。 */
function sourceList(ids) {
  const items = (ids ?? [])
    .map(evidenceOf)
    .filter(Boolean)
    .map((e) => {
      const s = e.sources[0];
      const meta = [s.site, s.published].filter(Boolean).map(esc).join(" · ");
      const check = s.checkedAt ? `<span class="checked" title="系统在 ${esc(dateTimeOf(s.checkedAt))} 打开网页并核对到了摘录原文">✓ 原文已核对</span>` : "";
      return `<li class="src-item" data-ev="${e.id}"><span class="ref ev-${e.side}">${e.id}</span> <b>${esc(sourceNameOf(e))}</b>
        <span class="src-meta">《${esc(s.title)}》${meta ? ` · ${meta}` : ""}</span>
        <a href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener noreferrer">原文</a> ${check}
        <span class="struck-tag">核查不成立</span></li>`;
    });
  return items.length ? `<div class="src-block"><div class="src-label">引用来源</div><ul class="src-list">${items.join("")}</ul></div>` : "";
}

// ---------------- 头部、席位 ----------------

function renderHead() {
  document.title = `${record.input.topic} · 辩论直播`;
  $("#topic").textContent = record.input.topic;
  $("#stance-pro").textContent = record.input.proStance;
  $("#stance-con").textContent = record.input.conStance;
  for (const side of ["pro", "con"]) $(`#model-${side}`).innerHTML = teamModelHtml(record.input.teams?.[side]);
  const pfNote = isPf()
    ? `公共论坛制（PF）：正反各两位辩手，掷硬币决定${SIDE[record.rules?.first ?? "pro"]}先发言；三轮交叉质询的每一问、每一答都由对应辩手独立作答。`
    : "";
  const team = isPf() ? "同队两人" : "同队四人";
  $("#rule").innerHTML = `${ICON.lock}<span>${pfNote}${crowd()}是${crowd()[0]}个独立的 Agent：各自检索、核对并整理证据，${team}共享证据库，对方看不到；辩手能看到公开发言、本方证据库和对方已公开的证据。证据只能在赛前准备中检索，立论开始前复核并封存：打不开或出处无法确定的证据一律删除；每方最多收集 ${appConfig.evidencePerSide ?? 20} 条、全场最多使用 ${appConfig.maxEvidenceUsedPerSide ?? 9} 条。每方最多质疑对方证据 ${appConfig.maxChallengesPerSide ?? 3} 次，由中立的核查员联网核查。</span>`;
  const badge = $("#mode-badge");
  badge.textContent = record.mock ? "演示模式 · 不联网" : "实时辩论";
  badge.classList.toggle("mock", record.mock);

  const list = stages();
  const cur = record.stage === "finished" ? list.length : list.findIndex(([s]) => s === record.stage);
  $("#stepper").innerHTML = list.map(([, label], i) => {
    let cls = "";
    if (i < cur || record.status === "done") cls = "done";
    else if (i === cur) cls = record.status === "error" ? "failed" : "active";
    return `<div class="step ${cls}">${cls === "done" ? "✓ " : ""}${label}</div>`;
  }).join("");
}

/** 这一方四位辩手用的模型与思考强度（整队统一）；旧记录没有保存时不显示。 */
function teamModelHtml(team) {
  if (!team) return "";
  const model = appConfig.models?.find((m) => m.id === team.model);
  const effort = model?.efforts.find((e) => e.value === team.effort);
  return `${ICON.chip}<span>${esc(model?.label ?? team.model)}</span><span class="effort">思考强度 ${esc(effort ? `${effort.label} · ${effort.value}` : team.effort)}</span>`;
}

function renderBench() {
  const busy = record.activity?.debater;
  const allBusy = record.status === "running" && record.stage === "research";
  const finished = record.status !== "running";
  for (const side of ["pro", "con"]) {
    $(`#team-${side}`).innerHTML = record.debaters
      .filter((d) => d.side === side)
      .map((d) => {
        const cls = [
          "seat",
          side,
          busy === d.id || allBusy ? "thinking" : "",
          record.verdict?.best === d.id ? "best" : "",
          finished ? "unlocked clickable" : "",
        ].join(" ");
        const files = `${finished ? ICON.folder : ICON.lock}<span>${d.bank.length}</span>`;
        return `<div class="${cls}" data-id="${d.id}" title="${d.name} · 证据库 ${d.bank.length} 条${finished ? "（已公开，点击查看）" : "（本方共享，赛后公开）"}">
          <div class="avatar">${d.short}<span class="seat-gear">${GEAR}</span><span class="seat-crown">★</span></div>
          <div class="seat-name">${d.name.slice(2)}</div>
          <div class="seat-files">${files}</div>
        </div>`;
      })
      .join("");
  }
  const used = (side) => record.challenges.filter((c) => c.side === side).length;
  const max = appConfig.maxChallengesPerSide ?? 3;
  // 证据使用：一条本方证据第一次在发言中被引用即算用掉一条
  const cited = (side) => allEvidence().filter((e) => e.side === side && e.disclosedAt !== undefined).length;
  const cap = appConfig.maxEvidenceUsedPerSide ?? 9;
  $("#challenge-count").innerHTML = `证据使用 <span class="pro">正方 ${cited("pro")}/${cap}</span> · <span class="con">反方 ${cited("con")}/${cap}</span><br>证据质疑 <span class="pro">正方 ${used("pro")}/${max}</span> · <span class="con">反方 ${used("con")}/${max}</span>`;
  $("#now").innerHTML = record.error
    ? `<span class="error-text">辩论中断</span>`
    : record.activity
      ? esc(record.activity.label)
      : record.status === "done"
        ? "辩论结束 · 点击席位查看辩手资料"
        : `${stageLabel(record.stage)}`;
}

// ---------------- 发言流 ----------------

function researchCard() {
  const cells = record.debaters
    .map((d) => {
      const ok = d.searchCalls.filter((c) => c.ok).length;
      return `<div class="rc-cell ${d.side}">
        <div class="rc-name"><span class="avatar ${d.side}">${d.short}</span>${d.name}</div>
        <div class="rc-stat">搜索 ${ok}/${d.searchCalls.length} · 丢弃 ${d.rejectedPages.length} 个网页</div>
        <div class="rc-stat">证据库 <b>${d.bank.length}</b> 条 ${ICON.lock}</div>
      </div>`;
    })
    .join("");
  return `<section class="card research-card" id="research-card">
    <div class="section-title">赛前准备 · ${crowd()}独立检索</div>
    <p class="hint">每位辩手自己决定搜什么，打开每个网页核对原文，打不开或对不上的网页直接丢弃。检索结束后每条证据再复核一次，打不开或出处无法确定的删除，然后证据库封存${record.evidenceLockedAt ? `（已于 ${esc(dateTimeOf(record.evidenceLockedAt))} 封存）` : ""}，立论开始后不能再检索。证据内容赛后公开。</p>
    <div class="rc-grid">${cells}</div>
  </section>`;
}

function turnCard(t) {
  if (t.kind === "check") return checkCard(t);
  const d = debaterOf(t.speaker);
  const short = ["question", "answer", "free"].includes(t.kind) ? "short" : "";
  const badge = t.kind === "question" ? `<span class="qa-badge">问</span>` : t.kind === "answer" ? `<span class="qa-badge">答</span>` : "";
  const tag =
    t.kind === "question"
      ? `${turnLabel("question")} · 问${nameOf(t.target)}`
      : t.kind === "answer"
        ? `答${nameOf(t.target)}${isPf() ? "的交叉质询" : "质询"}`
        : turnLabel(t.kind);
  const duration = t.durationSec && !short ? `<span class="duration">约 ${formatDuration(t.durationSec)} · ${t.spokenChars} 字</span>` : "";
  const body = t.parts
    ? t.parts
        .map(
          (p) => `<div class="part">
            <div class="part-label">${p.argumentId ? `<span class="id-chip">${p.argumentId}</span> ${esc(p.title)}` : esc(p.label)}</div>
            ${paras(p.text)}
          </div>`,
        )
        .join("")
    : paras(t.text);
  return `<article class="turn ${d.side} ${short}" data-index="${t.index}">
    <div class="turn-head">
      ${badge}<span class="avatar ${d.side}">${d.short}</span>
      <span class="turn-name">${d.name}</span>
      <span class="turn-tag">${esc(tag)}</span>
      ${duration}
      <span class="challenge-slot"></span>
    </div>
    <div class="turn-body">${body}</div>
    ${sourceList(t.evidenceIds)}
  </article>`;
}

const VERDICT_CLASS = { 成立: "ok", 部分成立: "partial", 不成立: "bad" };

function checkCard(t) {
  const c = record.challenges.find((x) => x.id === t.challengeId);
  if (!c) return `<article class="turn neutral check-card" data-index="${t.index}"><p>${esc(t.text)}</p></article>`;
  const e = evidenceOf(c.evidenceId);
  const facts = [
    `原网页${c.pageReachable ? "可以打开" : "无法打开"}`,
    `摘录原文${c.quoteOnPage ? "在正文中找到" : "未在正文中找到"}`,
  ].join(" · ");
  const corroboration = (c.corroboration ?? [])
    .map((r) => `<li><a href="${esc(safeUrl(r.url))}" target="_blank" rel="noopener noreferrer">${esc(r.title)}</a></li>`)
    .join("");
  return `<article class="turn neutral check-card" data-index="${t.index}">
    <div class="check-head">${ICON.search}<b>证据核查</b>
      <span class="verdict-tag ${VERDICT_CLASS[c.verdict] ?? ""}">${esc(c.verdict ?? "核查中")}</span></div>
    <p><b>${nameOf(c.by)}</b>质疑<b>${nameOf(c.owner)}</b>的证据 ${refChip(c.evidenceId)}：${esc(c.reason)}</p>
    ${e ? `<p class="check-claim">被质疑的证据：${esc(e.claim)}（出处：${esc(sourceNameOf(e))}）</p>` : ""}
    <p class="check-facts">${facts}</p>
    <p>${esc(c.explanation ?? "")}</p>
    ${corroboration ? `<details class="source"><summary>联网搜索到的相关网页</summary><ul class="src-list">${corroboration}</ul></details>` : ""}
  </article>`;
}

function appendTurn(t, animate) {
  if (t.stage !== lastStage) {
    lastStage = t.stage;
    feed.insertAdjacentHTML("beforeend", `<div class="divider"><span>${esc(stageLabel(t.stage))}</span></div>`);
  }
  const tpl = document.createElement("template");
  tpl.innerHTML = turnCard(t).trim();
  const el = tpl.content.firstElementChild;
  if (animate) el.classList.add("enter", "reveal");
  feed.append(el);
}

/** 发言公开后才会知道的信息：谁发起了质疑、哪些证据后来被判定不成立。 */
function updateMarks() {
  for (const t of record.turns) {
    if (!t.challengeId || t.kind === "check") continue;
    const slot = feed.querySelector(`.turn[data-index="${t.index}"] .challenge-slot`);
    const c = record.challenges.find((x) => x.id === t.challengeId);
    if (slot && c && !slot.innerHTML) slot.innerHTML = `<span class="challenge-badge">发起质疑 〔${c.evidenceId}〕</span>`;
  }
  const invalid = new Set(allEvidence().filter((e) => e.invalid).map((e) => e.id));
  feed.querySelectorAll("[data-ev]").forEach((el) => el.classList.toggle("struck", invalid.has(el.dataset.ev)));
}

function renderActivity() {
  const box = $("#activity");
  const a = record.activity;
  if (!a || record.status !== "running") {
    box.innerHTML = "";
    return;
  }
  const d = a.debater ? debaterOf(a.debater) : null;
  const teamBank = d ? record.debaters.filter((x) => x.side === d.side).reduce((n, x) => n + x.bank.length, 0) : 0;
  const visible = d
    ? `<div class="visibility">${ICON.eye}可见：公开发言 ${record.turns.length} 段 · 本方证据库 ${teamBank} 条（对方未公开的证据不可见）</div>`
    : "";
  const html = `<div class="turn ${d ? d.side : "neutral"} thinking-card">
    ${GEARS}
    <div>
      <div class="thinking-who">${d ? `<b>${d.name}</b>` : "<b>赛场</b>"}</div>
      <div class="thinking-text">${esc(a.label)}<span class="dots"><i>.</i><i>.</i><i>.</i></span></div>
      ${visible}
    </div>
  </div>`;
  // 同一个活动不重复替换，避免齿轮动画反复重启
  if (box.dataset.key !== `${a.debater}|${a.label}|${record.turns.length}`) {
    box.dataset.key = `${a.debater}|${a.label}|${record.turns.length}`;
    box.innerHTML = html;
  }
}

// ---------------- 赛后：评议与资料公开 ----------------

function scoreTable(scores) {
  const rows = [...CRITERIA, ["total", "总分"]]
    .map(([key, label]) => {
      const p = scores.pro[key];
      const c = scores.con[key];
      return `<tr class="${key === "total" ? "total" : ""}"><td>${label}</td>
        <td class="${p > c ? "win" : ""}">${p}</td><td class="${c > p ? "win" : ""}">${c}</td></tr>`;
    })
    .join("");
  return `<table class="scores"><thead><tr><th></th><th>正方</th><th>反方</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function judgingHtml() {
  const v = record.verdict;
  if (!v) return "";
  const title = v.winner === "tie" ? "平局" : `${SIDE[v.winner]}获胜`;
  const how = { majority: "多数票决定", score_tiebreak: "票数相同，按平均总分判定", tie: "票数与平均分均相同" }[v.decidedBy];
  const scoreCol = (side) =>
    `<div class="score-col"><h4><span class="side-tag ${side}">${SIDE[side]}</span></h4>
      ${v.debaterScores
        .filter((s) => s.debater.startsWith(side))
        .map((s) => {
          const d = debaterOf(s.debater);
          const best = v.best === s.debater;
          return `<div class="score-row ${best ? "best" : ""}">
            <span class="avatar ${d.side}">${d.short}</span>
            <span class="who">${d.name}${best ? `<span class="best-tag">★ 最佳辩手</span>` : ""}</span>
            <span class="score">${s.score}</span>
            <span class="comment">${esc(s.comment)}</span>
          </div>`;
        })
        .join("")}</div>`;
  const judges = record.judges
    .map(
      (j) => `<div class="judge">
        <div class="judge-head"><div><b>${esc(j.name)}</b> <span class="judge-focus">${esc(j.focus)}</span></div>
          <span class="side-tag ${j.winner}">投${SIDE[j.winner]}</span></div>
        ${scoreTable(j.scores)}
        <p>${esc(j.reason)}</p>
        <ul>${j.keyMoments.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>
      </div>`,
    )
    .join("");
  return `<div class="divider"><span>评委评议</span></div>
    <section class="card verdict-banner ${v.winner} enter">
      <div class="label">裁判组投票 正方 ${v.votes.pro} : 反方 ${v.votes.con}（${how}）</div>
      <div class="headline">${title}</div>
      <p>${esc(v.summary)}</p>
      <div class="team-scores">
        <div class="pro"><b>${v.averageScores.pro.total}</b>正方平均总分</div>
        <div class="con"><b>${v.averageScores.con.total}</b>反方平均总分</div>
      </div>
    </section>
    ${v.debaterScores.length ? `<div class="section-title">辩手评分（各裁判平均）</div><section class="card"><div class="score-grid">${scoreCol("pro")}${scoreCol("con")}</div></section>` : ""}
    <div class="section-title">各位裁判</div>
    <section class="card"><div class="judges">${judges}</div></section>`;
}

function explorerHtml() {
  let i = 0;
  const row = (key, icon, label, count, cls = "") =>
    `<button class="tree-row file-row ${cls}" data-key="${esc(key)}" style="--i:${i++}">${icon}<span class="name">${esc(label)}</span>${count !== undefined ? `<span class="count">${count}</span>` : ""}</button>`;
  const tree = ["pro", "con"]
    .map((side) => {
      const members = record.debaters.filter((d) => d.side === side);
      return `<div class="tree-side ${side}">
        <div class="tree-row side-row" style="--i:${i++}">${ICON.folder}<span class="name">${SIDE[side]}</span></div>
        ${members
          .map((d) => {
            const evidence = d.bank
              .map((e) => row(`ev:${e.id}`, ICON.file, `${e.id} ${e.claim.slice(0, 18)}`, undefined, e.invalid ? "struck" : e.disclosedAt === undefined ? "undisclosed" : ""))
              .join("");
            return `<div class="tree-row debater-row" style="--i:${i++}">${ICON.folder}<span class="name">${d.name}</span><span class="count">${d.bank.length}</span></div>
              ${evidence}
              ${row(`search:${d.id}`, ICON.search, "检索记录", d.searchCalls.length)}
              ${row(`rejected:${d.id}`, ICON.x, "丢弃的网页", d.rejectedPages.length)}
              ${row(`plans:${d.id}`, ICON.bulb, "构思笔记", d.plans.length)}`;
          })
          .join("")}
      </div>`;
    })
    .join("");
  const total = record.debaters.reduce((n, d) => n + d.bank.length, 0);
  const disclosed = allEvidence().filter((e) => e.disclosedAt !== undefined).length;
  return `<div class="divider"><span>赛后公开 · 辩手资料</span></div>
    <section class="card explorer enter" id="explorer">
      <div class="explorer-head">
        <div class="explorer-title">${ICON.folder}<b>${crowd()}的资料</b></div>
        <div class="explorer-sub">共 ${total} 条证据，其中 ${disclosed} 条在比赛中被引用公开；灰色为未引用，删除线为核查不成立</div>
      </div>
      <div class="explorer-body">
        <nav class="tree">${tree}</nav>
        <article class="preview" id="preview"></article>
      </div>
    </section>`;
}

function evidencePreview(e) {
  const s = e.sources[0];
  const owner = debaterOf(e.owner);
  const usedIn = record.turns.filter((t) => t.kind !== "check" && t.evidenceIds.includes(e.id));
  const status = e.invalid
    ? `<span class="chip bad">核查不成立</span>`
    : e.disclosedAt !== undefined
      ? `<span class="chip ${e.side}">第 ${e.disclosedAt + 1} 段公开</span>`
      : `<span class="chip">未引用</span>`;
  const challenged = record.challenges.find((c) => c.evidenceId === e.id);
  return `<div class="crumb">${owner.name} / 证据库 / ${e.id}</div>
    <h3>${esc(e.claim)}</h3>
    <div class="meta">${status}<span>出处：${esc(sourceNameOf(e))}</span></div>
    <blockquote class="quote">${esc(s.quote)}</blockquote>
    <p class="src-line">网页：<a href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a>${s.site ? ` · ${esc(s.site)}` : ""}${s.published ? ` · ${esc(s.published)}` : ""}</p>
    ${s.checkedAt ? `<p class="src-line">✓ ${esc(dateTimeOf(s.checkedAt))} 打开网页核对到摘录原文</p>` : ""}
    ${usedIn.length ? `<p class="src-line">被引用：${usedIn.map((t) => `第 ${t.index + 1} 段（${nameOf(t.speaker)}${turnLabel(t.kind)}）`).join("、")}</p>` : ""}
    ${challenged ? `<p class="src-line">被${nameOf(challenged.by)}质疑，核查结论：${esc(challenged.verdict ?? "")}。${esc(challenged.explanation ?? "")}</p>` : ""}`;
}

function searchPreview(d) {
  const rows = d.searchCalls
    .map(
      (c) => `<li class="${c.ok ? "ok" : "fail"}"><span class="q">${c.ok ? "✓" : "✗"} ${esc(c.query)}</span>
        <span class="r">${esc(c.purpose ?? "")} · ${c.ok ? `${c.results} 条结果 · 新增 ${c.newPages} 个网页` : esc(c.error ?? "失败")}</span>
        ${c.at || c.logId ? `<span class="call-id">${c.at ? esc(dateTimeOf(c.at)) : ""}${c.logId ? ` · log_id ${esc(c.logId)}` : ""}</span>` : ""}</li>`,
    )
    .join("");
  return `<div class="crumb">${d.name} / 检索记录</div><h3>${record.mock ? "演示搜索" : "博查搜索"} ${d.searchCalls.length} 次</h3>
    <div class="search-log"><ol>${rows || "<li>无</li>"}</ol></div>`;
}

function rejectedPreview(d) {
  const rows = d.rejectedPages
    .map((p) => `<li><a href="${esc(safeUrl(p.url))}" target="_blank" rel="noopener noreferrer">${esc(p.title)}</a><div class="src-meta">${esc(p.reason)}</div></li>`)
    .join("");
  return `<div class="crumb">${d.name} / 丢弃的网页</div><h3>${d.rejectedPages.length} 个网页未通过核对</h3>
    <p class="hint">这些网页打不开、没有正文、搜索摘要在正文中找不到或出处无法确定，因此没有进入证据库；标着「封存前复核」的是入库后复核未通过、已被删除的证据。</p>
    <ul class="src-list">${rows || "<li>无</li>"}</ul>`;
}

function plansPreview(d) {
  const blocks = d.plans
    .map(({ turn, plan }) => {
      const t = record.turns[turn];
      const head = t ? `第 ${turn + 1} 段 · ${turnLabel(t.kind)}` : `第 ${turn + 1} 段`;
      const points = plan.points
        .map(
          (p) => `<li><b>${esc(p.claim)}</b>${p.responds_to ? `<div class="src-meta">回应：${esc(p.responds_to)}</div>` : ""}
            <ol class="chain">${p.logic_chain.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
            ${p.evidence.map((e) => `<div class="src-meta">〔${esc(e.evidence_id)}〕${esc(e.proves)}</div>`).join("")}</li>`,
        )
        .join("");
      return `<div class="plan"><h4>${head}</h4>
        ${plan.definitions ? `<p><b>概念界定：</b>${esc(plan.definitions)}</p>` : ""}
        ${plan.criterion ? `<p><b>判断标准：</b>${esc(plan.criterion)}</p>` : ""}
        <ul>${points}</ul>
        <p><b>权衡：</b>${esc(plan.weighing)}</p>
        ${plan.challenge ? `<p><b>质疑：</b>〔${esc(plan.challenge.evidence_id)}〕${esc(plan.challenge.reason)}</p>` : ""}</div>`;
    })
    .join("");
  return `<div class="crumb">${d.name} / 构思笔记</div><h3>发言前的私下构思</h3>
    <p class="hint">重要发言前，辩手先想清楚推理链和每条证据证明哪一步，再动笔。比赛中其他人看不到这些构思。</p>${blocks || "<p>无</p>"}`;
}

function select(key, scroll = true) {
  const [kind, id] = key.split(":");
  document.querySelectorAll("#explorer .file-row").forEach((r) => r.classList.toggle("on", r.dataset.key === key));
  const preview = $("#preview");
  if (kind === "ev") preview.innerHTML = evidencePreview(evidenceOf(id));
  else if (kind === "search") preview.innerHTML = searchPreview(debaterOf(id));
  else if (kind === "rejected") preview.innerHTML = rejectedPreview(debaterOf(id));
  else if (kind === "plans") preview.innerHTML = plansPreview(debaterOf(id));
  const row = $(`#explorer .file-row[data-key="${CSS.escape(key)}"]`);
  const tree = $("#explorer .tree");
  if (row && tree) tree.scrollTop = row.offsetTop - tree.clientHeight / 3;
  if (scroll) $("#explorer").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderAfter() {
  const after = $("#after");
  if (record.status === "error") {
    after.innerHTML = `<section class="card"><div class="error-box">辩论中断：${esc(record.error)}</div>
      <button id="resume" class="resume-btn">从断点继续</button>
      <p class="hint resume-hint">已完成的发言原样保留，从中断处接着进行；只有剩下的部分会调用模型。</p></section>`;
  } else {
    after.innerHTML = judgingHtml();
  }
  after.insertAdjacentHTML("beforeend", explorerHtml());
  const first = allEvidence()[0];
  if (first) select(`ev:${first.id}`, false);
}

function renderLog() {
  const open = $("#log-card details")?.open ?? false;
  $("#log-card").innerHTML = `<details ${open ? "open" : ""}><summary><b>运行日志</b>（${record.log.length} 条）</summary>
    <ul class="log">${record.log.map((l) => `<li class="${l.level}"><time>${timeOf(l.time)}</time><span>${esc(l.message)}</span></li>`).join("")}</ul></details>`;
  const log = $("#log-card .log");
  if (log) log.scrollTop = log.scrollHeight;
}

// ---------------- 主渲染与订阅 ----------------

function render() {
  renderHead();
  renderBench();

  const rc = $("#research-card");
  if (rc) rc.outerHTML = researchCard();
  else feed.insertAdjacentHTML("afterbegin", researchCard());

  for (; renderedTurns < record.turns.length; renderedTurns++) appendTurn(record.turns[renderedTurns], !initialRender);
  updateMarks();
  renderActivity();
  if (record.status !== "running" && !afterRendered) {
    afterRendered = true;
    renderAfter();
  }
  renderLog();
  initialRender = false;
  follow();
}

function follow() {
  // 比赛结束后没有新发言可跟随，按钮一并收起
  if (record?.status !== "running") $("#follow").hidden = true;
  if (following && record?.status === "running") window.scrollTo(0, document.documentElement.scrollHeight);
}

window.addEventListener("scroll", () => {
  const nearBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
  following = nearBottom;
  $("#follow").hidden = nearBottom || record?.status !== "running";
});
$("#follow").addEventListener("click", () => {
  following = true;
  $("#follow").hidden = true;
  follow();
});

async function resume(button) {
  button.disabled = true;
  button.textContent = "正在续跑…";
  const res = await fetch(`/api/debates/${encodeURIComponent(debateId)}/resume`, { method: "POST" }).catch(() => null);
  if (!res?.ok) {
    const { error } = (await res?.json().catch(() => null)) ?? {};
    button.disabled = false;
    button.textContent = "从断点继续";
    $(".resume-hint").innerHTML = `<span class="error-text">续跑失败：${esc(error ?? "无法连接服务")}</span>`;
    return;
  }
  afterRendered = false;
  $("#after").innerHTML = "";
  following = true;
  connect();
}

document.addEventListener("click", (event) => {
  const resumeButton = event.target.closest("#resume");
  if (resumeButton) return resume(resumeButton);
  const fn = event.target.closest(".ref.fn[data-ev]");
  if (fn) {
    const item = fn.closest(".turn")?.querySelector(`.src-item[data-ev="${fn.dataset.ev}"]`);
    if (item) {
      item.classList.remove("flash");
      void item.offsetWidth;
      item.classList.add("flash");
      item.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } else if (afterRendered) {
      select(`ev:${fn.dataset.ev}`);
    }
    return;
  }
  const row = event.target.closest("#explorer .file-row");
  if (row) return select(row.dataset.key, false);
  const seat = event.target.closest(".seat.clickable");
  if (seat) {
    const d = debaterOf(seat.dataset.id);
    select(d.bank.length ? `ev:${d.bank[0].id}` : `search:${d.id}`);
  }
});

async function init() {
  if (!debateId) {
    $("#topic").textContent = "缺少辩论编号";
    return;
  }
  appConfig = await fetch("/api/config")
    .then((r) => r.json())
    .catch(() => ({}));
  const syncBenchTop = () =>
    document.documentElement.style.setProperty("--bench-top", `${$(".topbar").offsetHeight}px`);
  window.addEventListener("resize", syncBenchTop);
  syncBenchTop();
  connect();
}

/** 订阅辩论进展；续跑后重新订阅。 */
function connect() {
  const es = new EventSource(`/api/debates/${encodeURIComponent(debateId)}/stream`);
  es.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.version !== 2) {
      // 旧版记录（每方一个辩手）用原来的页面查看
      es.close();
      location.replace(`/#/debate/${debateId}`);
      return;
    }
    record = data;
    render();
    if (record.status !== "running") es.close();
  };
  es.onerror = async () => {
    if (es.readyState === EventSource.CLOSED) return;
    const res = await fetch(`/api/debates/${encodeURIComponent(debateId)}`).catch(() => null);
    if (res?.status === 404) {
      es.close();
      $("#topic").textContent = "辩论不存在";
    }
  };
}

init();
