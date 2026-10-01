# Speeches and crossfire during the round

Every word in the round is written by the team it belongs to. Speeches come from a speaker subagent; crossfire turns come from a crossfire subagent for the team whose turn it is. The moderator only dispatches, relays and checks.

## Prompt template: speech (moderator → speaker subagent)

Spawn a fresh subagent for each rebuttal, summary and final focus:

```
You are <speaker name> (persona: <persona> - <style>) of the <正方/反方 | Pro/Con> team in a Public Forum debate.
Resolution: <resolution>. Language: <zh/en>.
You are giving segment <n>: the <first/second> <Rebuttal | Summary | Final Focus>, <minutes> minutes, about <target> <字/words>.

Round directory: <abs path>. Scripts: <abs path to scripts dir>.
Read <abs path>/references/speeches.md (section "Speaker instructions") and the section of <abs path>/references/format.md for your speech type.

You may read: <team>/ (your team's cards.json, prep.md, notes.md) and everything in public/. Do not open the other team's folder.
Write the speech to <dir>/<public file>, then run `python3 $S/check_speech.py <dir> <n>` and fix every error (at most two rewrites).
Reply with only: the check result line (length, ok/errors) and one sentence on your strategy. Do not paste the speech.
```

## Prompt template: crossfire turn (moderator → team crossfire subagent)

A crossfire is run as five alternating moves. A is the team that spoke first in the round, B the other team:

| Move | Team | Does |
|---|---|---|
| 1 | A | asks the first question |
| 2 | B | answers it, then asks a question |
| 3 | A | answers, then asks (often a follow-up on B's answer in move 2) |
| 4 | B | answers, then asks |
| 5 | A | answers |

That gives 4 questions and 4 answers, about 3 minutes. In grand crossfire each team's agent speaks for both of its debaters and decides which one takes each turn; each debater should ask at least once.

```
You are the <正方/反方 | Pro/Con> team in the <first crossfire (speaker 1s) | second crossfire (speaker 2s) | grand crossfire (all four)> of a Public Forum debate, speaking as <speaker name(s), each with persona>.
Resolution: <resolution>. Language: <zh/en>.

Round directory: <abs path>. Scripts: <abs path to scripts dir>.
Read <abs path>/references/speeches.md (section "Crossfire turns").
You may read everything in public/ (the crossfire so far is in public/<file>.part) and your team's prep.md and notes.md. Do not open the other team's folder.

Your move (<k> of 5): <ask the opening question | answer the last question, then ask one | answer the last question - this is the final move>.
Append your turn(s) to <dir>/public/<file>.part, one per line, in the form **<speaker name>：** text
Reply with only: done.
```

If you can continue a subagent you already spawned (for example with a SendMessage tool), you may keep each team's crossfire agent for all its moves within one crossfire: send it the other team's latest turn and the next move. It still writes to the `.part` file.

When move 5 is done: `mv public/<file>.part public/<file>`, then `check_speech.py <dir> <n>`. If the check reports a format error (a speaker tag that doesn't match), fix the tag yourself; never change what anyone said.

## Speaker instructions

### 1. Read the round like a judge's flow

Read every file in `public/` in order. For each argument on the table (yours and theirs), note: who made it, what responses it received, and whether those responses were answered. An argument nobody answered is conceded; a response nobody frontlined stands. Also read your team's `prep.md` and `notes.md` (what your partner planned).

### 2. Plan privately, then write

Append a short plan to `<team>/notes.md` before writing (your partner will read it later; the other team never will):

- The ballot story in two sentences: "We win because ___; even if they win ___, we still win because ___."
- For each argument you'll address: your response and the card or reason behind it.
- The weighing mechanism you'll use and why it favors you.
- Rebuttal/summary only: which of your own arguments you'll go for, and which you'll drop.

A speech written from a plan like this sounds like an argument; one written straight from the cards sounds like a bibliography.

### 3. Rules the check script enforces

- **Length**: stay within the time. There is a 10-second grace period; past it the judge stops listening. Well under time wastes a speech.
- **Cards you may cite**: your team's cards (`[P3]` for Pro, `[C2]` for Con), and the other team's cards only after they were read aloud in `public/`. Citing the other team's unread cards would mean you had seen their files.
- **No invented cards**: every marker must exist. Facts and numbers not in any read card must be presented as reasoning, not fact.
- **Final focus**: no cards that haven't already been read in the round. The second summary may read new cards, but judges will discount them since the other side can't answer in a speech.

### 4. Rules only you can enforce

- **Fidelity**: a card proves only what its quote measured. If a study compares people working 55+ hours with people working 35-40 hours, it says nothing about 40 versus 32 hours - using it that way is the kind of overreach judges catch and punish. When you extend a card later, use the author's name ("正如国家统计局的数据所示"), not the full quote again.
- **Uncarded facts**: a historical fact or number that isn't in any read card is an assertion. Either present it as reasoning ("即使只有一小部分企业……") or leave it out; the other side can and should point out that it's uncarded.
- **Clash**: respond to what was actually said, in the words it was said, not to a weaker version. Judges punish strawmen.
- **Signposting**: tell the judge where you are ("先看对方第一个论点……" / "On their second contention...").
- **Voice**: this is spoken to a judge; write in spoken sentences, not bullet points. Short paragraphs are fine. Let your persona shape the voice, never the substance.
- **Crossfire concessions**: if the other side conceded something in crossfire that helps you, bring it into your speech explicitly - otherwise it doesn't count.

### Format of the speech file

Plain markdown paragraphs, no title (the page adds speaker and segment). Card markers go right after the sentence that uses the card: `……周平均工作时间为49.0小时[P1]。`

If a card's `claim` turns out to overstate its quote, narrow it with `cards.py edit <dir> <team> <id> --claim "..."`. Never edit `cards.json` by hand.

## Crossfire turns

You are speaking for your own team, live, to someone on the other team. Read the public record first - especially the crossfire so far - and your team's `prep.md` and `notes.md`, so your questions serve your partner's next speech and your answers match your team's case.

**Asking**
- One question per turn, one sentence. A question that needs a paragraph of setup is a speech.
- Aim at the weakest public link: a step in their chain with no card behind it, a card that says less than they claimed, a contradiction between their two speakers, a missing comparison of impacts.
- Prefer closed questions (yes/no, A or B). Use the previous answer: "So you agree that…?" is how concessions get locked in.
- No speeches, no new cards in questions.

**Answering**
- Answer the question that was asked, in one to three sentences. Evasion looks worse to a judge than a small concession.
- Concede small true points, and say in the same breath why they don't change the outcome. Don't concede the link your case depends on.
- Refer only to cards already read in the round (`[P3]`); crossfire is not the place to introduce new evidence.

**Format**: append to the `.part` file, one turn per line, using the exact speaker names from `round.json`:

```markdown
**正方一辩：** 您方说……，这个数字统计的是哪一年？
**反方一辩：** 2023 年，[C2] 国家统计局的数据。
```
