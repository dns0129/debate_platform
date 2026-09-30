#!/usr/bin/env python3
"""Render the finished round as one self-contained web page.

  render.py <dir> [--out debate.html] [--standalone]

Reads round.json, public/*.md, pro|con/cards.json, ballots/*.json, result.json, decision.md.
Without --standalone the page is a body fragment ready for an artifact host that wraps it in its own
<!doctype>/<head>; with --standalone it is a complete HTML document for opening from disk.
"""

import argparse
import html
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import (  # noqa: E402
    CARD_REF, LABELS, TEAMS, all_cards, budget, card_refs, fmt_time, load_round, measure, seconds, speaker_name,
)

UI = {
    "zh": {
        "format": "公共论坛赛制", "vs": "对", "first": "先发言", "coin": "掷币", "judges": "评委",
        "wins": "胜", "top": "最佳辩手", "rundown": "赛程", "decision": "裁决", "ballots": "评委判决书",
        "points": "辩手得分", "avg": "平均", "evidence": "证据", "first_read": "首次宣读于第 {n} 段",
        "unused": "未在场上宣读", "verified_script": "脚本打开原网页逐字核对", "verified_tool": "工具核对原文",
        "source_warn": "出处名称未在网页中出现", "clashes": "关键交锋", "rfd": "判决理由", "even": "持平",
        "no_decision": "尚未裁决", "speaker": "辩手", "cards_read": "本段首次宣读的证据", "votes": "票",
        "low_point": "低分胜", "persona": "风格", "open": "打开原文",
    },
    "en": {
        "format": "Public Forum", "vs": "vs", "first": "speaks first", "coin": "Coin toss", "judges": "Judges",
        "wins": "wins", "top": "Top speaker", "rundown": "Rundown", "decision": "Decision", "ballots": "Ballots",
        "points": "Speaker points", "avg": "Avg", "evidence": "Evidence", "first_read": "First read in segment {n}",
        "unused": "Never read in the round", "verified_script": "Quote checked verbatim on the live page",
        "verified_tool": "Quote checked with a web tool", "source_warn": "Source name not found on the page",
        "clashes": "Key clashes", "rfd": "Reason for decision", "even": "Even", "no_decision": "Not judged yet",
        "speaker": "Speaker", "cards_read": "Cards first read here", "votes": "", "low_point": "low-point win",
        "persona": "Style", "open": "Open source",
    },
}

SPEAKER_TAG = re.compile(r"^\s*\*\*([^*\n]{1,40}?)\s*[:：]\s*\*\*\s*(.*)$")


# ---------------------------------------------------------------- markdown

def inline(text: str, ctx) -> str:
    out = html.escape(text, quote=False)

    def ref(m):
        cid = m.group(1)
        team = "pro" if cid.startswith("P") else "con"
        return f'<a class="ref {team}" href="#card-{cid}">{cid}</a>'

    out = CARD_REF.sub(ref, out)
    out = re.sub(r"\[([^\]]+)\]\((https?://[^)\s]+)\)", r'<a href="\2" target="_blank" rel="noopener">\1</a>', out)
    out = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", out)
    out = re.sub(r"(?<![*\w])\*(?!\s)(.+?)(?<!\s)\*(?![*\w])", r"<em>\1</em>", out)
    out = re.sub(r"`([^`]+)`", r"<code>\1</code>", out)
    return out


