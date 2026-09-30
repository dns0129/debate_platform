# Run notes: UN veto PF round (without skill)

## What was produced
- `round.html`: the full round as a self-contained styled page. It has a sticky timeline nav, Pro/Con color coding, crossfire dialogue formatting, evidence cards, a flow table, three ballots and a decision banner. It supports light and dark mode and works at phone width.
- `round.md`: the same round as Markdown. This is the source file for the HTML.
- `build_round.py`: a small script that renders `round.md` into `round.html` using python-markdown.

## How the round is structured
- Standard NSDA Public Forum format: constructives (4:00), first crossfire (3:00), rebuttals (4:00), second crossfire (3:00), summaries (3:00), grand crossfire (3:00), final focus (2:00), and 3:00 of prep per team, logged between speeches.
- A coin flip sets the order: Con wins and chooses to speak second, so Pro speaks first.
- The teams, debaters and judges are all made up: Lakeshore OR (Pro) and Ridgefield NL (Con).
- Speech lengths are sized to realistic delivery rates, about 150–195 words per minute.
- Each side makes realistic strategic mistakes, and those mistakes drive the decision:
  - Con drops the "selection bias" response in summary and doesn't extend its Libya turn.
  - Pro never answers "ratification is one moment" in summary.
- There's a GCX concession on each side:
  - Con admits the Bab al-Hawa renewal would have passed and probably been carried out.
  - Pro admits a resolution can't stop a nuclear power's army.
- The panel has three judges with different paradigms: lay parent, flow coach, and tech former debater. Each writes an RFD and gives speaker points.
- **Result: Pro wins 2–1.** Hollis and Osei vote Pro; Park votes Con. Theo Lindqvist (Con) is top speaker.
- The split has a real cause: the two flow judges disagree on whether Pro's ratification argument answered Con's US-exit link.

## Research
- I researched with web search before writing so the evidence would be accurate and up to date as of September 2026. Sources used:
  - Security Council Report annual and mid-2026 reviews: resolution counts, unanimity rates, veto counts, the de-mining draft withdrawn under veto threat, US arrears.
  - Security Council Report's "Living with the Veto": resolution 76/262, France–Mexico and ACT supporter counts.
  - News coverage of the Gaza vetoes (6th veto, September 2025), the Sudan veto (November 2024), the Bab al-Hawa veto (July 2023) and the April 7, 2026 Hormuz veto, plus Resolution 2817 and the 2026 Iran war context.
  - The January 2026 US withdrawal from 66 organizations.
  - The OHCHR Syria civilian death estimate.
  - Kuziemko & Werker (2006), Hultman et al. (2013) and GAO-18-243.
  - Peacekeeping assessment shares.
  - The fall of El Fasher and Resolution 2736.
  - The Connally episode at San Francisco.
- Evidence "cards" are paraphrased from these sources, not verbatim. Direct quotes are limited to Charter text and a few short phrases. All sources are listed at the end of the round.

## Assumptions
- The round date is set to today (September 30, 2026), so the debaters use current events, including the 2026 Hormuz crisis, the US withdrawals and the Secretary-General selection year.
- Both teams assume "abolish the veto" means amending Article 27(3) so that decisions need nine of fifteen votes, with the permanent seats kept. Under fiat, the amendment is ratified under Article 108.
- Nothing was published. I previewed the page briefly on a local server (port 8765) to check desktop and mobile rendering, then stopped the server.
