"""Shared helpers for the pf-debate scripts: round layout, labels, text measurement."""

import json
import re
import sys
import unicodedata
from pathlib import Path

TEAMS = ("pro", "con")

# Speech lengths in minutes (NSDA Public Forum)
MINUTES = {
    "constructive": 4,
    "crossfire": 3,
    "rebuttal": 4,
    "summary": 3,
    "grand_crossfire": 3,
    "final_focus": 2,
}

# Speaking rate used to turn text length into speaking time
RATE = {"zh": 240, "en": 160}  # zh: characters per minute, en: words per minute

LABELS = {
    "zh": {
        "team": {"pro": "正方", "con": "反方"},
        "seat": {"1": "一辩", "2": "二辩"},
        "type": {
            "constructive": "立论",
            "crossfire": "交叉质询",
            "rebuttal": "反驳",
            "summary": "总结",
            "grand_crossfire": "全场交叉质询",
            "final_focus": "焦点总结",
        },
        "unit": "字",
    },
    "en": {
        "team": {"pro": "Pro", "con": "Con"},
        "seat": {"1": "1", "2": "2"},
        "type": {
            "constructive": "Constructive",
            "crossfire": "Crossfire",
            "rebuttal": "Rebuttal",
            "summary": "Summary",
            "grand_crossfire": "Grand Crossfire",
            "final_focus": "Final Focus",
        },
        "unit": "words",
    },
}

CARD_REF = re.compile(r"[\[〔【［]\s*([PC]\d{1,3})\s*[\]〕】］](?!\()")


def die(msg: str, code: int = 1):
    print(msg, file=sys.stderr)
    sys.exit(code)


def load_round(debate_dir) -> dict:
    path = Path(debate_dir) / "round.json"
    if not path.exists():
        die(f"No round.json in {debate_dir}. Run round.py init first.")
    return json.loads(path.read_text(encoding="utf-8"))


def save_round(debate_dir, data: dict):
    path = Path(debate_dir) / "round.json"
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def load_cards(debate_dir, team: str) -> list:
    path = Path(debate_dir) / team / "cards.json"
    if not path.exists():
        return []
    return json.loads(path.read_text(encoding="utf-8"))


def all_cards(debate_dir) -> dict:
    return {c["id"]: c for team in TEAMS for c in load_cards(debate_dir, team)}


def speaker_name(lang: str, sid: str) -> str:
    lab = LABELS[lang]
    return f"{lab['team'][sid[:3]]}{lab['seat'][sid[3]]}" if lang == "zh" else f"{lab['team'][sid[:3]]} {sid[3]}"


def segment_plan(first: str, lang: str) -> list:
    """The 11 segments of a PF round, in order. `first` is the team that speaks first."""
    a, b = first, ("con" if first == "pro" else "pro")
    raw = [
        ("constructive", [f"{a}1"]),
        ("constructive", [f"{b}1"]),
        ("crossfire", [f"{a}1", f"{b}1"]),
        ("rebuttal", [f"{a}2"]),
        ("rebuttal", [f"{b}2"]),
        ("crossfire", [f"{a}2", f"{b}2"]),
        ("summary", [f"{a}1"]),
        ("summary", [f"{b}1"]),
        ("grand_crossfire", [f"{a}1", f"{a}2", f"{b}1", f"{b}2"]),
        ("final_focus", [f"{a}2"]),
        ("final_focus", [f"{b}2"]),
    ]
    plan = []
    for i, (kind, speakers) in enumerate(raw, start=1):
        seg = {"n": i, "type": kind, "speakers": speakers, "minutes": MINUTES[kind]}
        if "crossfire" in kind:
            seg["file"] = f"public/{i:02d}_{kind}.md"
        else:
            team = speakers[0][:3]
            seg["team"] = team
            seg["file"] = f"public/{i:02d}_{kind}_{team}.md"
        plan.append(seg)
    return plan


def get_segment(rnd: dict, n: int) -> dict:
    for seg in rnd["segments"]:
        if seg["n"] == n:
            return seg
    die(f"No segment {n}; valid: 1-{len(rnd['segments'])}")


def strip_markup(text: str) -> str:
    text = CARD_REF.sub("", text)
    text = re.sub(r"\*\*[^*\n]{1,40}?[:：]\*\*", "", text)  # crossfire speaker tags
    text = re.sub(r"[#>*_`|]", "", text)
    return text


def measure(text: str, lang: str) -> int:
    """Spoken length: characters for Chinese (a Latin word or number counts as one), words for English."""
    text = strip_markup(text)
    if lang == "zh":
        cjk = len(re.findall(r"[㐀-鿿豈-﫿]", text))
        latin = len(re.findall(r"[A-Za-z0-9][A-Za-z0-9.'’%-]*", text))
        return cjk + latin
    return len(re.findall(r"[A-Za-z0-9][A-Za-z0-9'’%.-]*", text))


def budget(kind: str, lang: str) -> dict:
    target = MINUTES[kind] * RATE[lang]
    low = 0.6 if "crossfire" in kind else 0.75
    return {"target": target, "min": round(target * low), "max": round(target * 1.08)}


def seconds(length: int, lang: str) -> int:
    return round(length / RATE[lang] * 60)


def fmt_time(sec: int) -> str:
    return f"{sec // 60}:{sec % 60:02d}"


def normalize(text: str) -> str:
    """For verbatim matching: NFKC, casefold, keep only letters and digits."""
    text = unicodedata.normalize("NFKC", text).casefold()
    return "".join(ch for ch in text if unicodedata.category(ch)[0] in "LN")


def card_refs(text: str) -> list:
    """Card IDs in order of first appearance."""
    seen = []
    for m in CARD_REF.finditer(text):
        if m.group(1) not in seen:
            seen.append(m.group(1))
    return seen


def public_text(debate_dir, rnd: dict, before: int | None = None) -> list:
    """(segment, text) for segments already on the record, optionally only those before segment `before`."""
    out = []
    for seg in rnd["segments"]:
        if before is not None and seg["n"] >= before:
            break
        path = Path(debate_dir) / seg["file"]
        if path.exists():
            out.append((seg, path.read_text(encoding="utf-8")))
    return out