def markdown(text: str, ctx=None, shift: int = 0) -> str:
    lines = text.strip().splitlines()
    out, i = [], 0
    while i < len(lines):
        ln = lines[i]
        s = ln.strip()
        if not s:
            i += 1
            continue
        if s.startswith("|") and i + 1 < len(lines) and re.match(r"^\s*\|?\s*:?-{2,}", lines[i + 1]):
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")])
                i += 1
            head, body = rows[0], rows[2:]
            t = ['<div class="table-wrap"><table><thead><tr>']
            t += [f"<th>{inline(c, ctx)}</th>" for c in head]
            t.append("</tr></thead><tbody>")
            for r in body:
                t.append("<tr>" + "".join(f"<td>{inline(c, ctx)}</td>" for c in r) + "</tr>")
            t.append("</tbody></table></div>")
            out.append("".join(t))
            continue
        m = re.match(r"^(#{1,6})\s+(.*)", s)
        if m:
            level = min(6, len(m.group(1)) + shift)
            out.append(f"<h{level}>{inline(m.group(2), ctx)}</h{level}>")
            i += 1
            continue
        if s.startswith(">"):
            buf = []
            while i < len(lines) and lines[i].strip().startswith(">"):
                buf.append(lines[i].strip()[1:].strip())
                i += 1
            out.append(f"<blockquote>{markdown(chr(10).join(buf), ctx, shift)}</blockquote>")
            continue
        if re.match(r"^([-*+]|\d+[.、)])\s+", s):
            ordered = bool(re.match(r"^\d", s))
            tag = "ol" if ordered else "ul"
            items = []
            while i < len(lines) and re.match(r"^\s*([-*+]|\d+[.、)])\s+", lines[i]):
                item = re.sub(r"^\s*([-*+]|\d+[.、)])\s+", "", lines[i])
                i += 1
                while i < len(lines) and lines[i].strip() and not re.match(r"^\s*([-*+]|\d+[.、)])\s+|^\s*#", lines[i]) and lines[i].startswith("  "):
                    item += " " + lines[i].strip()
                    i += 1
                items.append(f"<li>{inline(item, ctx)}</li>")
            out.append(f"<{tag}>{''.join(items)}</{tag}>")
            continue
        if re.match(r"^(-{3,}|\*{3,})$", s):
            out.append("<hr>")
            i += 1
            continue
        buf = [s]
        i += 1
        while i < len(lines) and lines[i].strip() and not re.match(r"^(#{1,6}\s|>|[-*+]\s|\d+[.、)]\s|\|)", lines[i].strip()):
            buf.append(lines[i].strip())
            i += 1
        joiner = "" if re.search(r"[一-鿿]$", buf[0]) else " "
        out.append(f"<p>{inline(joiner.join(buf), ctx)}</p>")
    return "\n".join(out)


# ---------------------------------------------------------------- pieces

def esc(x) -> str:
    return html.escape(str(x or ""))


def source_line(c: dict) -> str:
    parts = [c.get("author"), c.get("credentials"), c.get("publication"), c.get("date")]
    seen, out = set(), []
    for p in parts:
        if p and p not in seen:
            out.append(p)
            seen.add(p)
    return " · ".join(esc(p) for p in out)


def speaker_map(rnd):
    m = {}
    for sid, sp in rnd["speakers"].items():
        m[sp["name"]] = sid
        m[sid] = sid
        m[sp["name"].replace(" ", "")] = sid
    return m


def render_crossfire(text, rnd, lang):
    smap = speaker_map(rnd)
    turns, cur = [], None
    for ln in text.splitlines():
        m = SPEAKER_TAG.match(ln)
        if m:
            name = m.group(1).strip()
            cur = {"sid": smap.get(name) or smap.get(name.replace(" ", "")), "name": name, "text": [m.group(2)]}
            turns.append(cur)
        elif cur and ln.strip():
            cur["text"].append(ln.strip())
        elif ln.strip():
            turns.append({"sid": None, "name": "", "text": [ln.strip()]})
            cur = turns[-1]
    rows = []
    for t in turns:
        team = t["sid"][:3] if t["sid"] else "neutral"
        body = markdown("\n".join(x for x in t["text"] if x), shift=3)
        who = esc(rnd["speakers"][t["sid"]]["name"]) if t["sid"] else esc(t["name"])
        rows.append(f'<div class="turn {team}"><div class="who">{who}</div><div class="bubble">{body}</div></div>')
    return '<div class="exchange">' + "".join(rows) + "</div>"


