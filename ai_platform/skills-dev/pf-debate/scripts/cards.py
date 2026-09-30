#!/usr/bin/env python3
"""Evidence cards: every card is checked against the live source page before it enters a team's file.

  cards.py fetch <dir> <team> <url> [--grep WORD ...] [--full]
      Open the page and print its metadata and text (or only the passages around WORDs).
      Copy quotes from this output: it is exactly the text `add` checks against.

  cards.py add <dir> <team> --url U --quote Q --claim C --author A --publication P --date D [--credentials X]
      Re-open the page, confirm the quote appears verbatim (spacing, punctuation and full/half-width are
      ignored; "..." or "…" may join fragments that appear in order), then append the card as P<n>/C<n>.

  cards.py list <dir> <team>          one line per card
  cards.py seal <dir>                 close research; `add` refuses afterwards
"""

import argparse
import datetime
import gzip
import hashlib
import http.client
import json
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import zlib
from html import unescape
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).parent))
from common import TEAMS, die, load_cards, load_round, normalize, save_round  # noqa: E402

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"

# Sources a debater should not cite: reposts, self-media, content farms, login/paywalled document stores.
BLOCKED = [
    "toutiao.com", "sohu.com", "163.com", "qq.com", "sina.com.cn", "sina.cn", "ifeng.com", "baijiahao.baidu.com",
    "zhihu.com", "csdn.net", "douban.com", "360doc.com", "docin.com", "doc88.com", "book118.com", "renrendoc.com",
    "wenku.baidu.com", "baogaobox.com", "waitang.com", "cnki.net", "wanfangdata.com.cn", "researchgate.net",
    "quora.com", "reddit.com", "medium.com", "scribd.com", "coursehero.com", "studocu.com", "answers.com",
]

SKIP_TAGS = {"script", "style", "noscript", "svg", "template", "iframe", "head", "nav", "footer"}
BLOCK_TAGS = {"p", "div", "br", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "section", "article", "blockquote", "td", "th", "dd", "dt", "figcaption", "pre"}


class TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.skip, self.meta, self.title, self._in_title = [], 0, {}, "", False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "meta":
            key = (a.get("property") or a.get("name") or "").lower()
            if key in {"og:site_name", "author", "article:author", "article:published_time", "og:title",
                       "citation_author", "citation_publication_date", "citation_date", "citation_journal_title",
                       "dc.date", "dc.creator", "date", "pubdate", "publishdate"} and a.get("content"):
                self.meta.setdefault(key, a["content"].strip())
        if tag == "title":
            self._in_title = True
        if tag in SKIP_TAGS and tag != "head":
            self.skip += 1
        if tag in BLOCK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        if tag in SKIP_TAGS and tag != "head" and self.skip:
            self.skip -= 1
        if tag in BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif not self.skip:
            self.parts.append(data)

    def text(self):
        raw = unescape("".join(self.parts))
        lines = [re.sub(r"[ \t 　]+", " ", ln).strip() for ln in raw.splitlines()]
        return "\n".join(ln for ln in lines if ln)


def decode(body: bytes, content_type: str) -> str:
    m = re.search(r"charset=([\w-]+)", content_type or "", re.I) or re.search(rb"<meta[^>]+charset=[\"']?([\w-]+)", body[:4096], re.I)
    candidates = []
    if m:
        cs = m.group(1)
        candidates.append(cs.decode() if isinstance(cs, bytes) else cs)
    candidates += ["utf-8", "gb18030"]
    for cs in candidates:
        try:
            return body.decode("gb18030" if cs.lower() in {"gb2312", "gbk"} else cs)
        except (LookupError, UnicodeDecodeError):
            continue
    return body.decode("utf-8", errors="replace")


def pdf_text(body: bytes) -> str:
    exe = shutil.which("pdftotext")
    if not exe:
        raise RuntimeError("PDF source, and pdftotext is not installed. Find an HTML version of this source instead.")
    with tempfile.NamedTemporaryFile(suffix=".pdf") as f:
        f.write(body)
        f.flush()
        out = subprocess.run([exe, "-layout", f.name, "-"], capture_output=True, timeout=60)
    return out.stdout.decode("utf-8", errors="replace")


