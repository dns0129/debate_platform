#!/usr/bin/env python3
"""Round bookkeeping for a simulated Public Forum debate.

  round.py init <dir> --resolution "..." [--title "short name"] [--lang zh|en] [--first pro|con] [--judges 1|3|5] [--max-cards 10]
  round.py status <dir>      what is done, what is next
  round.py packet <dir>      write judge_packet.md (public record + every card read in the round)
  round.py tally <dir>       count ballots -> result.json (decision, votes, speaker points, top speaker)
"""

import argparse
import datetime
import json
import random
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import (  # noqa: E402
    LABELS, TEAMS, all_cards, budget, card_refs, die, load_cards, load_round,
    measure, public_text, save_round, seconds, fmt_time, segment_plan, speaker_name,
)

PERSONAS = {
    "zh": {
        "pro1": ("架构师", "先划清战场：定义窄而准，论点之间层层递进；开场给出路线图，用结构本身说服人。避免只有标题没有推理。"),
        "pro2": ("反例猎手", "针对对方推理链最关键的一环集中火力，擅长用反例击穿全称判断；短句、有锋芒，反问后必须紧跟自己的回答。"),
        "con1": ("案例派", "从具体情境切入，再抽象成原则；事实性案例必须来自证据，否则明说是假设推演。用细节代替形容词。"),
        "con2": ("外科医生", "反驳前先公平复述对方推理链，再指出断在哪一步；冷静精确，只在决定胜负的环节动刀。"),
    },
    "en": {
        "pro1": ("The Architect", "Frames the round tightly: narrow definitions, contentions that build on each other, a roadmap up front. Avoids outlines with no reasoning."),
        "pro2": ("The Counterexample Hunter", "Concentrates fire on the one link the opponent's case depends on; breaks universal claims with a single counterexample. Short, sharp sentences; every rhetorical question gets answered."),
        "con1": ("The Storyteller", "Starts from a concrete situation and then states the principle. Factual examples come from cards; anything else is labeled as a hypothetical."),
        "con2": ("The Surgeon", "Restates the opponent's chain fairly before cutting, then names the exact step that fails. Calm and precise; only operates where the ballot is decided."),
    },
}

JUDGES = {
    "zh": [
        ("flow", "技术型评委", "前辩手，逐条记录全场（flow）。只认在总结和焦点总结中延续下来的论点；被对方放过（dropped）的论点视为成立；要求比较性权衡；焦点总结里的新论点不予考虑。"),
        ("lay", "大众评委", "没有辩论经验的社区评委（如学生家长）。看哪一方讲得更清楚、更可信、更贴近常识；不熟悉术语，反感黑话和堆砌数据；凭整体印象判断，但明显的漏洞也看得出来。"),
        ("flay", "教练型评委", "辩论教练，论证与表达并重。会对照证据原文核对转述是否忠实，歪曲证据明显扣分；重视交叉质询中取得的让步是否被带进后续发言。"),
        ("flow2", "技术型评委（二）", "同样按记录判，但更看重权衡：谁把自己的影响和对方的影响放在同一把尺子上比较，谁就赢得这场比较。"),
        ("policy", "政策评委", "研究该领域的学者。看论证在现实中是否可信：因果链是否成立、证据是否支持结论的强度、影响是否被夸大。"),
    ],
    "en": [
        ("flow", "Flow judge", "Former debater who flows the whole round. Only arguments extended through summary and final focus count; dropped arguments are conceded; expects comparative weighing; ignores new arguments in final focus."),
        ("lay", "Lay judge", "Community judge (a parent) with no debate background. Votes for the team that was clearer, more credible and closer to common sense; dislikes jargon, speed and number-dumping; still notices obvious holes."),
        ("flay", "Coach judge", "Debate coach who weighs both argument and delivery. Checks paraphrases against the card text and punishes misrepresented evidence; cares whether crossfire concessions were carried into later speeches."),
        ("flow2", "Flow judge (2)", "Also votes off the flow, but leans heavily on weighing: whoever puts both impacts on the same scale wins the comparison."),
        ("policy", "Policy expert", "Researcher in the resolution's field. Asks whether the causal chains hold up in the real world, whether the evidence supports claims of that strength, and whether impacts are inflated."),
    ],
}