def render_segment(seg, text, rnd, cards, first_read, lang):
    lab, ui = LABELS[lang], UI[lang]
    n = measure(text, lang)
    b = budget(seg["type"], lang)
    over = n > b["max"]
    clock = f'<span class="clock{" over" if over else ""}">{fmt_time(seconds(n, lang))} / {seg["minutes"]}:00</span>'
    kind = lab["type"][seg["type"]]
    if "crossfire" in seg["type"]:
        names = " × ".join(esc(rnd["speakers"][s]["name"]) for s in seg["speakers"])
        return (f'<section class="segment crossfire" id="seg-{seg["n"]}">'
                f'<header class="seg-head"><span class="seg-n">{seg["n"]:02d}</span><h2>{esc(kind)}</h2>'
                f'<span class="seg-who">{names}</span>{clock}</header>'
                f'{render_crossfire(text, rnd, lang)}</section>')
    sid = seg["speakers"][0]
    sp = rnd["speakers"][sid]
    team = sp["team"]
    new_cards = [cid for cid in card_refs(text) if first_read.get(cid) == seg["n"] and cid in cards]
    cites = ""
    if new_cards:
        items = []
        for cid in new_cards:
            c = cards[cid]
            items.append(f'<li><a class="ref {c["team"]}" href="#card-{cid}">{cid}</a> '
                         f'<span class="cite-src">{source_line(c)}</span></li>')
        cites = f'<footer class="cites"><h3>{ui["cards_read"]}</h3><ul>{"".join(items)}</ul></footer>'
    return (f'<section class="segment speech {team}" id="seg-{seg["n"]}">'
            f'<header class="seg-head"><span class="seg-n">{seg["n"]:02d}</span><h2>{esc(sp["name"])} · {esc(kind)}</h2>'
            f'<span class="persona">{esc(sp.get("persona", ""))}</span>{clock}</header>'
            f'<div class="prose">{markdown(text, shift=2)}</div>{cites}</section>')


def render_ballot(b, rnd, lang):
    ui, lab = UI[lang], LABELS[lang]
    dec = b.get("decision")
    clashes = ""
    if b.get("key_clashes"):
        items = []
        for c in b["key_clashes"]:
            w = c.get("winner")
            chip = f'<span class="chip {w}">{lab["team"].get(w, ui["even"])}</span>'
            items.append(f'<li><div class="clash-title">{chip}<strong>{esc(c.get("title"))}</strong></div>'
                         f'<div class="clash-body">{markdown(c.get("analysis", ""), shift=4)}</div></li>')
        clashes = f'<h4>{ui["clashes"]}</h4><ol class="clashes">{"".join(items)}</ol>'
    judge = next((j for j in rnd["judges"] if j["id"] == b.get("judge")), {"name": b.get("judge_name") or b.get("judge"), "style": ""})
    notes = ""
    if b.get("evidence_notes"):
        notes = f'<div class="ev-notes">{markdown(b["evidence_notes"], shift=4)}</div>'
    return (f'<article class="ballot"><header><div><h3>{esc(judge["name"])}</h3><p class="judge-style">{esc(judge.get("style"))}</p></div>'
            f'<span class="chip big {dec}">{lab["team"].get(dec, "?")}</span></header>'
            f'<h4>{ui["rfd"]}</h4><div class="prose small">{markdown(b.get("rfd", ""), shift=4)}</div>{clashes}{notes}</article>')


