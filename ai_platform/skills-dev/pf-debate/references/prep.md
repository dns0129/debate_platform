# Team prep

## Prompt template (moderator → team subagent)

Fill in the angle-bracket parts and send one of these per team, both in the same turn:

```
You are the <正方/反方 | Pro/Con> team in a Public Forum debate: <speaker 1 name> (persona: <persona> - <style>) and <speaker 2 name> (persona: <persona> - <style>).
Resolution: <resolution>
You speak <first/second>. Language of the round: <zh/en>.

Round directory: <abs path to debate dir>. Scripts: <abs path to scripts dir>.
Read <abs path>/references/prep.md (section "Team instructions") and <abs path>/references/format.md before starting.

Your private folder is <team>/. Do not open the other team's folder. Only you and your partner will ever see prep.md and notes.md.

Produce:
1. Verified cards via cards.py add (up to <max_cards>).
2. <team>/prep.md - your strategy and blocks.
3. <team>/constructive.md - your 4-minute constructive, passing `check_speech.py <dir> <segment n> --file <team>/constructive.md`.

When done, reply with only: number of cards, contention titles, and any problems. Do not paste the case or cards into your reply.
```

## Team instructions

You are preparing like a real PF team the week before a tournament: build a case, research it with sources an opponent could check, and anticipate what the other side will run.

### Think before you search

Spend your first step on reasoning, not searching. Write a short draft in `prep.md`:

- The core question of the resolution, and what each side must prove.
- 3-4 candidate contentions for your side, each as a chain (uniqueness → link → impact). Mark which links need a card.
- The 3-4 strongest arguments the other side is likely to run, and your planned response to each (defense or turn), marking which responses need a card.

Then pick your 2 contentions (3 at most). Research is for the links you've identified, which keeps searches targeted and stops the case from turning into whatever a search engine happened to return.

### Research

- Search in the round's language and in English; English-language primary sources are often the strongest for international topics.
- Prefer original publishers: government statistics offices, central banks, international organizations (UN, WHO, World Bank, OECD, IMF), peer-reviewed research, established think tanks, and major newspapers' original reporting. Recent beats old when the fact can change.
- Avoid reposts, self-media and document stores (头条、搜狐、网易、百家号、知乎、CSDN、文库、豆丁 and similar - `cards.py` blocks them), Wikipedia (use its cited source instead), and anything behind a login or paywall.
- For every promising page:
  1. `python3 $S/cards.py fetch <dir> <team> "<url>" --grep <keyword> [<keyword> ...]` - this prints the page exactly as the verifier sees it. If it fails (403, JavaScript-only page, PDF without pdftotext), move on to another source; don't fight it.
  2. Copy the sentence(s) that prove the link **verbatim** from that output. You may drop words in the middle with `...`, but never reword, merge sentences from different places out of order, or change numbers.
  3. `python3 $S/cards.py add <dir> <team> --url "<url>" --quote "<verbatim>" --claim "<what this proves, one line>" --author "<person or institution>" --publication "<outlet as named on the page>" --date "<YYYY-MM or YYYY>" --credentials "<why they're qualified>"`
- One card = one fact that proves one link. Don't add two cards that prove the same thing; save your quota for links that are otherwise unsupported and for responses to the other side's likely arguments.
- Aim for about 60% of cards on your own case and 40% for blocks. It's fine to stop below the cap - 6 strong cards beat 10 weak ones.
- Everything a card says must be something the quote actually says. If the claim is stronger than the quote, weaken the claim.

### prep.md (private)

Update the draft into a working brief for your speakers:

- Framework / how the judge should evaluate the round (one or two sentences).
- Each contention: tagline, chain, card IDs per link.
- Blocks: for each likely opposing argument, the response, the card IDs if any, and whether it's defense or a turn.
- Weighing: why your impacts outweigh the likely opposing impacts, on which mechanism.
- Collapse plan: which contention you'd go for in summary if pressed.

### constructive.md (will be read aloud at segment 1 or 2)

- Plain markdown paragraphs, no headings needed; open with the resolution's framing and a one-line roadmap.
- The first time a card is read: say who, when, and what, then the marker - e.g. `国家统计局2025年1月的数据显示，全国企业就业人员周平均工作时间为49.0小时[P1]。` / `According to a 2024 Federal Reserve study, ... [P3]`. Quote or closely paraphrase the card; never overstate it.
- Keep citations under half of your sentences; the rest is reasoning that connects them.
- Check it: `python3 $S/check_speech.py <dir> <n> --file <team>/constructive.md` where `<n>` is your constructive's segment number (1 if you speak first, 2 if second). Fix every error; weigh the warnings.
