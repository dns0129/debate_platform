# Judging

## Prompt template (moderator → judge subagent)

One per judge in `round.json` → `judges`, all in the same turn:

```
You are a judge in a Public Forum debate: <judge name>. <judge style>
Language of the round: <zh/en> - write your ballot in that language.

Read <abs path>/references/judging.md (section "Judge instructions"), then read only <dir>/judge_packet.md. It contains the full public record of the round and the full text of every card read aloud. Don't open any other file in the round directory - a judge only knows what happened in the room.

Write your ballot to <dir>/ballots/<judge id>.json in the schema below and validate it with `python3 -c "import json;json.load(open('<path>'))"`.
Reply with only: your decision and a one-sentence reason.
```

## Judge instructions

Decide the round the way your judge profile describes, but every profile shares these rules:

- **Decide on what was said.** Don't import your own knowledge of the topic to fill in a team's missing link or to refute an unanswered argument. Your background can make you skeptical of a claim; it can't make an argument for either side.
- **Follow the round through to the end.** An argument has to be in summary and final focus to be voted on. New arguments in final focus don't count. Responses that were never answered stand.
- **Check the evidence.** Compare how each card was described in speeches against its quote in the packet. A misrepresented card loses its weight, and a pattern of misrepresentation should cost the team points and possibly the round. Note what you found in `evidence_notes`.
- **Resolve the weighing.** If both teams win some offense, the round is decided by whichever weighing was better argued and compared. If neither team weighed, say how you weighed and why.
- **Time**: each speech's estimated time is shown against its limit. There is a 10-second grace period; only time past it is overtime, and a few seconds inside it is not a fault.
- **Speaker points** (scale 25-30, one decimal): 28.0 is a solid, average varsity performance; 29+ is excellent; 30 is exceptional; below 27 means real problems (dropped key arguments, misrepresented evidence, rudeness). Points reflect individual performance - a low-point win is allowed when the winning team argued better but spoke worse.
- **Be specific.** Quote or pinpoint the moment that decided each clash ("反方二辩在反驳中指出……，正方总结没有回应").

## Ballot schema

```json
{
  "judge": "<judge id from round.json>",
  "decision": "pro",
  "rfd": "Reason for decision, 150-300 字 / 100-200 words, markdown. Start with the one sentence that decided the round.",
  "key_clashes": [
    {"title": "Short name of the clash", "winner": "pro | con | even", "analysis": "2-4 sentences: what each side said and why this side won it."}
  ],
  "speakers": {
    "pro1": {"points": 28.4, "comment": "One or two sentences: best moment, main thing to improve."},
    "pro2": {"points": 28.0, "comment": "..."},
    "con1": {"points": 27.8, "comment": "..."},
    "con2": {"points": 28.6, "comment": "..."}
  },
  "evidence_notes": "Any card used unfaithfully or unusually well; 'none' if nothing stood out."
}
```

Use 2-4 key clashes. The speaker IDs are always `pro1, pro2, con1, con2`.

## decision.md (moderator writes after tally)

The panel's written decision, synthesized from the ballots and `result.json` - it reports what the judges found, so don't add verdicts the ballots don't support. Use `##` headings, in the round's language:

1. **判决结果 / Decision** - winner, vote (e.g. 2–1), and the one-paragraph reason the majority gave. If split, say what the dissent saw differently.
2. **胜负关键 / Key clashes** - the 2-3 clashes that decided the round, each a short paragraph naming the moments in the round (who said what, which segment).
3. **各环节点评 / Segment by segment** - one bullet per phase (constructives, rebuttals + crossfires, summaries, grand crossfire + final focus): who did better and why.
4. **辩手得分 / Speaker points** - a table: speaker, average points, one-line comment drawn from the ballots. Then **最佳辩手 / Top speaker** and why.
5. **改进建议 / What each team could do better** - 2-3 concrete, actionable points per team, grounded in specific moments.
