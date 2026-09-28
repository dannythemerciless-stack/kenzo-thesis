# What's in the database, and why

Written for Kenzo. No SQL needed — this explains what each table holds and
what it does for the thesis.

To look at any of it: Supabase → **Table Editor** → change the schema dropdown
from `public` to **`exp`**.

---

## The shape of it

Nine tables. Five hold your study; four keep the machinery running.

```
   participant_keys ──────┐
   (who is in the study)  │
                          ▼
                      sessions ──────► surveys
                    (their attempt)    (their ratings)
                          │
                          ▼
                   session_questions
                 (what they saw and answered)
                          │
                          ▼
       questions ──► question_options
                (the quiz itself)
```

---

# The five that hold your data

## `participant_keys` — who is in the study

One row per person you issued a key to. **300 rows when fully recruited.**

| Column | What it is | Why it matters |
|---|---|---|
| `key_code` | `KQ-8JMC-RRCS` | What they type in. **Also your join column** — this is how you attach the Google Form demographics in STATA. |
| `codename` | `bluewhale` | What appears on the public leaderboard. Keeps rankings public without naming anyone. |
| `arm` | `control` or `treatment` | **Your independent variable.** `treatment` = sees the progress bar. |
| `block` | 0, 1, 2… | Which block of 10 they were randomised in. Usable as a fixed effect. |
| `is_test` | true/false | Pilot key. Excluded from every analysis view. |

**No name, no email, no student number.** Those stay in your Google Sheet. The
only link between the two is `key_code`, which you hold privately — so the
database on its own cannot identify anyone.

**Why `block` exists.** Simple coin-flip randomisation only lands on 150/150 if
everyone shows up. People respond over days, so keys go out in batches, and the
split would drift. Blocking guarantees each group of 10 is exactly 5 and 5,
which keeps the groups balanced at every point during recruitment.

---

## `sessions` — one attempt, and both dependent variables

One row per person who actually started. **This is the table your regressions
come from.**

### Your two DVs

| Column | What it is |
|---|---|
| `completed` | **DV1.** 1 = answered all 100 within the hour, 0 = ran out of time. |
| `exposure_duration_sec` | **DV2.** Seconds spent. This is the one your paper specifies. |

### Three more duration measures, and why

`exposure_duration_sec` has a problem you need to handle in the analysis. For
someone who timed out it is always exactly **3600** — not because they worked
for an hour, but because that is when you stopped observing them. If 40% time
out, 40% of your "continuous" variable is the identical number, and a t-test on
that is misspecified. A reviewer will catch it.

So three columns exist to let you defend it:

| Column | Meaning |
|---|---|
| `effort_duration_sec` | Time until their **last answer** — when they actually gave up |
| `engaged_duration_sec` | Time until they stopped being on the page at all |
| `duration_censored` | **1 if they timed out.** This is the flag that makes a Tobit or survival model possible. |