JUDGE_PICK = {1: ["flow"], 3: ["flow", "lay", "flay"], 5: ["flow", "lay", "flay", "flow2", "policy"]}


def cmd_init(args):
    d = Path(args.dir)
    if (d / "round.json").exists() and not args.force:
        die(f"{d}/round.json already exists (use --force to overwrite, or pick a new directory).")
    lang = args.lang or ("zh" if re.search(r"[一-鿿]", args.resolution) else "en")
    toss = random.choice(TEAMS)
    first = args.first or random.choice(TEAMS)
    for sub in ("public", "pro", "con", "ballots"):
        (d / sub).mkdir(parents=True, exist_ok=True)
    speakers = {}
    for sid, (persona, style) in PERSONAS[lang].items():
        speakers[sid] = {"team": sid[:3], "name": speaker_name(lang, sid), "persona": persona, "style": style}
    judges = [
        {"id": jid, "name": name, "style": style}
        for jid, name, style in JUDGES[lang]
        if jid in JUDGE_PICK[args.judges]
    ]
    rnd = {
        "format": "public-forum",
        "resolution": args.resolution.strip(),
        "title": (args.title or "").strip(),
        "lang": lang,
        "date": datetime.date.today().isoformat(),
        "coin_toss": {"winner": toss, "first": first},
        "first": first,
        "max_cards": args.max_cards,
        "sealed": False,
        "speakers": speakers,
        "judges": judges,
        "segments": segment_plan(first, lang),
    }
    save_round(d, rnd)
    lab = LABELS[lang]
    print(f"Round created in {d}  (lang={lang}, first={lab['team'][first]}, judges={len(judges)}, max_cards={args.max_cards}/team)")
    print_plan(d, rnd)


def print_plan(d, rnd):
    lab = LABELS[rnd["lang"]]
    for seg in rnd["segments"]:
        who = " vs ".join(speaker_name(rnd["lang"], s) for s in seg["speakers"])
        b = budget(seg["type"], rnd["lang"])
        done = "✓" if (Path(d) / seg["file"]).exists() else " "
        print(f"  [{done}] {seg['n']:>2}. {lab['type'][seg['type']]:<16} {who:<32} {seg['minutes']} min ~{b['target']} {lab['unit']}  -> {seg['file']}")


def cmd_status(args):
    d = Path(args.dir)
    rnd = load_round(d)
    lab = LABELS[rnd["lang"]]
    print(f"Resolution: {rnd['resolution']}")
    for team in TEAMS:
        cards = load_cards(d, team)
        cons = (d / team / "constructive.md").exists()
        prep = (d / team / "prep.md").exists()
        print(f"  {lab['team'][team]}: {len(cards)} cards, constructive {'ready' if cons else 'missing'}, prep notes {'ready' if prep else 'missing'}")
    print(f"  Evidence sealed: {rnd.get('sealed')}")
    print_plan(d, rnd)
    ballots = sorted((d / "ballots").glob("*.json"))
    print(f"  Ballots: {len(ballots)}/{len(rnd['judges'])}   decision.md: {'yes' if (d / 'decision.md').exists() else 'no'}")
    nxt = next((s for s in rnd["segments"] if not (d / s["file"]).exists()), None)
    if nxt:
        print(f"Next: segment {nxt['n']} ({lab['type'][nxt['type']]})")
    elif len(ballots) < len(rnd["judges"]):
        print("Next: judging")
    elif not (d / "decision.md").exists():
        print("Next: tally + decision.md")
    else:
        print("Next: render")


