"""Render round.md into a self-contained, styled round.html."""
import re
import sys
import markdown

src, out = sys.argv[1], sys.argv[2]
text = open(src, encoding="utf-8").read()

md = markdown.Markdown(extensions=["tables", "md_in_html", "attr_list", "toc", "sane_lists"])
body = md.convert(text)

# Pull the H1 out so it can live in the hero header.
h1 = re.search(r"<h1[^>]*>(.*?)</h1>", body, re.S)
title_html = h1.group(1) if h1 else "Public Forum Round"
body = body.replace(h1.group(0), "", 1) if h1 else body

# Build the timeline nav from H2s.
toc_items = []
for m in re.finditer(r'<h2 id="([^"]+)">(.*?)</h2>', body, re.S):
    hid, label = m.group(1), re.sub(r"<[^>]+>", "", m.group(2))
    kind = "neutral"
    if "Crossfire" in label:
        kind = "cx"
    elif " Pro " in f" {label} " or label.split(".")[-1].strip().startswith("Pro"):
        kind = "pro"
    elif " Con " in f" {label} " or label.split(".")[-1].strip().startswith("Con"):
        kind = "con"
    if hid == "decision":
        kind = "decision"
    short = re.sub(r"\s*\(\d:\d\d\)", "", label)
    time = re.search(r"\((\d:\d\d)\)", label)
    toc_items.append((hid, short, kind, time.group(1) if time else ""))

# Tag each h2 with a class for side colouring.
kinds = {hid: kind for hid, _, kind, _ in toc_items}
body = re.sub(r'<h2 id="([^"]+)">', lambda m: f'<h2 id="{m.group(1)}" class="h-{kinds.get(m.group(1), "neutral")}">', body)

# Label evidence blockquotes (the ones that start with a bold source tag) as cards.
body = re.sub(r"<blockquote>\s*<p><strong>", '<blockquote class="card"><p><strong>', body)
body = body.replace('<blockquote class="card"><p><strong>Note on this transcript.', '<blockquote class="note"><p><strong>Note on this transcript.')

nav = "\n".join(
    f'<li class="k-{k}"><a href="#{h}"><span class="dot"></span><span class="lbl">{l}</span>'
    + (f'<span class="t">{t}</span>' if t else "")
    + "</a></li>"
    for h, l, k, t in toc_items
)

html = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>UN Veto PF Round</title>
<meta name="description" content="A full simulated Public Forum round on abolishing the UN Security Council veto: every speech, all three crossfires, and a three-judge panel's ballots.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
<style>
:root {{
  --bg: #f7f5f0;
  --surface: #ffffff;
  --surface-2: #f0ede6;
  --text: #1d1f24;
  --muted: #5d6270;
  --rule: #dcd7cc;
  --pro: #1f5fae;
  --pro-soft: #e6eef9;
  --con: #b0432a;
  --con-soft: #f8e9e4;
  --cx: #6a4fa3;
  --cx-soft: #efeaf8;
  --gold: #9a6b00;
  --gold-soft: #fbf1d9;
  --shadow: 0 1px 2px rgba(20,20,30,.06), 0 4px 16px rgba(20,20,30,.05);
}}
@media (prefers-color-scheme: dark) {{
  :root:not([data-theme="light"]) {{
    --bg: #14161a;
    --surface: #1c1f25;
    --surface-2: #23272e;
    --text: #e8e6e1;
    --muted: #a3a8b4;
    --rule: #343944;
    --pro: #7fb0f0;
    --pro-soft: #1d2a3d;
    --con: #f0957c;
    --con-soft: #3a2420;
    --cx: #b9a3ea;
    --cx-soft: #2a2438;
    --gold: #e8c46a;
    --gold-soft: #332b17;
    --shadow: 0 1px 2px rgba(0,0,0,.3), 0 4px 16px rgba(0,0,0,.25);
  }}
}}
:root[data-theme="dark"] {{
  --bg: #14161a;
  --surface: #1c1f25;
  --surface-2: #23272e;
  --text: #e8e6e1;
  --muted: #a3a8b4;
  --rule: #343944;
  --pro: #7fb0f0;
  --pro-soft: #1d2a3d;
  --con: #f0957c;
  --con-soft: #3a2420;
  --cx: #b9a3ea;
  --cx-soft: #2a2438;
  --gold: #e8c46a;
  --gold-soft: #332b17;
  --shadow: 0 1px 2px rgba(0,0,0,.3), 0 4px 16px rgba(0,0,0,.25);
}}
* {{ box-sizing: border-box; }}
html {{ scroll-behavior: smooth; scroll-padding-top: 16px; }}
body {{
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 17px/1.65 "Source Serif 4", Georgia, "Times New Roman", serif;
  -webkit-font-smoothing: antialiased;
}}
a {{ color: var(--pro); }}
.layout {{
  display: grid;
  grid-template-columns: 250px minmax(0, 780px);
  gap: 48px;
  max-width: 1120px;
  margin: 0 auto;
  padding: 32px 24px 80px;
}}
nav.timeline {{
  position: sticky; top: 24px; align-self: start;
  font: 500 13px/1.35 Inter, system-ui, sans-serif;
  max-height: calc(100vh - 48px); overflow-y: auto;
}}
nav.timeline h4 {{ margin: 0 0 10px; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }}
nav.timeline ol {{ list-style: none; margin: 0; padding: 0; border-left: 2px solid var(--rule); }}
nav.timeline li a {{
  display: flex; align-items: center; gap: 8px;
  padding: 6px 0 6px 12px; margin-left: -2px;
  border-left: 2px solid transparent;
  color: var(--muted); text-decoration: none;
}}
nav.timeline li a:hover {{ color: var(--text); border-left-color: var(--text); }}
nav.timeline .dot {{ width: 8px; height: 8px; border-radius: 50%; background: var(--rule); flex: none; }}
nav.timeline .lbl {{ flex: 1; }}
nav.timeline .t {{ font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 11px; color: var(--muted); }}
.k-pro .dot {{ background: var(--pro); }}
.k-con .dot {{ background: var(--con); }}
.k-cx .dot {{ background: var(--cx); }}
.k-decision .dot {{ background: var(--gold); }}
.k-decision a {{ color: var(--gold) !important; font-weight: 600; }}