def render_points(ballots, result, rnd, lang):
    ui = UI[lang]
    judges = [b.get("judge") for b in ballots]
    names = {j["id"]: j["name"] for j in rnd["judges"]}
    head = f'<th>{ui["speaker"]}</th>' + "".join(f"<th>{esc(names.get(j, j))}</th>" for j in judges) + f'<th>{ui["avg"]}</th>'
    rows = []
    order = [s for t in TEAMS for s in rnd["speakers"] if s.startswith(t)]
    for sid in order:
        sp = rnd["speakers"][sid]
        top = result and result.get("top_speaker") == sid
        cells = "".join(f'<td class="num">{float(b["speakers"][sid]["points"]):.1f}</td>' for b in ballots)
        avg = f'{result["speaker_points"][sid]:.2f}' if result else ""
        rows.append(f'<tr class="{"top" if top else ""}"><th scope="row"><span class="dot {sp["team"]}"></span>{esc(sp["name"])}</th>{cells}<td class="num strong">{avg}</td></tr>')
    comments = []
    for sid in order:
        sp = rnd["speakers"][sid]
        lines = [f'<li><strong>{esc(names.get(b.get("judge"), b.get("judge")))}</strong>：{inline(b["speakers"][sid].get("comment", ""), None)}</li>'
                 for b in ballots if b["speakers"][sid].get("comment")]
        if lines:
            comments.append(f'<details class="speaker-notes"><summary><span class="dot {sp["team"]}"></span>{esc(sp["name"])}</summary><ul>{"".join(lines)}</ul></details>')
    return (f'<div class="table-wrap"><table class="points"><thead><tr>{head}</tr></thead><tbody>{"".join(rows)}</tbody></table></div>'
            + "".join(comments))


def render_card(c, first_read, lang):
    ui = UI[lang]
    n = first_read.get(c["id"])
    status = (f'<a class="chip used" href="#seg-{n}">{ui["first_read"].format(n=n)}</a>' if n
              else f'<span class="chip muted">{ui["unused"]}</span>')
    check = ui["verified_script"] if c.get("verified_by", "script") == "script" else ui["verified_tool"]
    warn = f'<span class="chip warn">{ui["source_warn"]}</span>' if c.get("source_on_page") is False else ""
    return (f'<article class="card {c["team"]}{"" if n else " unused"}" id="card-{c["id"]}">'
            f'<header><span class="card-id">{c["id"]}</span><p class="claim">{esc(c.get("claim"))}</p></header>'
            f'<p class="src">{source_line(c)}</p>'
            f'<blockquote>{esc(c["quote"])}</blockquote>'
            f'<footer><a href="{esc(c["url"])}" target="_blank" rel="noopener">{esc(c.get("domain") or c["url"])} ↗</a>'
            f'<span class="chip ok">✓ {check}</span>{warn}{status}</footer></article>')


# ---------------------------------------------------------------- page