def cmd_packet(args):
    d = Path(args.dir)
    rnd = load_round(d)
    lang = rnd["lang"]
    lab = LABELS[lang]
    missing = [s["n"] for s in rnd["segments"] if not (d / s["file"]).exists()]
    if missing:
        print(f"warning: segments {missing} are not on the record yet", file=sys.stderr)
    cards = all_cards(d)
    lines = [f"# {rnd['resolution']}", ""]
    for team in TEAMS:
        names = "、".join if lang == "zh" else ", ".join
        members = names(f"{v['name']}" for k, v in rnd["speakers"].items() if v["team"] == team)
        lines.append(f"- {lab['team'][team]}: {members}")
    lines.append(f"- {'先发言' if lang == 'zh' else 'Speaks first'}: {lab['team'][rnd['first']]}")
    lines.append("")
    read = []
    for seg, text in public_text(d, rnd):
        who = " vs ".join(speaker_name(lang, s) for s in seg["speakers"])
        n = measure(text, lang)
        lines += [f"## {seg['n']}. {who} · {lab['type'][seg['type']]}  ({fmt_time(seconds(n, lang))} / {seg['minutes']}:00)", "", text.strip(), ""]
        for cid in card_refs(text):
            if cid not in read:
                read.append(cid)
    lines += ["---", "", "# " + ("本场宣读过的证据原文" if lang == "zh" else "Cards read in the round"), ""]
    for cid in read:
        c = cards.get(cid)
        if not c:
            lines.append(f"- [{cid}] (not found in any card file)")
            continue
        src = ", ".join(x for x in [c.get("author"), c.get("credentials"), c.get("publication"), c.get("date")] if x)
        lines += [f"### [{cid}] {c.get('claim', '')}", f"{src}  <{c['url']}>", "", f"> {c['quote']}", ""]
    (d / "judge_packet.md").write_text("\n".join(lines), encoding="utf-8")
    print(f"wrote {d / 'judge_packet.md'} ({len(read)} cards read)")


def cmd_tally(args):
    d = Path(args.dir)
    rnd = load_round(d)
    ballots = []
    for path in sorted((d / "ballots").glob("*.json")):
        try:
            b = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            die(f"{path}: invalid JSON ({e})")
        if b.get("decision") not in TEAMS:
            die(f"{path}: decision must be 'pro' or 'con'")
        missing = [s for s in rnd["speakers"] if s not in b.get("speakers", {})]
        if missing:
            die(f"{path}: speaker points missing for {missing}")
        for sid, v in b["speakers"].items():
            pts = float(v.get("points", 0))
            if not 20 <= pts <= 30:
                die(f"{path}: {sid} points {pts} outside 20-30")
        ballots.append(b)
    if not ballots:
        die("No ballots in ballots/.")
    votes = {t: sum(1 for b in ballots if b["decision"] == t) for t in TEAMS}
    winner = max(TEAMS, key=lambda t: votes[t])
    if votes["pro"] == votes["con"]:
        die("Tied panel - use an odd number of judges.")
    points = {}
    for sid in rnd["speakers"]:
        vals = [float(b["speakers"][sid]["points"]) for b in ballots]
        points[sid] = round(sum(vals) / len(vals), 2)
    team_points = {t: round(sum(p for s, p in points.items() if s.startswith(t)), 2) for t in TEAMS}
    top = max(points, key=lambda s: points[s])
    low_point = [b.get("judge") for b in ballots
                 if sum(float(v["points"]) for s, v in b["speakers"].items() if s.startswith(b["decision"]))
                 < sum(float(v["points"]) for s, v in b["speakers"].items() if not s.startswith(b["decision"]))]
    result = {
        "winner": winner,
        "votes": votes,
        "unanimous": min(votes.values()) == 0,
        "speaker_points": points,
        "team_points": team_points,
        "top_speaker": top,
        "low_point_wins": low_point,
        "ballots": [b.get("judge") for b in ballots],
    }
    (d / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    i = sub.add_parser("init")
    i.add_argument("dir")
    i.add_argument("--resolution", required=True)
    i.add_argument("--title", help="short page name, 2-6 words, e.g. '四天工作制之辩'")
    i.add_argument("--lang", choices=["zh", "en"])
    i.add_argument("--first", choices=list(TEAMS), help="team that speaks first (default: coin toss)")
    i.add_argument("--judges", type=int, choices=[1, 3, 5], default=3)
    i.add_argument("--max-cards", type=int, default=10)
    i.add_argument("--force", action="store_true")
    for name in ("status", "packet", "tally"):
        sub.add_parser(name).add_argument("dir")
    args = p.parse_args()
    {"init": cmd_init, "status": cmd_status, "packet": cmd_packet, "tally": cmd_tally}[args.cmd](args)


if __name__ == "__main__":
    main()