header.hero {{ margin-bottom: 28px; }}
header.hero .kicker {{ font: 600 12px/1 Inter, system-ui, sans-serif; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }}
header.hero h1 {{ font: 700 clamp(28px, 4.2vw, 40px)/1.15 Inter, system-ui, sans-serif; letter-spacing: -.02em; margin: 10px 0 12px; }}
.matchup {{ display: grid; grid-template-columns: 1fr auto 1fr; gap: 12px; align-items: stretch; margin-top: 18px; }}
.team {{ background: var(--surface); border-radius: 10px; padding: 14px 16px; box-shadow: var(--shadow); font: 14px/1.4 Inter, system-ui, sans-serif; }}
.team .side {{ font-weight: 700; letter-spacing: .08em; font-size: 11px; text-transform: uppercase; }}
.team .name {{ font-weight: 700; font-size: 17px; margin: 2px 0 4px; }}
.team.pro {{ border-top: 4px solid var(--pro); }} .team.pro .side {{ color: var(--pro); }}
.team.con {{ border-top: 4px solid var(--con); }} .team.con .side {{ color: var(--con); }}
.vs {{ align-self: center; font: 700 13px Inter, system-ui, sans-serif; color: var(--muted); }}

main h2 {{
  font: 700 22px/1.25 Inter, system-ui, sans-serif; letter-spacing: -.01em;
  margin: 56px 0 14px; padding-top: 14px; border-top: 1px solid var(--rule);
}}
main h2.h-pro {{ color: var(--pro); }}
main h2.h-con {{ color: var(--con); }}
main h2.h-cx {{ color: var(--cx); }}
main h2.h-decision {{ color: var(--gold); }}
main h3 {{ font: 700 18px/1.3 Inter, system-ui, sans-serif; margin: 0 0 12px; }}
main > p:first-child {{ margin-top: 0; }}

table {{ border-collapse: collapse; width: 100%; font: 14px/1.45 Inter, system-ui, sans-serif; margin: 12px 0 18px; }}
th, td {{ text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--rule); vertical-align: top; }}
thead th {{ font-weight: 600; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .05em; }}
.meta table thead {{ display: none; }}
.meta table td:first-child {{ width: 130px; color: var(--muted); }}
.flow-wrap {{ overflow-x: auto; -webkit-overflow-scrolling: touch; border: 1px solid var(--rule); border-radius: 10px; background: var(--surface); }}
.flow-wrap table {{ margin: 0; min-width: 860px; font-size: 13px; }}
.flow-wrap td:first-child {{ min-width: 180px; }}

blockquote {{
  margin: 18px 0; padding: 12px 16px; border-left: 3px solid var(--rule);
  background: var(--surface-2); border-radius: 0 8px 8px 0; color: var(--text);
}}
blockquote p {{ margin: 0; }}
blockquote.card {{ font-size: 15.5px; position: relative; padding-top: 26px; }}
blockquote.card::before {{
  content: "Evidence"; position: absolute; top: 8px; left: 16px;
  font: 700 10px/1 Inter, system-ui, sans-serif; letter-spacing: .1em; text-transform: uppercase; color: var(--muted);
}}

.speech {{
  background: var(--surface); border-radius: 12px; padding: 22px 26px;
  box-shadow: var(--shadow); border-left: 5px solid var(--rule);
}}
.speech.pro {{ border-left-color: var(--pro); }}
.speech.pro blockquote.card {{ border-left-color: var(--pro); background: var(--pro-soft); }}
.speech.con {{ border-left-color: var(--con); }}
.speech.con blockquote.card {{ border-left-color: var(--con); background: var(--con-soft); }}
.speech p:first-child {{ margin-top: 0; }}
.speech p:last-child {{ margin-bottom: 0; }}

