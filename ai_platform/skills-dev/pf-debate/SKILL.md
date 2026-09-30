---
name: pf-debate
description: Simulate a complete Public Forum (PF / 公共论坛赛制) debate round on any resolution - two teams of two debaters research real, verified evidence, then run constructives, crossfires, rebuttals, summaries, grand crossfire and final focus, a judge panel writes ballots, and the whole round is published as a shareable web page. Use this skill whenever the user wants to simulate, run, generate, stage or watch a debate (模拟辩论、打一场辩论、辩论赛、正反方对辩、PF、公共论坛), wants AI debaters to argue a motion against each other, or asks to see how a debate on some topic would play out - even if they don't name the format or ask for a web page.
---

# Public Forum debate simulator

You run a full Public Forum round as its **moderator (主席/计时员)**: you set up the round, dispatch each team's work, write the crossfires, run the judge panel, and publish the record. Four debaters and the judges do the arguing and judging, ideally as separate subagents.

What makes a simulated round worth watching is the same thing that makes a real one worth watching: the teams can't see each other's files, every fact comes from a source someone can open, and the arguments are reasoning that happens to use evidence rather than evidence stapled together. The design below exists to protect those three things - keep them in mind when something unexpected comes up.

## What you need from the user

Only the resolution. If it isn't phrased as a resolution (e.g. "AI 生成内容标注"), turn it into one that has a clear Pro and Con ("中国应当强制要求对 AI 生成内容进行标注") and state it in your first message. Default to the language the user writes in. Defaults, unless the user says otherwise: coin toss decides who speaks first, 3 judges, 10 cards per team. Don't ask about these - just mention them in one line when you start. Tell the user up front that a full round with research takes a while (typically 20-40 minutes) and that you'll report as each phase finishes.

## Files

Everything lives in one round directory, `debate-<short-slug>/` in the current working directory. The scripts are in this skill's `scripts/` folder (call it `$S` below; use the absolute path).

```
debate-x/
  round.json            resolution, language, speaking order, speakers, judges, segment plan
  pro/ con/             PRIVATE team files: cards.json, prep.md, notes.md, constructive.md
  public/               the record: one file per segment, written in order
  ballots/<judge>.json  one per judge
  judge_packet.md       what judges read: the record + every card read aloud
  result.json           tally (winner, votes, speaker points, top speaker)
  decision.md           the panel's written decision
  debate.html           the page
```

**Visibility rule**: a team's folder is private to that team. You, as moderator, don't read `pro/` or `con/` either - you write the crossfires, and crossfire has to come from what's on the public record. Cards become public the moment a speech reads them (the `[P3]` marker appears in a public file). Scripts enforce most of this; your job is not to leak by hand (e.g. don't paste one team's prep into the other team's prompt).

## Workflow

### 1. Set up

```bash
python3 $S/round.py init debate-<slug> --resolution "<resolution>" --title "<2-6 word page name>"
```

This tosses the coin, assigns personas and judges, and prints the 11-segment plan (who speaks, time limit, target length, output file). Read `references/format.md` now - it has the PF rules, what each speech must do, and how to write crossfire.

### 2. Prep: both teams in parallel

Spawn two subagents in the same turn, one per team, using the prompt template in `references/prep.md`. Each team researches, adds verified cards through `cards.py add`, writes its private `prep.md` (case strategy, blocks against likely opposing arguments) and its `constructive.md`, and checks the constructive with `check_speech.py`. They return only a short status - card count and contention titles.

When both are done: `python3 $S/cards.py seal debate-<slug>` (no more research after this), then `round.py status` to confirm both constructives exist.

If a team ends up with fewer than 4 cards, send that team back once with the reasons its adds were rejected - usually the quotes were paraphrased or the source blocks scripts - before sealing.

### 3. The round

Go through the segments in order (`round.py status` always tells you what's next):

- **Constructives (1, 2)**: `cp <team>/constructive.md public/<file>` - they were written in prep, like real PF cases.
- **Speeches (rebuttals, summaries, final focus)**: spawn one fresh subagent for the speaking team with the speech template in `references/speeches.md`. It reads its own team folder plus `public/`, writes the speech to the public file, runs `check_speech.py`, and fixes errors itself (up to two rewrites). If errors remain, delete the offending sentences yourself (e.g. an invented or invisible card reference) rather than rewriting the argument.
- **Crossfires (3, 6, 9)**: write these yourself from the public record only, following the crossfire section of `references/format.md`, then run `check_speech.py` on them. Give both sides their best honest answers; a crossfire where one side is a punching bag produces a round nobody learns from.

After each segment, tell the user one line about what happened (e.g. "反方二辩反驳完成：主攻正方第二论点的因果链").

### 4. Judging

```bash
python3 $S/round.py packet debate-<slug>
```

Spawn one subagent per judge in the same turn, using `references/judging.md`. Each reads only `judge_packet.md` and writes `ballots/<judge-id>.json`. Then:

```bash
python3 $S/round.py tally debate-<slug>
```

Write `decision.md` yourself as the panel's written decision, synthesized from the ballots (not your own opinion of the round) - structure in `references/judging.md`.

### 5. Render and publish

```bash
python3 $S/render.py debate-<slug>                 # debate.html: body fragment for an artifact host
python3 $S/render.py debate-<slug> --standalone    # debate_standalone.html: complete file for disk
```

If you have a tool that publishes HTML pages as shareable links (e.g. an `Artifact` tool), publish `debate.html` with it (icon `podium`, one-sentence description naming the resolution and result) and give the user the link. The template already follows the artifact page contract (title, theme tokens for light and dark, allowed font host, phone width), so there's nothing to redesign. Otherwise give the user the path to `debate_standalone.html`.

Finish with a short summary: result and vote, top speaker, the clash that decided it, and where the page is.

## Without subagents

If you can't spawn subagents, play every role yourself in the same order, one role at a time, and hold yourself to the visibility rule: write Pro's prep, then Con's, and when writing a speech use only that team's folder and the public record - never answer an argument the other side hasn't made yet or cite a card they haven't read. Tell the user the round was simulated in one context, so the teams weren't fully independent.

## When things go wrong

- **`cards.py add` rejects a quote**: the quote must be copied from `cards.py fetch` output, not from search snippets or memory. Paraphrase is the usual cause.
- **The shell has no internet**: `cards.py` says so (`NETWORK`). Then fall back to `--verified-by webfetch` after confirming the exact sentence with your web-fetch tool; the page will label those cards as tool-checked.
- **A speech keeps failing length checks**: speaking time is part of the format (a 2-minute final focus that runs 3 minutes gets cut off by a real judge). Have the speaker cut restated evidence first.
- **Interrupted round**: everything is on disk. `round.py status` shows the next step; continue from there.