def fetch_page(url: str, cache_dir: Path) -> dict:
    """Fetch and extract a page; cached per team so `fetch` and `add` see the same text."""
    host = urlparse(url).netloc.lower()
    if any(host == b or host.endswith("." + b) for b in BLOCKED):
        raise RuntimeError(f"{host} is a repost/self-media/login-walled source. Find the original publisher instead.")
    cache_dir.mkdir(parents=True, exist_ok=True)
    key = cache_dir / (hashlib.sha1(url.encode()).hexdigest()[:16] + ".json")
    if key.exists():
        return json.loads(key.read_text(encoding="utf-8"))
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate",
    })
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            try:
                body = resp.read(8_000_000)
            except http.client.IncompleteRead as e:  # servers that cut chunked bodies short
                body = e.partial
            ctype = resp.headers.get("Content-Type", "")
            enc = (resp.headers.get("Content-Encoding") or "").lower()
            final_url = resp.geturl()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code} - the page refuses automated access or does not exist. Try another source.")
    except (urllib.error.URLError, TimeoutError, OSError, http.client.HTTPException) as e:
        (cache_dir / "network_failed").write_text(url, encoding="utf-8")
        raise RuntimeError(f"NETWORK: could not reach the page ({e}).")
    if enc == "gzip":
        body = gzip.decompress(body)
    elif enc == "deflate":
        body = zlib.decompress(body)
    if "pdf" in ctype.lower() or body[:5] == b"%PDF-":
        page = {"url": final_url, "title": "", "meta": {}, "text": pdf_text(body), "kind": "pdf"}
    else:
        parser = TextExtractor()
        parser.feed(decode(body, ctype))
        page = {"url": final_url, "title": parser.title.strip(), "meta": parser.meta, "text": parser.text(), "kind": "html"}
    if len(normalize(page["text"])) < 200:
        raise RuntimeError("The page has almost no readable text (probably rendered by JavaScript or behind a login). Try another source.")
    key.write_text(json.dumps(page, ensure_ascii=False), encoding="utf-8")
    return page


def quote_on_page(quote: str, page_text: str) -> bool:
    haystack = normalize(page_text)
    pos = 0
    for frag in re.split(r"\.{3,}|…+|\[\.\.\.\]", quote):
        frag = normalize(frag)
        if not frag:
            continue
        found = haystack.find(frag, pos)
        if found < 0:
            return False
        pos = found + len(frag)
    return True


def cmd_fetch(args):
    d = Path(args.dir)
    try:
        page = fetch_page(args.url, d / args.team / ".pages")
    except RuntimeError as e:
        die(f"FAILED: {e}")
    print(f"URL: {page['url']}\nTitle: {page['title']}")
    for k, v in page["meta"].items():
        print(f"meta {k}: {v}")
    text = page["text"]
    print(f"Length: {len(text)} chars\n")
    if args.grep:
        lines = text.splitlines()
        shown = set()
        for i, ln in enumerate(lines):
            if any(w.lower() in ln.lower() for w in args.grep):
                for j in range(max(0, i - 1), min(len(lines), i + 2)):
                    if j not in shown:
                        print(lines[j])
                        shown.add(j)
                print("---")
        if not shown:
            print("(no line matches those words)")
    else:
        print(text if args.full else text[:6000] + ("\n...[truncated; use --grep or --full]" if len(text) > 6000 else ""))


