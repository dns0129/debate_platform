// 辩论动态演示：按实录顺序回放八位辩手的发言。
// 辩手各自独立：每次发言前只「看得到」公开发言记录和自己的资料；资料在赛后统一公开。

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
const paras = (text) =>
  text
    .split(/\n{2,}/)
    .filter((p) => p.trim())
    .map((p) => `<p>${inline(p)}</p>`)
    .join("");

/** 资料正文的极简 Markdown：标题、列表、段落、加粗。 */
function renderMarkdown(md) {
  const out = [];
  let list = null;
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    const li = line.match(/^[-*]\s+(.+)$/);
    if (li) {
      (list ??= []).push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (list) out.push(`<ul>${list.join("")}</ul>`);
    list = null;
    if (!line) continue;
    const h = line.match(/^#{1,4}\s+(.+)$/);
    out.push(h ? `<h4>${inline(h[1])}</h4>` : `<p>${inline(line)}</p>`);
  }
  if (list) out.push(`<ul>${list.join("")}</ul>`);
  return out.join("");
}

const svg = (body, cls = "icon") =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON = {
  lock: svg('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  unlock: svg('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.6-1.8"/>'),
  folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  file: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
  eye: svg('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
};
// 齿轮：粗虚线圆环当齿，实心圆当轮体，中间挖孔
const GEAR = `<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="16" fill="none" stroke="currentColor" stroke-width="8" stroke-dasharray="5.2 3.18"/><circle cx="24" cy="24" r="12" fill="currentColor"/><circle cx="24" cy="24" r="5" fill="var(--gear-hole)"/></svg>`;

const SIDE = { pro: "正方", con: "反方" };
const THINK_MIN = 5000;
const THINK_MAX = 10000;
const CHARS_PER_SECOND = 100;

let script = null;
const debaterById = new Map();

// ---------------- 播放控制 ----------------

class Cancelled extends Error {}
const player = { run: 0, speed: 1, paused: false, skip: false, instant: false, state: "idle", following: true };
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const guard = (run) => {
  if (run !== player.run) throw new Cancelled();
};

/** 可暂停、可加速、可跳过的等待。 */
async function wait(ms, run) {
  let left = ms;
  let last = performance.now();
  while (left > 0) {
    if (player.instant) return guard(run);
    await tick();
    guard(run);
    const now = performance.now();
    if (player.skip) {
      player.skip = false;
      return;
    }
    if (!player.paused) left -= (now - last) * player.speed;
    last = now;
  }
}

/** 逐字显示发言，末尾带闪烁光标。 */
async function typeInto(el, text, run) {
  if (player.instant || reduceMotion) {
    el.innerHTML = paras(text);
    follow();
    return;
  }
  let shown = 0;
  let last = performance.now();
  while (shown < text.length) {
    await tick();
    guard(run);
    const now = performance.now();
    if (player.skip || player.instant) {
      player.skip = false;
      shown = text.length;
    } else if (!player.paused) {
      shown = Math.min(text.length, shown + ((now - last) / 1000) * CHARS_PER_SECOND * player.speed);
    }
    last = now;
    el.innerHTML = paras(text.slice(0, Math.floor(shown))).replace(/<\/p>$/, '<span class="caret"></span></p>');
    follow();
  }
  el.innerHTML = paras(text);
}

const randomThink = () => THINK_MIN + Math.random() * (THINK_MAX - THINK_MIN);

// ---------------- 自动跟随滚动 ----------------

function follow() {
  if (player.following) window.scrollTo(0, document.documentElement.scrollHeight);
}

window.addEventListener("scroll", () => {
  const nearBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
  player.following = nearBottom;
  $("#follow").hidden = nearBottom || player.state !== "playing";
});

$("#follow").addEventListener("click", () => {
  player.following = true;
  $("#follow").hidden = true;
  follow();
});

// ---------------- 界面：头部、席位、进度 ----------------

const feed = $("#feed");
const nameOf = (id) => debaterById.get(id)?.name ?? id;

function renderHead() {
  document.title = `${script.topic} · 动态演示`;
  $("#topic").textContent = script.topic;
  $("#stance-pro").textContent = script.stances.pro;
  $("#stance-con").textContent = script.stances.con;
  $("#rule").innerHTML = `${ICON.lock}<span>八位辩手各自检索资料，同队四人共享资料，对方的资料看不到。每位辩手发言前能看到公开发言记录和本方资料，看不到对方的资料和任何人的备稿。资料在赛后统一公开。</span>`;
}

const STEPS = () => [...script.phases.map((p) => p.label), "评委点评", "资料公开"];

function setStep(index) {
  $("#stepper").innerHTML = STEPS()
    .map((label, i) => {
      const cls = i < index ? "done" : i === index ? "active" : "";
      return `<div class="step ${cls}">${cls === "done" ? "✓ " : ""}${label}</div>`;
    })
    .join("");
}

function renderBench() {
  for (const side of ["pro", "con"]) {
    $(`#team-${side}`).innerHTML = script.debaters
      .filter((d) => d.side === side)
      .map(
        (d) => `<div class="seat ${side}" data-id="${d.id}" title="${d.name} · 资料 ${d.materials.length} 份（赛后公开）">
          <div class="avatar">${d.short}<span class="seat-gear">${GEAR}</span><span class="seat-crown">★</span></div>
          <div class="seat-name">${d.name.slice(2)}</div>
          <div class="seat-files">${ICON.lock}<span>${d.materials.length}</span></div>
        </div>`,
      )
      .join("");
  }
}

function setSeat(id, state) {
  document.querySelectorAll(".seat").forEach((seat) => {
    const active = seat.dataset.id === id;
    seat.classList.toggle("thinking", active && state === "thinking");
    seat.classList.toggle("speaking", active && state === "speaking");
  });
}

function setNow(html) {
  player.nowHtml = html;
  $("#now").innerHTML = player.paused ? `已暂停 · ${html}` : html;
}

// ---------------- 界面：发言流 ----------------

function append(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html.trim();
  const el = tpl.content.firstElementChild;
  feed.append(el);
  follow();
  return el;
}

function renderIntro() {
  const turns = script.phases.flatMap((p) => p.turns);
  const chars = turns.reduce((n, t) => n + t.text.length, 0);
  const minutes = Math.round((chars / CHARS_PER_SECOND + turns.length * ((THINK_MIN + THINK_MAX) / 2000) + 30) / 60);
  feed.innerHTML = `<section class="card intro-card">
    <p>八位辩手（正反各四人）将按实录顺序依次上场：${script.phases.map((p) => p.label).join(" → ")}，最后由评委点评，并公开各辩手的资料文件夹。</p>
    <ul>
      <li>每次发言前，辩手独立思考 5–10 秒（显示齿轮动画）。</li>
      <li>发言依次叠加：先发言的在上，后发言的在下方动态出现。</li>
      <li>当前内容为占位：发言与点评取自项目中的实录文件，资料取自「${esc(script.folder.name)}」文件夹。</li>
    </ul>
    <div class="stats">
      <span><b>8</b>位辩手</span>
      <span><b>${turns.length}</b>次发言</span>
      <span><b>${script.folder.total}</b>份独立资料</span>
      <span>1× 约 <b>${minutes}</b>分钟</span>
    </div>
  </section>`;
}

/** 该辩手在本环节用到的自己的资料（依据资料文件头部的「使用环节」）。 */
function materialsFor(turn) {
  return (debaterById.get(turn.speaker)?.materials ?? []).filter((m) => m.usedIn.includes(turn.phaseLabel));
}

function turnTag(turn) {
  if (turn.kind === "question") return `质询 · 问${nameOf(turn.target)}`;
  if (turn.kind === "answer") return `答${nameOf(turn.target)}质询`;
  return turn.phaseLabel;
}

function addThinking(turn, publicCount) {
  const d = debaterById.get(turn.speaker);
  const teamFiles = script.debaters.filter((x) => x.side === d.side).reduce((n, x) => n + x.materials.length, 0);
  const short = turn.kind !== "speech" ? "short" : "";
  return append(`<div class="turn ${d.side} ${short} thinking-card enter">
    <div class="gears"><span class="g big">${GEAR}</span><span class="g small">${GEAR}</span></div>
    <div>
      <div class="thinking-who"><b>${d.name}</b> 准备：${esc(turnTag(turn))}</div>
      <div class="thinking-text">思考中<span class="dots"><i>.</i><i>.</i><i>.</i></span></div>
      <div class="visibility">${ICON.eye}可见：公开发言 ${publicCount} 段 · 本方资料 ${teamFiles} 份（对方资料不可见）</div>
    </div>
  </div>`);
}

function speechCard(turn) {
  const d = debaterById.get(turn.speaker);
  const used = materialsFor(turn);
  const short = turn.kind !== "speech" ? "short" : "";
  const badge = turn.kind === "question" ? `<span class="qa-badge">问</span>` : turn.kind === "answer" ? `<span class="qa-badge">答</span>` : "";
  const chip = used.length
    ? `<button class="mat-chip" data-speaker="${d.id}" data-path="${esc(used[0].path)}" title="赛后公开后可查看">${ICON.lock}本人资料 ${used.length} 份</button>`
    : "";
  return `<article class="turn ${d.side} ${short} enter">
    <div class="turn-head">
      ${badge}<span class="avatar ${d.side}">${d.short}</span>
      <span class="turn-name">${d.name}</span>
      <span class="turn-tag">${esc(turnTag(turn))}</span>
      ${chip}
    </div>
    <div class="turn-body"></div>
  </article>`;
}

// ---------------- 主流程 ----------------

async function play(run) {
  player.state = "playing";
  updatePlayButton();
  const turns = script.phases.flatMap((p) => p.turns);
  let spoken = 0;

  for (const [phaseIndex, phase] of script.phases.entries()) {
    setStep(phaseIndex);
    append(`<div class="divider"><span>${esc(phase.label)}</span></div>`);
    await wait(900, run);

    for (const turn of phase.turns) {
      const d = debaterById.get(turn.speaker);
      setSeat(turn.speaker, "thinking");
      setNow(`<b>${d.name}</b> · ${esc(turnTag(turn))} · 思考中（${spoken + 1}/${turns.length}）`);
      const thinking = addThinking(turn, spoken);
      await wait(randomThink(), run);

      setSeat(turn.speaker, "speaking");
      setNow(`<b>${d.name}</b> · ${esc(turnTag(turn))} · 发言中（${spoken + 1}/${turns.length}）`);
      const tpl = document.createElement("template");
      tpl.innerHTML = speechCard(turn).trim();
      const card = tpl.content.firstElementChild;
      thinking.replaceWith(card);
      await typeInto($(".turn-body", card), turn.text, run);
      spoken++;
      setSeat(null);
      await wait(700, run);
    }
  }

  // 评委点评
  setStep(script.phases.length);
  append(`<div class="divider"><span>评委点评</span></div>`);
  setNow("<b>评委组</b> · 评议中");
  const judgeThinking = append(`<div class="turn neutral thinking-card enter">
    <div class="gears"><span class="g big">${GEAR}</span><span class="g small">${GEAR}</span></div>
    <div>
      <div class="thinking-who"><b>评委组</b> 正在评议全场</div>
      <div class="thinking-text">思考中<span class="dots"><i>.</i><i>.</i><i>.</i></span></div>
      <div class="visibility">${ICON.eye}评议依据：全场 ${turns.length} 段公开发言</div>
    </div>
  </div>`);
  await wait(randomThink(), run);
  judgeThinking.remove();
  await revealJudging(run);

  // 资料公开
  setStep(script.phases.length + 1);
  append(`<div class="divider"><span>赛后公开 · 辩手资料</span></div>`);
  setNow("资料文件夹已公开");
  await wait(600, run);
  revealFolder();

  setStep(STEPS().length);
  setNow("演示结束 · 点击文件查看各辩手的资料");
  player.state = "done";
  updatePlayButton();
  $("#follow").hidden = true;
}

// ---------------- 评委点评 ----------------

async function revealJudging(run) {
  const j = script.judging;
  const scores = j.scores;
  const avg = (side) => {
    const list = scores.filter((s) => s.debater.startsWith(side));
    return list.length ? (list.reduce((n, s) => n + s.score, 0) / list.length).toFixed(2) : "–";
  };

  append(`<section class="card verdict-banner ${j.verdict.winner} enter">
    <div class="label">${esc(j.title)}</div>
    <div class="headline">${esc(j.verdict.headline)}</div>
    <p>${inline(j.verdict.body)}</p>
    ${
      scores.length
        ? `<div class="team-scores">
            <div class="pro"><b>${avg("pro")}</b>正方平均分</div>
            <div class="con"><b>${avg("con")}</b>反方平均分</div>
          </div>`
        : ""
    }
  </section>`);
  await wait(1400, run);

  if (j.clashes.length) {
    append(`<div class="section-title enter">胜负关键</div>`);
    for (const c of j.clashes) {
      append(`<section class="card clash ${c.winner ?? ""} enter">
        <div class="clash-head"><b>${esc(c.title)}</b><span class="result-tag ${c.winner ?? ""}">${esc(c.result)}</span></div>
        <p>${inline(c.body)}</p>
      </section>`);
      await wait(1000, run);
    }
  }

  if (scores.length) {
    const col = (side) => `<div class="score-col">
      <h4><span class="side-tag ${side}">${SIDE[side]}</span></h4>
      ${scores
        .filter((s) => s.debater.startsWith(side))
        .map((s) => {
          const d = debaterById.get(s.debater);
          const best = j.best?.debater === s.debater;
          return `<div class="score-row ${best ? "best" : ""}">
            <span class="avatar ${d.side}">${d.short}</span>
            <span class="who">${d.name}${best ? `<span class="best-tag">★ 最佳辩手</span>` : ""}</span>
            <span class="score">${s.score}</span>
            <span class="comment">${inline(s.comment)}</span>
          </div>`;
        })
        .join("")}
    </div>`;
    append(`<div class="section-title enter">辩手评分</div>`);
    append(`<section class="card enter"><div class="score-grid">${col("pro")}${col("con")}</div>
      ${j.best ? `<p style="margin:12px 0 0;font-size:14px"><b>最佳辩手：${nameOf(j.best.debater)}。</b>${inline(j.best.text)}</p>` : ""}
    </section>`);
    if (j.best) document.querySelector(`.seat[data-id="${j.best.debater}"]`)?.classList.add("best");
    await wait(1400, run);
  }

  if (j.phaseComments.length) {
    append(`<div class="section-title enter">各环节点评</div>`);
    append(`<section class="card enter"><ul class="phase-notes">
      ${j.phaseComments.map((c) => `<li><b>${esc(c.phase)}</b>${inline(c.text)}</li>`).join("")}
    </ul></section>`);
    await wait(1000, run);
  }

  if (j.improvements.pro.length || j.improvements.con.length) {
    const list = (side) => `<div>
      <h4><span class="side-tag ${side}">${SIDE[side]}</span></h4>
      <ol>${j.improvements[side].map((i) => `<li><b>${esc(i.title)}。</b>${inline(i.body)}</li>`).join("")}</ol>
    </div>`;
    append(`<div class="section-title enter">双方可改进之处</div>`);
    append(`<section class="card enter"><div class="improve-grid">${list("pro")}${list("con")}</div></section>`);
    await wait(1000, run);
  }
}

// ---------------- 资料文件夹 ----------------

function revealFolder() {
  // 席位与发言卡片上的资料标记解锁
  document.querySelectorAll(".seat").forEach((seat, i) => {
    setTimeout(() => {
      seat.classList.add("unlocked", "clickable");
      $(".seat-files", seat).innerHTML = `${ICON.folder}<span>${debaterById.get(seat.dataset.id).materials.length}</span>`;
    }, i * 80);
  });
  document.querySelectorAll(".mat-chip").forEach((chip) => {
    chip.classList.add("unlocked");
    chip.innerHTML = `${ICON.file}${esc(chip.textContent.trim())}`;
    chip.title = "查看这份资料";
  });

  let i = 0;
  const tree = ["pro", "con"]
    .map((side) => {
      const members = script.debaters.filter((d) => d.side === side);
      const total = members.reduce((n, d) => n + d.materials.length, 0);
      return `<div class="tree-side ${side}">
        <div class="tree-row side-row" style="--i:${i++}">${ICON.folder}<span class="name">${SIDE[side]}</span><span class="count">${total} 份</span></div>
        ${members
          .map(
            (d) => `<div class="tree-row debater-row" style="--i:${i++}">${ICON.folder}<span class="name">${d.name}</span><span class="count">${d.materials.length}</span></div>
            ${d.materials
              .map(
                (m) => `<button class="tree-row file-row" data-path="${esc(m.path)}" title="${esc(m.title)}" style="--i:${i++}">${ICON.file}<span class="name">${esc(m.fileName)}</span></button>`,
              )
              .join("")}`,
          )
          .join("")}
      </div>`;
    })
    .join("");

  const explorer = append(`<section class="card explorer enter" id="explorer">
    <div class="explorer-head">
      <div class="explorer-title">${ICON.folder}<b>${esc(script.folder.name)}</b></div>
      <div class="explorer-sub">${
        script.folder.found !== false
          ? `赛前各辩手独立检索 · 资料互不相通 · 赛后公开 · 共 ${script.folder.total} 份`
          : "未找到该资料文件夹，请把它放回项目文件夹后刷新页面"
      }</div>
      <button id="open-finder">${ICON.folder}在访达中打开</button>
    </div>
    <div class="explorer-body">
      <nav class="tree">${tree}</nav>
      <article class="preview" id="preview"></article>
    </div>
  </section>`);

  $("#open-finder", explorer).addEventListener("click", openInFinder);
  const first = script.debaters.find((d) => d.materials.length)?.materials[0];
  if (first) selectFile(first.path, false);
}

function findMaterial(path) {
  for (const d of script.debaters) {
    const m = d.materials.find((x) => x.path === path);
    if (m) return { debater: d, material: m };
  }
  return null;
}

function selectFile(path, scroll = true) {
  const found = findMaterial(path);
  if (!found) return;
  const { debater: d, material: m } = found;
  document.querySelectorAll(".file-row").forEach((row) => row.classList.toggle("on", row.dataset.path === path));
  // 只滚动文件树本身，把选中的文件移到可视范围
  const tree = $(".tree");
  const row = $(".file-row.on", tree);
  if (row && (row.offsetTop < tree.scrollTop || row.offsetTop + row.offsetHeight > tree.scrollTop + tree.clientHeight)) {
    tree.scrollTop = row.offsetTop - tree.clientHeight / 3;
  }
  $("#preview").innerHTML = `
    <div class="crumb">${esc(script.folder.name)} / ${esc(m.path.split(/[\\/]/).join(" / "))}</div>
    <h3>${esc(m.title)}</h3>
    <div class="meta">
      ${m.type ? `<span class="chip">${esc(m.type)}</span>` : ""}
      <span>所有者：${d.name}</span>
      ${m.usedIn.length ? `<span>· 使用环节：</span>${m.usedIn.map((u) => `<span class="chip ${d.side}">${esc(u)}</span>`).join("")}` : ""}
    </div>
    <div class="md">${renderMarkdown(m.body)}</div>
    ${m.source ? `<div class="source">来源：${esc(m.source)}</div>` : ""}`;
  if (scroll) $("#explorer").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function openInFinder(event) {
  const btn = event.currentTarget;
  const res = await fetch("/api/demo/open-folder", { method: "POST" }).catch(() => null);
  if (!res?.ok) btn.lastChild.textContent = "打开失败（仅支持本机 macOS）";
}

// 资料只在赛后可点：发言卡片上的资料标记、树中的文件、席位
document.addEventListener("click", (event) => {
  const target = event.target.closest(".mat-chip.unlocked, .file-row, .seat.clickable");
  if (!target) return;
  if (target.classList.contains("seat")) {
    const first = debaterById.get(target.dataset.id)?.materials[0];
    if (first) selectFile(first.path);
  } else {
    selectFile(target.dataset.path, !target.classList.contains("file-row"));
  }
});

// ---------------- 按钮 ----------------

function updatePlayButton() {
  const btn = $("#btn-play");
  if (player.state === "idle") btn.textContent = "▶ 开始模拟";
  else if (player.state === "done") btn.textContent = "↻ 再看一遍";
  else btn.textContent = player.paused ? "▶ 继续" : "⏸ 暂停";
}

function start({ instant = false } = {}) {
  const run = ++player.run;
  Object.assign(player, { paused: false, skip: false, instant, following: true });
  feed.innerHTML = "";
  renderBench();
  setStep(-1);
  window.scrollTo(0, 0);
  play(run).catch((err) => {
    if (!(err instanceof Cancelled)) {
      console.error(err);
      setNow(`演示出错：${esc(err.message)}`);
    }
  });
}

$("#btn-play").addEventListener("click", () => {
  if (player.state === "playing") {
    player.paused = !player.paused;
    updatePlayButton();
    setNow(player.nowHtml ?? "");
  } else {
    start();
  }
});
$("#btn-skip").addEventListener("click", () => {
  if (player.state === "playing") player.skip = true;
});
$("#btn-end").addEventListener("click", () => {
  if (player.state === "playing") player.instant = true;
  else start({ instant: true });
  player.paused = false;
});
$("#btn-restart").addEventListener("click", () => start());
$("#speed").addEventListener("click", (event) => {
  const btn = event.target.closest("button[data-speed]");
  if (!btn) return;
  player.speed = Number(btn.dataset.speed);
  document.querySelectorAll("#speed button").forEach((b) => b.classList.toggle("on", b === btn));
});

// ---------------- 启动 ----------------

// 席位栏吸附在顶栏下方：按顶栏实际高度设置偏移（窄屏时顶栏高度会变）
const syncBenchTop = () =>
  document.documentElement.style.setProperty("--bench-top", `${$(".topbar").offsetHeight}px`);
window.addEventListener("resize", syncBenchTop);
syncBenchTop();

function showLoadError(message) {
  $("#topic").textContent = "无法加载演示";
  document.querySelectorAll(".controls button").forEach((b) => (b.disabled = true));
  setNow("演示数据未加载");
  feed.innerHTML = `<section class="card"><div class="error-box">${esc(message)}</div>
    <p class="hint" style="margin:12px 0 0">处理后刷新本页即可。</p></section>`;
}

async function init() {
  let res;
  let data = null;
  try {
    res = await fetch("/api/demo");
    data = await res.json();
  } catch {
    // 连不上服务，或服务返回的不是 JSON（例如仍在运行更新前的旧版本）
  }
  if (!res || !data) {
    showLoadError("无法连接演示接口。请关闭运行平台的终端窗口，再重新双击 start-local.command 启动最新版本。");
    return;
  }
  if (!res.ok) {
    showLoadError(data.error || `演示接口返回错误（${res.status}）`);
    return;
  }
  script = data;
  for (const d of script.debaters) debaterById.set(d.id, d);
  renderHead();
  renderBench();
  setStep(-1);
  renderIntro();
}

init();
