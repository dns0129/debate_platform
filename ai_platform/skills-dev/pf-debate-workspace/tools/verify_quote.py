#!/usr/bin/env python3
"""Grading helper: does QUOTE appear verbatim (ignoring spacing/punctuation/width) on URL?
Usage: verify_quote.py URL "QUOTE"   ->  prints PASS/FAIL/ERROR with reason
       verify_quote.py --round <round dir>   -> checks every card read in the round's public/ files
"""
import sys, tempfile, json, re
from pathlib import Path
sys.path.insert(0, "/Users/yuanzichen/ai辩论模拟平台/skills-dev/pf-debate/scripts")
from cards import fetch_page, quote_on_page
from common import load_round, public_text, card_refs, all_cards

cache = Path(tempfile.mkdtemp())

def check(url, quote):
    try:
        page = fetch_page(url, cache)
    except RuntimeError as e:
        return "ERROR", str(e)
    return ("PASS", "found") if quote_on_page(quote, page["text"]) else ("FAIL", "quote not on page")

if sys.argv[1] == "--round":
    d = Path(sys.argv[2]); rnd = load_round(d); cards = all_cards(d)
    read = []
    for seg, t in public_text(d, rnd):
        for c in card_refs(t):
            if c not in read: read.append(c)
    for cid in read:
        c = cards.get(cid)
        if not c: print(cid, "MISSING"); continue
        st, why = check(c["url"], c["quote"])
        print(cid, st, why, c["url"])
else:
    st, why = check(sys.argv[1], sys.argv[2]); print(st, why)
