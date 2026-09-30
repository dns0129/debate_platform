#!/usr/bin/env python3
"""Check one segment before it goes on the record.

  check_speech.py <dir> <segment-number> [--file PATH]

--file defaults to the segment's public file; use it for a draft (e.g. pro/constructive.md).
Checks: length against the time limit, every [P3]/[C2] reference exists and is visible to the
speaker, no new cards in final focus or crossfire, crossfire speaker tags, citation density,
and whether each first-read card names its source.
Prints a JSON report; exit code 1 when there are errors (warnings alone exit 0).
"""

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import (  # noqa: E402
    LABELS, all_cards, budget, card_refs, get_segment, load_round, measure, public_text, seconds,
    fmt_time, speaker_name,
)

SPEAKER_TAG = re.compile(r"^\s*\*\*([^*\n]{1,40}?)\s*[:：]\s*\*\*")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("dir")
    p.add_argument("n", type=int)
    p.add_argument("--file")
    args = p.parse_args()

    d = Path(args.dir)
    rnd = load_round(d)
    lang = rnd["lang"]
    lab = LABELS[lang]
    seg = get_segment(rnd, args.n)
    path = Path(args.file) if args.file else d / seg["file"]
    if not path.is_absolute() and not path.exists():
        path = d / path
    if not path.exists():
        print(json.dumps({"ok": False, "errors": [f"file not found: {path}"]}, ensure_ascii=False))
        sys.exit(1)
    text = path.read_text(encoding="utf-8")
    errors, warnings = [], []
    kind = seg["type"]
    crossfire = "crossfire" in kind

    # Length
    n = measure(text, lang)
    b = budget(kind, lang)
    unit = lab["unit"]
    if n > b["max"]:
        errors.append(f"too long: {n} {unit} (~{fmt_time(seconds(n, lang))}) for a {seg['minutes']}-minute {lab['type'][kind]}; "
                      f"cut to at most {b['max']} {unit}. Keep the reasoning, cut repetition and restated evidence.")
    elif n < b["min"]:
        (warnings if crossfire else errors).append(
            f"too short: {n} {unit} (~{fmt_time(seconds(n, lang))}); aim for about {b['target']} {unit} - develop the reasoning, not more quotes.")

    # Evidence visibility
    cards = all_cards(d)
    earlier = public_text(d, rnd, before=seg["n"])
    public_ids = {cid for _, t in earlier for cid in card_refs(t)}
    teams = {s[:3] for s in seg["speakers"]}
    refs = card_refs(text)
    new_own = []
    for cid in refs:
        owner = "pro" if cid.startswith("P") else "con"
        if cid not in cards:
            errors.append(f"[{cid}] does not exist in any card file - never invent a card.")
        elif cid in public_ids:
            continue
        elif owner not in teams:
            errors.append(f"[{cid}] belongs to the other team and has not been read aloud yet - the speaker cannot know it.")
        else:
            new_own.append(cid)
    if new_own and crossfire:
        errors.append(f"new cards {new_own} in crossfire: crossfire may only refer to cards already read in speeches.")
    if new_own and kind == "final_focus":
        errors.append(f"new cards {new_own} in final focus: final focus may not introduce new evidence.")
    if new_own and kind == "summary" and seg["n"] == 8:
        warnings.append(f"new cards {new_own} in the second summary: the first-speaking team can only answer them in final focus; judges may discount them.")

    # First read of a card should name its source before the marker
    for cid in new_own:
        c = cards[cid]
        m = re.search(r"[\[〔【［]\s*" + cid + r"\s*[\]〕】］]", text)
        window = text[max(0, m.start() - 220): m.start()] if m else ""
        names = [x for x in (c.get("author"), c.get("publication")) if x]
        keys = [max(x.split(), key=len).lower() for x in names if x.split()]
        if keys and not any(k in window.lower() for k in keys):
            warnings.append(f"[{cid}] is read for the first time without naming its source ({' / '.join(names)}) - say who said it and when, then the content.")

    # Crossfire format
    if crossfire:
        allowed = {speaker_name(lang, s) for s in seg["speakers"]} | set(seg["speakers"])
        turns = 0
        for line in text.splitlines():
            m = SPEAKER_TAG.match(line)
            if m:
                turns += 1
                if m.group(1).strip() not in allowed:
                    errors.append(f"speaker '{m.group(1)}' is not in this crossfire (allowed: {', '.join(sorted(allowed))}).")
        if turns < 6:
            errors.append(f"only {turns} turns; a 3-minute crossfire has roughly 8-14 short turns, each starting with **Name:**")
    else:
        # Citation density
        sentences = [s for s in re.split(r"(?<=[。！？!?])|(?<=[.;])\s+", text) if measure(s, lang) > 3]
        cited = [s for s in sentences if card_refs(s)]
        if sentences and len(cited) / len(sentences) > 0.45:
            warnings.append(f"{len(cited)}/{len(sentences)} sentences carry a card marker; more than 45% reads as a card dump - add analysis between cards.")

    report = {
        "ok": not errors,
        "segment": f"{seg['n']}. {lab['type'][kind]} ({', '.join(speaker_name(lang, s) for s in seg['speakers'])})",
        "length": f"{n} {unit} ≈ {fmt_time(seconds(n, lang))} (target {b['target']}, allowed {b['min']}-{b['max']})",
        "cards_cited": refs,
        "new_cards": new_own,
        "errors": errors,
        "warnings": warnings,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    sys.exit(0 if not errors else 1)


if __name__ == "__main__":
    main()