def cmd_add(args):
    d = Path(args.dir)
    rnd = load_round(d)
    if rnd.get("sealed"):
        die("REJECTED: evidence is sealed - research is over for this round.")
    cards = load_cards(d, args.team)
    if len(cards) >= rnd["max_cards"]:
        die(f"REJECTED: {args.team} already has {len(cards)}/{rnd['max_cards']} cards.")
    quote = args.quote.strip()
    nq = normalize(quote)
    if len(nq) < 12:
        die("REJECTED: quote too short to be a card - quote the full sentence that proves the claim.")
    if len(nq) > 600:
        die("REJECTED: quote too long - cut it to the sentences that prove the claim (join fragments with ...).")
    for c in cards:
        other = normalize(c["quote"])
        if nq in other or other in nq:
            die(f"REJECTED: duplicate of {c['id']}.")
    if args.verified_by == "webfetch":
        if not (d / args.team / ".pages" / "network_failed").exists():
            die("REJECTED: --verified-by webfetch is only for shells without internet access. "
                "Run `cards.py fetch` first; the script must be able to check the page itself when it can.")
        page = {"url": args.url, "title": "", "meta": {}, "text": ""}
        on_page, source_seen = True, None
    else:
        try:
            page = fetch_page(args.url, d / args.team / ".pages")
        except RuntimeError as e:
            hint = ""
            if str(e).startswith("NETWORK"):
                hint = ("\nIf this shell has no internet access at all, confirm the exact sentence with your web tool "
                        "and re-run with --verified-by webfetch (the card is then marked as tool-checked, not script-checked).")
            die(f"REJECTED: {e}{hint}")
        on_page = quote_on_page(quote, page["text"])
        hay = normalize(page["text"] + " " + page["title"] + " " + " ".join(page["meta"].values()))
        source_seen = any(normalize(x) and normalize(x) in hay for x in [args.publication, args.author] if x)
    if not on_page:
        die("REJECTED: the quote is not on the page verbatim. Copy it exactly from `cards.py fetch` output "
            "(you may cut words out with ..., but not reword).")
    prefix = "P" if args.team == "pro" else "C"
    card = {
        "id": f"{prefix}{len(cards) + 1}",
        "team": args.team,
        "claim": args.claim.strip(),
        "author": args.author.strip(),
        "credentials": (args.credentials or "").strip(),
        "publication": args.publication.strip(),
        "date": args.date.strip(),
        "title": page["title"][:200],
        "url": page["url"] or args.url,
        "domain": urlparse(page["url"] or args.url).netloc.removeprefix("www."),
        "quote": quote,
        "verified_by": args.verified_by,
        "source_on_page": source_seen,
        "checked_at": datetime.datetime.now().isoformat(timespec="seconds"),
    }
    cards.append(card)
    (d / args.team / "cards.json").write_text(json.dumps(cards, ensure_ascii=False, indent=2), encoding="utf-8")
    note = ""
    if source_seen is False:
        note = ("  (note: neither the author nor the publication name appears on the page - double-check the citation "
                "and use the name exactly as the page gives it)")
    print(f"ADDED {card['id']} ({len(cards)}/{rnd['max_cards']}){note}")


def cmd_list(args):
    for c in load_cards(Path(args.dir), args.team):
        q = c["quote"].replace("\n", " ")
        print(f"[{c['id']}] {c['claim']} | {c['author']}, {c['publication']}, {c['date']} | \"{q[:90]}{'...' if len(q) > 90 else ''}\"")


def cmd_seal(args):
    d = Path(args.dir)
    rnd = load_round(d)
    rnd["sealed"] = True
    save_round(d, rnd)
    counts = {t: len(load_cards(d, t)) for t in TEAMS}
    print(f"Sealed. Cards: pro {counts['pro']}, con {counts['con']}")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch")
    f.add_argument("dir"); f.add_argument("team", choices=TEAMS); f.add_argument("url")
    f.add_argument("--grep", nargs="+"); f.add_argument("--full", action="store_true")
    a = sub.add_parser("add")
    a.add_argument("dir"); a.add_argument("team", choices=TEAMS)
    a.add_argument("--url", required=True); a.add_argument("--quote", required=True)
    a.add_argument("--claim", required=True, help="what this card proves, one line")
    a.add_argument("--author", required=True, help="person or institution responsible for the text")
    a.add_argument("--publication", required=True, help="outlet/organisation, as named on the page")
    a.add_argument("--date", required=True, help="publication date, e.g. 2024-05 or 2024")
    a.add_argument("--credentials", help="why this author is qualified, e.g. 'economist at the IMF'")
    a.add_argument("--verified-by", choices=["script", "webfetch"], default="script")
    li = sub.add_parser("list"); li.add_argument("dir"); li.add_argument("team", choices=TEAMS)
    s = sub.add_parser("seal"); s.add_argument("dir")
    args = p.parse_args()
    {"fetch": cmd_fetch, "add": cmd_add, "list": cmd_list, "seal": cmd_seal}[args.cmd](args)


if __name__ == "__main__":
    main()