Report `exposure_duration_sec` as primary (it's what the paper says) but
**always with `duration_censored`**. If the two agree you have a robust
finding; if they diverge you have an interesting one — does the bar change
*when people quit*, or only *how fast they go*?

### The rest

| Column | Why |
|---|---|
| `arm` | Copied from the key at start time. What they were **actually shown**, independent of the key table. |
| `correct_count` | Their score. Decides the prize. |
| `answered_count` | How far they got. For a timeout this is the interesting number. |
| `started_at` / `deadline_at` / `ended_at` | The clock. `deadline_at` is fixed at start and never moves — closing the tab does not pause it. |
| `focus_loss_count` | How many times they switched away for 2+ seconds |
| `hidden_ms_total` | How long they were away in total |
| `disqualified` | 5+ switches. Excluded from **prizes only** — their data still counts. |
| `plan_sha256` | Fingerprint of their shuffle. Proves it was fixed at the start and never changed. |

**On `focus_loss_count`:** call this *tab-visibility loss count* in the thesis,
never "cheating detection". It cannot see a phone, a second monitor, or a
friend in the room, and it fires spuriously on mobile notifications. Report it
descriptively and lean your argument on the duration DVs, which cheating barely
affects, rather than on score, which it affects a lot.

---

## `session_questions` — what each person saw, and what they answered

100 rows per participant. **30,000 rows at full recruitment.** The big one.

This exists for two reasons.

### 1. It kills the answer-key exploit

Your original key had **C correct 62 times and A correct zero times.** Someone
who noticed could click "C" a hundred times and score ~62 in a minute, taking a
prize from someone who actually worked.

So every participant gets the four options in a different order. `option_order`
records the order *that person* saw — without it, "they picked the second
option" means nothing and you could not score them.

You measured this yourself: clicking through without reading scored **21/100**,
which is chance. Under the original key it would have been ~61.

### 2. It shows the goal gradient directly

| Column | What it gives you |
|---|---|
| `dwell_total_ms` | How long they spent on that one question |
| `answered_at` | When, so you can plot pace across the hour |
| `is_correct` | Right or wrong |
| `hidden_ms` | Time away during that specific question |

This is what lets you ask the real question: **does the bar group speed up near
the end?** That acceleration *is* the goal gradient. Your DVs tell you whether
the bar mattered; this table tells you *how*.

The export gives you this as `export_timing.csv`.

---

## `questions` and `question_options` — the quiz

100 questions, 400 options. Loaded from `data/questions.csv`.

Each option row has `is_correct` (one per question) and `source_label` — the
letter it had in your original spreadsheet.

**`source_label` is your defence exhibit.** It lets you produce a table showing
the source key was C 62% of the time, alongside the empirical distribution of
where the correct answer actually landed on participants' screens: **~25% in
each slot.** That is evidence the instrument cannot be gamed, not just a claim.

Scoring never reads the letter. It compares option IDs.

---

## `surveys` — the manipulation check

One row per person who finished. Appendix A Section C.

Five 1–5 ratings: mental exhaustion, perceived difficulty, focus drain, stress
under the timer, overall difficulty. Plus five checkboxes on what they
considered doing when tired, and one on whether someone described the quiz to
them beforehand.

**What it's for:** if the bar group reports *lower* perceived difficulty on the
same questions, that supports the mechanism — the bar changed how the task
*felt*, not what it *was*. The contamination checkbox lets you re-run the
analysis excluding people who already knew what was coming.

---

# The four that keep it running

| Table | Job |
|---|---|
| `study_config` | One row of switches: `pool_locked`, `leaderboard_public`, `time_limit_sec`. The `pnpm x` commands flip these. |
| `browser_sessions` | The cookie. How "resume with your key" works without logins. Deleted when the attempt ends. |
| `key_attempt_log` | Throttles key guessing. Auto-purged hourly. |
| *(views)* | `v_export_wide`, `v_item_timing`, `v_leaderboard` — not tables, just saved queries that assemble the above into analysis-ready shapes. |

---

# Getting it into STATA

```bash
TOKEN=$(grep RESEARCHER_EXPORT_TOKEN .env.local | cut -d= -f2)
BASE=https://the-publico-experiment.vercel.app

curl -H "Authorization: Bearer $TOKEN" "$BASE/api/export?dataset=wide"   -o export_wide.csv
curl -H "Authorization: Bearer $TOKEN" "$BASE/api/export?dataset=timing" -o export_timing.csv
```

**`export_wide.csv`** — one row per participant, 38 columns, your main file.

It includes **every key issued**, even people who never showed up
(`redeemed = 0`). You need that for the CONSORT flow diagram and to check
whether take-up differed by group. An export containing only the people who
participated cannot detect the most common threat to a randomised trial.

Join it to your Google Form on **`key_code`** to attach age, sex, allowance and
working status.

**`export_timing.csv`** — one row per question per participant, for the pace
analysis.

---

# Things that are impossible, by design

Worth knowing, because they are what you say when a panellist asks how you know
the data is sound:

- **Two attempts on one key.** Enforced by a uniqueness constraint, not by app code.
- **Changing an answer once submitted.** The database refuses the update.
- **Answering out of order, or skipping.** Refused.
- **A reshuffle after the fact.** The order is written once and frozen. "How do you know you didn't reshuffle after seeing the data?" — the database physically rejects it.
- **The app claiming an answer was correct when it wasn't.** Correctness is read from the question pool, never accepted from the caller.
- **A control participant finding progress info.** Their browser never receives a question count, and never downloads the progress bar code at all.

`pnpm x audit` re-checks all of this and independently re-scores every answer.
Run it before you export.