.cx {{
  background: var(--cx-soft); border-radius: 12px; padding: 18px 22px;
  font-size: 16px;
}}
.cx p {{ margin: 0 0 10px; padding-left: 104px; text-indent: -104px; }}
.cx p:last-child {{ margin-bottom: 0; }}
.cx b {{
  display: inline-block; width: 98px; margin-right: 2px; text-indent: 0;
  font: 700 11.5px/1.9 Inter, system-ui, sans-serif; letter-spacing: .06em;
}}
.cx b.pro {{ color: var(--pro); }}
.cx b.con {{ color: var(--con); }}

.time {{ text-align: right; font: 500 12px "JetBrains Mono", ui-monospace, monospace; color: var(--muted); margin: 8px 4px 0; }}
.stage, .stage-inline {{ font: 14px/1.55 Inter, system-ui, sans-serif; color: var(--muted); }}
.stage {{ background: var(--surface-2); border-radius: 10px; padding: 14px 18px; }}
.stage p {{ margin: 0 0 8px; }} .stage p:last-child {{ margin: 0; }}
.stage-inline {{ font-style: italic; margin: 14px 0 0; }}
.cx .stage-inline {{ padding-left: 0; text-indent: 0; }}

.ballot {{
  background: var(--surface); border-radius: 12px; padding: 20px 24px; margin: 18px 0;
  box-shadow: var(--shadow); border-top: 5px solid var(--rule);
}}
.ballot.pro-win {{ border-top-color: var(--pro); }}
.ballot.con-win {{ border-top-color: var(--con); }}
.ballot.pro-win h3 strong {{ color: var(--pro); }}
.ballot.con-win h3 strong {{ color: var(--con); }}
.ballot table {{ max-width: 360px; }}

.decision {{
  background: var(--gold-soft); border: 1px solid var(--gold); border-radius: 14px; padding: 22px 26px;
}}
.decision > p:first-child {{ font: 700 22px/1.3 Inter, system-ui, sans-serif; margin-top: 0; }}
.decision table {{ max-width: 520px; }}

#sources + ul, main ul {{ font-size: 15px; }}
main li {{ margin: 4px 0; }}

.theme-toggle {{
  position: fixed; right: 16px; bottom: 16px; z-index: 10;
  font: 600 12px Inter, system-ui, sans-serif; padding: 8px 12px; border-radius: 999px;
  border: 1px solid var(--rule); background: var(--surface); color: var(--text); cursor: pointer; box-shadow: var(--shadow);
}}

@media (max-width: 960px) {{
  .layout {{ grid-template-columns: minmax(0, 1fr); gap: 0; padding: 20px 16px 72px; }}
  nav.timeline {{ position: static; max-height: none; margin-bottom: 8px; background: var(--surface); border-radius: 10px; padding: 12px 14px; box-shadow: var(--shadow); }}
  nav.timeline ol {{ columns: 2; column-gap: 18px; border-left: 0; }}
  nav.timeline li a {{ padding: 4px 0; border-left: 0; margin-left: 0; }}
  nav.timeline .t {{ display: none; }}
}}
@media (max-width: 560px) {{
  body {{ font-size: 16px; }}
  nav.timeline ol {{ columns: 1; }}
  .matchup {{ grid-template-columns: 1fr; }}
  .vs {{ text-align: center; }}
  .speech, .ballot, .decision {{ padding: 16px 16px; }}
  .cx {{ padding: 14px 14px; }}
  .cx p {{ padding-left: 0; text-indent: 0; }}
  .cx b {{ display: block; width: auto; }}
  .meta table td:first-child {{ width: 92px; }}
}}
</style>
</head>
<body>
<div class="layout">
<nav class="timeline" aria-label="Round timeline">
<h4>Round timeline</h4>
<ol>
{nav}
</ol>
</nav>
<main>
<header class="hero">
<div class="kicker">Public Forum · Simulated octofinal · 3-judge panel</div>
<h1>{title_html}</h1>
<div class="matchup">
  <div class="team pro"><div class="side">Pro · speaks first</div><div class="name">Lakeshore OR</div>Amara Okafor &amp; Daniel Reyes</div>
  <div class="vs">vs</div>
  <div class="team con"><div class="side">Con · speaks second</div><div class="name">Ridgefield NL</div>Priya Natarajan &amp; Theo Lindqvist</div>
</div>
</header>
{body}
</main>
</div>
<button class="theme-toggle" type="button" aria-label="Toggle color theme">Theme</button>
<script>
(function () {{
  var root = document.documentElement, btn = document.querySelector('.theme-toggle');
  try {{ var saved = localStorage.getItem('pf-theme'); if (saved) root.setAttribute('data-theme', saved); }} catch (e) {{}}
  btn.addEventListener('click', function () {{
    var cur = root.getAttribute('data-theme');
    if (!cur) cur = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    var next = cur === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try {{ localStorage.setItem('pf-theme', next); }} catch (e) {{}}
  }});
}})();
</script>
</body>
</html>
"""
open(out, "w", encoding="utf-8").write(html)
print("wrote", out, len(html), "bytes;", len(toc_items), "sections")
