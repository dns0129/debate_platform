# Public Forum: rules and speech duties

Public Forum (PF) is the NSDA two-on-two format designed to be judged by ordinary people: arguments must be understandable without jargon, evidence must be real and faithfully represented, and the round is won by whoever gives the judge the clearest reason to vote for them at the end.

## Order and times

| # | Segment | Who | Time |
|---|---|---|---|
| 1 | Constructive (立论) | first team, speaker 1 | 4:00 |
| 2 | Constructive | second team, speaker 1 | 4:00 |
| 3 | Crossfire (交叉质询) | both speaker 1s | 3:00 |
| 4 | Rebuttal (反驳) | first team, speaker 2 | 4:00 |
| 5 | Rebuttal | second team, speaker 2 | 4:00 |
| 6 | Crossfire | both speaker 2s | 3:00 |
| 7 | Summary (总结) | first team, speaker 1 | 3:00 |
| 8 | Summary | second team, speaker 1 | 3:00 |
| 9 | Grand Crossfire (全场交叉质询) | all four | 3:00 |
| 10 | Final Focus (焦点总结) | first team, speaker 2 | 2:00 |
| 11 | Final Focus | second team, speaker 2 | 2:00 |

Speaking rate for length checks: 240 字/min in Chinese, 160 words/min in English. So a constructive is about 960 字 / 640 words, a final focus about 480 字 / 320 words. `check_speech.py` allows 75%-108% of the target for speeches.

Either side may speak first; the coin toss in `round.json` decides. Speaking second is an advantage late (last word in final focus) and a disadvantage early (the second rebuttal must answer attacks and defend at once).

## The argument unit

A PF contention is a causal chain, and every link needs either a card or an explicit reason:

- **Uniqueness** - what the world looks like now (status quo), so the change has somewhere to go.
- **Link** - how affirming (or negating) the resolution changes that.
- **Internal link** - intermediate steps, if the link doesn't reach the impact directly.
- **Impact** - who is affected, how much, how badly. Quantify where a card allows.

A card proves one link. Two cards on the same link add little; an unsupported link is where opponents attack. That is why a speech is reasoning with cards in it, not a list of cards: the judge needs to hear why step 2 follows from step 1.

## Responses

- **Defense**: shows an opponent's link or impact is weaker than claimed (non-unique, no link, mitigated). Defense can only reduce their offense to zero.
- **Offense / turn**: shows the opponent's own mechanism actually helps your side (link turn: the action causes the opposite; impact turn: the effect is actually good/bad). Turns win rounds, but a team that turns both the link and the impact of the same argument turns itself back.
- **Evidence indicts**: the card is old, out of context, from an unqualified source, or says less than claimed. Only valid when true - check the public card text.
- **Weighing**: why your impact matters more than theirs. Mechanisms: magnitude, scope (how many people), probability, timeframe, reversibility, and prerequisite ("their impact can't happen unless ours is solved first"). Weighing must be *comparative*: "we affect more people than they do, because..." not "our impact is big".

## What each speech must do

**Constructive (4:00)** - Pre-written case. Briefly frame the resolution (definitions only where they matter), then 2 contentions (3 at most) each built as uniqueness → link → impact, with cards on the links that need them. It is reasonable to spend 20-30 seconds pre-empting the weighing ("even if they win X, our impact outweighs because...").

**Rebuttal (4:00)**
- *First rebuttal*: attack the opponent's case. Go contention by contention, signposting ("On their first contention..."). Mix defense and at least one turn; read new cards if they help. Don't re-read your own case.
- *Second rebuttal*: must also **frontline** - answer the first rebuttal's attacks on your own case (roughly half the time), otherwise those attacks stand conceded. Prioritize the arguments you intend to go for in summary.

**Summary (3:00)** - Collapse. Pick the 1-2 arguments you are winning most clearly and extend them fully: the whole link chain (with card author names), plus answers to what the other side said about them. Extend the defense or turns you want the judge to vote on against the opponent's case, and start comparative weighing. The first summary must extend any defense it wants to keep (nothing "sticks" on its own). Anything not in summary can't appear in final focus.

**Final Focus (2:00)** - Write the judge's ballot for them. Mirror your summary: same arguments, same order, same weighing, tighter. Explain why, even on the opponent's best argument, you still win. **No new arguments and no new cards** - judges ignore them and the check script rejects new cards. The second final focus can answer the first, but only with material already in the round.

**General norms** - Speak to the judge, not the opponent. Signpost. After a card is read once, refer to it by author ("as Smith said") instead of re-reading it. Any number or fact that isn't common knowledge must come from a card read in the round; otherwise present it as reasoning ("if even a small share of firms..."). Misrepresenting a card - claiming more than the quote says - is the most serious ethical violation in PF.

## Crossfire (you write these)

Crossfire is questioning, not speeches. It exists to clarify, expose weaknesses, and set up later speeches; judges don't weigh it unless a later speech brings it up. Write it as a sequence of short turns:

```markdown
**正方一辩：** 您方说……，这个数字的来源是哪一年？
**反方一辩：** 2023 年，[C2] 的国家统计局数据。
**正方一辩：** 那么 2024 年之后的政策变化不在里面，对吗？
**反方一辩：** 不完全在，但趋势……
```

- Use the speaker names exactly as in `round.json` (`正方一辩` / `Pro 1` etc.). The first question goes to the team that spoke first.
- About 8-14 turns in a 3-minute crossfire (roughly 450-780 字 / 300-520 words). Each question is one sentence; each answer is 1-3 sentences. Either side may ask; control usually alternates after 2-3 questions.
- Questions should target the weakest *public* link: an unsupported step, a card that says less than claimed, a contradiction between the two speakers of a team, missing weighing.
- Answers should be the best answer the team's *public* case supports. Concede small points when the honest answer is a concession - good debaters do, and it keeps the round believable. Never make a side say something dumber than its own speeches.
- Only cards already read in speeches may be mentioned (`[P3]`). No new evidence in crossfire.
- Let each speaker's persona show (e.g. 反例猎手 / the Counterexample Hunter presses one counterexample until it lands; 外科医生 / the Surgeon restates the opponent's chain before asking about the weak step), but content comes first.
- Grand crossfire: all four speak; the first question goes to the first-speaking team's summary speaker. It usually focuses on the one or two clashes that will decide the round, and gives the speaker 2s a chance to set up final focus.

## Personas

`round.json` gives each debater a persona (style of argument and voice). It shapes *how* they argue, never *what side* or the evidence rules. Pass it to the subagent writing that speaker's speech.