def build(d: Path, standalone: bool) -> str:
    rnd = load_round(d)
    lang = rnd["lang"]
    lab, ui = LABELS[lang], UI[lang]
    cards = all_cards(d)
    segs = []
    first_read = {}
    for seg in rnd["segments"]:
        p = d / seg["file"]
        if p.exists():
            text = p.read_text(encoding="utf-8")
            segs.append((seg, text))
            for cid in card_refs(text):
                first_read.setdefault(cid, seg["n"])
    ballots = []
    for p in sorted((d / "ballots").glob("*.json")):
        ballots.append(json.loads(p.read_text(encoding="utf-8")))
    order = {j["id"]: i for i, j in enumerate(rnd["judges"])}
    ballots.sort(key=lambda b: order.get(b.get("judge"), 99))
    result = json.loads((d / "result.json").read_text(encoding="utf-8")) if (d / "result.json").exists() else None
    decision_md = (d / "decision.md").read_text(encoding="utf-8") if (d / "decision.md").exists() else ""

    # Masthead
    bench = []
    for team in TEAMS:
        members = "".join(
            f'<li><span class="name">{esc(sp["name"])}</span><span class="persona" title="{esc(sp.get("style"))}">{esc(sp.get("persona"))}</span></li>'
            for sid, sp in rnd["speakers"].items() if sp["team"] == team)
        first = f'<span class="chip {team}">{ui["first"]}</span>' if rnd["first"] == team else ""
        bench.append(f'<div class="team {team}"><div class="team-name">{lab["team"][team]}{first}</div><ul>{members}</ul></div>')
    if result:
        w = result["winner"]
        v = result["votes"]
        score = f'{v[w]}–{v["con" if w == "pro" else "pro"]}'
        top = rnd["speakers"][result["top_speaker"]]["name"]
        verdict = (f'<div class="verdict {w}"><span class="verdict-main">{lab["team"][w]}{ui["wins"] if lang == "zh" else " " + ui["wins"]}</span>'
                   f'<span class="verdict-score">{score}</span>'
                   f'<span class="verdict-top">{ui["top"]}：{esc(top)} · {result["speaker_points"][result["top_speaker"]]:.2f}</span></div>')
    else:
        verdict = f'<div class="verdict pending">{ui["no_decision"]}</div>'
    masthead = (f'<header class="masthead"><p class="eyebrow">{ui["format"]} · {esc(rnd.get("date"))} · {len(rnd["judges"])} {ui["judges"]}</p>'
                f'<h1>{esc(rnd["resolution"])}</h1>'
                f'<div class="bench">{bench[0]}<div class="vs">{ui["vs"]}</div>{bench[1]}</div>{verdict}</header>')

    # Rundown nav
    chips = []
    for seg in rnd["segments"]:
        done = any(s["n"] == seg["n"] for s, _ in segs)
        team = seg.get("team", "both")
        chips.append(f'<a class="rd {team}{"" if done else " missing"}" href="#seg-{seg["n"]}"><span>{seg["n"]:02d}</span>{lab["type"][seg["type"]]}</a>')
    chips.append(f'<a class="rd both" href="#decision">{ui["decision"]}</a>')
    chips.append(f'<a class="rd both" href="#evidence">{ui["evidence"]}</a>')
    nav = f'<nav class="rundown" aria-label="{ui["rundown"]}">{"".join(chips)}</nav>'

    transcript = "".join(render_segment(seg, text, rnd, cards, first_read, lang) for seg, text in segs)

    decision = ""
    if ballots or decision_md:
        decision = (f'<section class="decision" id="decision"><h2 class="section-title">{ui["decision"]}</h2>'
                    + (f'<div class="prose decision-text">{markdown(decision_md, shift=1)}</div>' if decision_md else "")
                    + (f'<h3 class="sub-title">{ui["points"]}</h3>{render_points(ballots, result, rnd, lang)}' if ballots else "")
                    + (f'<h3 class="sub-title">{ui["ballots"]}</h3><div class="ballots">{"".join(render_ballot(b, rnd, lang) for b in ballots)}</div>' if ballots else "")
                    + "</section>")

    ev_cols = []
    for team in TEAMS:
        tc = [c for c in cards.values() if c["team"] == team]
        tc.sort(key=lambda c: (first_read.get(c["id"]) is None, first_read.get(c["id"]) or 0, int(c["id"][1:])))
        ev_cols.append(f'<div class="ev-col"><h3 class="sub-title"><span class="dot {team}"></span>{lab["team"][team]} · {len(tc)}</h3>'
                       + "".join(render_card(c, first_read, lang) for c in tc) + "</div>")
    evidence = f'<section class="evidence" id="evidence"><h2 class="section-title">{ui["evidence"]}</h2><div class="ev-grid">{"".join(ev_cols)}</div></section>'

    title = rnd.get("title") or (rnd["resolution"][:22] + ("…" if len(rnd["resolution"]) > 22 else ""))
    body = f'<div class="page">{masthead}{nav}<main class="transcript">{transcript}</main>{decision}{evidence}</div>'
    template = (Path(__file__).parent.parent / "assets" / "template.html").read_text(encoding="utf-8")
    page = template.replace("{{TITLE}}", esc(title)).replace("{{BODY}}", body).replace("{{LANG}}", "zh-CN" if lang == "zh" else "en")
    if standalone:
        page = f'<!doctype html>\n<html lang="{"zh-CN" if lang == "zh" else "en"}">\n<head>\n{page.split("<!--BODY-->")[0]}</head>\n<body>\n{page.split("<!--BODY-->")[1]}</body>\n</html>\n'
    return page


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("dir")
    p.add_argument("--out")
    p.add_argument("--standalone", action="store_true")
    args = p.parse_args()
    d = Path(args.dir)
    out = Path(args.out) if args.out else d / ("debate_standalone.html" if args.standalone else "debate.html")
    out.write_text(build(d, args.standalone), encoding="utf-8")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
