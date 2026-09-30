# Speeches during the round

## Prompt template (moderator → speaker subagent)

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

- **Length**: stay within the time. Over time means the judge stops listening; well under time wastes a speech.
- **Cards you may cite**: your team's cards (`[P3]` for Pro, `[C2]` for Con), and the other team's cards only after they were read aloud in `public/`. Citing the other team's unread cards would mean you had seen their files.
- **No invented cards**: every marker must exist. Facts and numbers not in any read card must be presented as reasoning, not fact.
- **Final focus**: no cards that haven't already been read in the round. The second summary may read new cards, but judges will discount them since the other side can't answer in a speech.

### 4. Rules only you can enforce

- **Fidelity**: when you use a card, say what the quote says, not more. When you extend a card later, use the author's name ("正如国家统计局的数据所示"), not the full quote again.
- **Clash**: respond to what was actually said, in the words it was said, not to a weaker version. Judges punish strawmen.
- **Signposting**: tell the judge where you are ("先看对方第一个论点……" / "On their second contention...").
- **Voice**: this is spoken to a judge; write in spoken sentences, not bullet points. Short paragraphs are fine. Let your persona shape the voice, never the substance.
- **Crossfire concessions**: if the other side conceded something in crossfire that helps you, bring it into your speech explicitly - otherwise it doesn't count.

### Format of the speech file

Plain markdown paragraphs, no title (the page adds speaker and segment). Card markers go right after the sentence that uses the card: `……周平均工作时间为49.0小时[P1]。`
