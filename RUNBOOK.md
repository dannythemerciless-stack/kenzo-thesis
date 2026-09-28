# Runbook

Operating manual for the goal-proximity experiment platform.
See **DATABASE.md** for what the data means and why each table exists.

---

## ⚠️ Read this first: there is only ONE database

The app runs in two places, but **both currently talk to the same Supabase
project**:

```
   localhost:3000  ─┐
                    ├──►  Supabase (goal-proximity-thesis)
   Vercel (prod)   ─┘
```

That means a command you run locally — `pnpm x reset`, `pnpm x demo`,
`pnpm x timer 120` — **changes live data**. During fieldwork that is dangerous:
setting the timer to 120 seconds while a participant is mid-attempt would cut
their hour short.

**Before you open the study to real participants**, create a second Supabase
project for local development and point `.env.local` at it. Keep the original
for production only, and set its credentials in Vercel's environment
variables instead. Then local commands can never touch real data.

Until then: assume every command is live.

---

## Quick reference

### Daily driving

| Command | What it does |
|---|---|
| `pnpm dev` | Run the app at `localhost:3000` |
| `pnpm x setup` | Check the database and print the next command — **start here** |
| `pnpm x status` | Config, counts, preflight |
| `pnpm x audit` | Full data + scoring integrity check (read-only) |
| `pnpm x keys` | List pilot keys and whether each is used |

### Running the study

| Command | What it does |
|---|---|
| `pnpm issue responses.csv --dry-run` | Preview keys for new sign-ups |
| `pnpm issue responses.csv` | Issue keys, write mail-merge file |
| `pnpm x lock` | Freeze the questions — **required** before real keys work |
| `pnpm x unlock` | Unfreeze (only before collection starts) |
| `pnpm x publish` / `unpublish` | Show / hide the public leaderboard |
| `pnpm x withdraw <KEY>` | Delete one participant's data (right to withdraw) |
| `pnpm x wipe` | Delete ALL participant data — backs up first, asks to confirm |

### Testing

| Command | What it does |
|---|---|
| `pnpm verify` | Lint, types, unit tests, DB tests, build, blinding check |
| `pnpm test` | Randomization unit tests (10) |
| `pnpm test:db` | Schema invariants in throwaway Postgres (62) — needs Docker |
| `pnpm test:e2e` | End-to-end against the live database (42) |
| `pnpm test:browser` | Headless Chrome: tab-switching + banner (17) — needs `pnpm dev` |
| `pnpm check:blinding` | Prove the control bundle has no progress code |

### Pilot helpers (never touch real data)

| Command | What it does |
|---|---|
| `pnpm x reset` | Wipe all pilot sessions so test keys are fresh |
| `pnpm x timer 120` | Shorten the limit to see the timeout screen |
| `pnpm x timer 3600` | **Put it back** |
| `pnpm x demo 40` | Create 40 synthetic participants |
| `pnpm x demo:purge` | Remove them all |
| `pnpm x show <KEY>` / `hide <KEY>` | Make a pilot key appear on / vanish from the leaderboard |

### Setup (one-off)

| Command | What it does |
|---|---|
| `pnpm seed:questions` | Import `data/questions.csv` (100 items) |
| `pnpm seed:questions --reset` | Replace the existing pool |
| `pnpm seed:keys --count 10 --test` | Generate pilot keys |

---

## The lifecycle

### 1. Setting up a fresh database

**Run `pnpm x setup` at any point.** It inspects the database and prints the
next command or dashboard step. Everything below is just that sequence written
out.

| # | Do this | Where |
|---|---|---|
| 1 | Create the Supabase project. Region **Singapore**. Turn OFF "Automatically expose new tables". | dashboard |
| 2 | `pbcopy < supabase/apply_all.sql` then paste into **SQL Editor** and Run | terminal → dashboard |
| 3 | **Data API → Exposed schemas** → tick `exp` → Save | dashboard |
| 4 | `cp .env.example .env.local` and fill in the four values | terminal |
| 5 | `pnpm seed:questions` | terminal |
| 6 | `pnpm seed:keys --count 10 --test` | terminal |
| 7 | `pnpm x setup` — should say READY (bar the pool lock) | terminal |

Notes on the fiddly ones:

- **Step 2 before step 3.** The `exp` schema will not appear in the Exposed
  Schemas dropdown until it exists, because that list only shows schemas the
  database already has.
- **Step 3 is not optional.** PostgREST refuses to route to an unexposed
  schema whatever key you use, so every call 404s without it.
- **Step 4** needs the **secret** key (`sb_secret_…`), not the publishable one.
  `SESSION_PEPPER` and `RESEARCHER_EXPORT_TOKEN` are yours to generate:
  `openssl rand -hex 32` each.
- `apply_all.sql` begins with `drop schema if exists exp cascade`, so it is
  safe to re-run — and it destroys everything, so never run it on a database
  holding real participants.

### 2. Piloting

```bash
pnpm dev
pnpm x keys          # pick one control key and one treatment key
```

Open two browsers (normal + incognito, so the cookies don't collide) and run
one of each side by side. **Apart from the progress bar, every pixel should be
identical.** Anything else that differs becomes part of your manipulation.

Worth checking by hand:

- Close the tab mid-quiz, reopen with the same key → resumes, **time gone**
- Cmd-Tab away for 3s → red banner on return; flick away for under a second → nothing
- `pnpm x timer 120`, let it expire → survey → debrief (then `pnpm x timer 3600`)
- `pnpm x reset` between runs so keys stay fresh

### 3. Going live

**The checklist. Do all of it.**

```bash
pnpm x demo:purge            # remove synthetic participants
pnpm x hide KQ-XXXX-XXXX     # any pilot key you promoted with `show`
pnpm x timer 3600            # confirm the real time limit
pnpm x unpublish             # standings hidden during fieldwork
pnpm x lock                  # freeze the questions
pnpm x audit                 # must be clean
```

Then deploy (see below), and **freeze deploys for the whole field window**.

Why the freeze: Next.js rotates Server Action IDs on every deploy. A
participant mid-attempt on the old build gets "Failed to find Server Action".
This is the single most likely way to lose data.

### 4. During fieldwork

```bash
pnpm issue responses.csv     # each time more people sign up
pnpm x audit                 # every day or two
```

`pnpm issue` is safe to re-run: people who already hold a key are skipped, and
blocked randomization continues across batches so the two groups stay balanced.

If someone asks to withdraw:

```bash
pnpm x withdraw KQ-XXXX-XXXX
```

Their attempt is deleted; the key row is kept so your CONSORT denominator
still adds up ("300 issued, n redeemed, 1 withdrawn").

### 5. Closing and analysis

```bash
pnpm x audit                 # final integrity check
pnpm x publish               # standings go public
```

Export two files:

```bash
TOKEN=$(grep RESEARCHER_EXPORT_TOKEN .env.local | cut -d= -f2)
BASE=https://your-app.vercel.app     # or http://localhost:3000

curl -H "Authorization: Bearer $TOKEN" "$BASE/api/export?dataset=wide"   -o export_wide.csv
curl -H "Authorization: Bearer $TOKEN" "$BASE/api/export?dataset=timing" -o export_timing.csv
```

| File | Shape | Use |
|---|---|---|
| `wide` | one row per participant, 38 columns | **the main analysis file** |
| `timing` | one row per item per participant | per-item pace — the goal-gradient signature |

Join `wide` to your Google Form on **`key_code`** to attach demographics.

---

## Issuing keys, in detail

```bash
pnpm issue ~/Downloads/responses.csv --dry-run   # look first
pnpm issue ~/Downloads/responses.csv             # then do it
```

It finds your columns by substring, so rewording the form questions is fine.
It needs an email column (`Username`) and a codename column (`Codename:`).

**Three files come out, and no single one has both email and group:**

| File | Contents | For |
|---|---|---|
| `out/mailmerge-<timestamp>.csv` | email, codename, key | this batch's mailing |
| `out/issued.csv` | running ledger | so re-runs skip people |
| `out/assignment.csv` | key, codename, block, arm — **no email** | analysis |

That separation is deliberate: whoever sends the emails cannot see who is in
which group, so they cannot leak it, and the database holds nothing that
identifies a person.

**Commit the printed sha256 of `assignment.csv`** (the hash, never the file).
It is your evidence that group assignment was fixed before any data existed.

Things it handles for you, and reports:

- duplicate codenames → suffixed (`codename101` → `codename101-2`)
- blank codenames → generated
- duplicate emails → first kept
- malformed emails → skipped
- **codenames that look like a name, email or student number** → flagged ⚠

That last one matters: codenames are **published**. Consider adding to your
form: *"Pick a nickname. Don't use your name, email or student number — it
will be published."*

---

## Verifying the data

`pnpm x audit` is read-only and re-derives everything from raw rows.

**What it checks:**

*Pool* — 100 active questions, exactly 4 options each, exactly 1 correct, no
duplicate option text, pool locked.

*Keys* — group balance, unique codenames, codenames that may identify someone,
leftover demo rows.

*Scoring* — **re-scores every answered item independently.** For each one it
looks up which option is flagged correct and compares against the stored
`is_correct`. It also verifies `correct_count` and `answered_count` against the
rows they summarise, that every chosen option was among the four shown, and
that the recorded slot matches where the option actually rendered.

*Randomization* — every plan is a true permutation, no question twice, and the
correct answer lands uniformly across the four slots (~25% each).

*Timing* — durations in range, nothing ended after its own deadline, the
censoring flag matches completion, timed-out attempts record the full limit.

It excludes pilot and synthetic rows, because the demo generator sets
`is_correct` to hit a target score rather than deriving it — auditing that
would report failures that say nothing about the real instrument.

**If `audit` fails, do not export.** Find out why first.

---

## Deployment

**Vercel project settings → Functions → Region → Singapore (`sin1`).**
Manila→Singapore is ~40–70ms; the US-East default is ~200–250ms, which over
100 questions costs each participant 15–25 seconds of dead time *inside a
timed treatment*. That is a confound, not a UX nit.

Supabase must be in the same region (`ap-southeast-1`).

Environment variables (mark the secret key **Sensitive**):

```
SUPABASE_URL
SUPABASE_SECRET_KEY
SESSION_PEPPER
RESEARCHER_EXPORT_TOKEN
NEXT_SERVER_ACTIONS_ENCRYPTION_KEY     # openssl rand -base64 32
```

Set `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` explicitly — it keeps Server Action
references decryptable across instances and reduces mid-attempt breakage.

**Turn off auto-deploy from `main` for the field window.**

---

## Troubleshooting

**"The study is not open yet"** — the pool is unlocked. `pnpm x lock`.

**"That access key was not recognised"** — the key does not exist, or it is a
real key while the pool is unlocked. Deliberately the same message for unknown
and already-used keys, so the form cannot be used to probe which keys are valid.

**Standings say "not published yet"** — `pnpm x publish`.

**A pilot run does not appear on the leaderboard** — pilot keys are excluded
from every analysis view. `pnpm x show <KEY>` to surface one.

**`pnpm test:db` fails to start** — Docker isn't running.

**`pnpm test:browser` fails immediately** — `pnpm dev` isn't running.

**Everything 404s / "schema must be exposed"** — add `exp` under Supabase →
Data API → Exposed schemas.

**A participant is stuck** — `pnpm x audit`, then look at their row. To give
them a clean retry: `pnpm x withdraw <KEY>` (deletes their data; the key works
again).

---

## Reference

### Config switches (`exp.study_config`)

| Field | Effect |
|---|---|
| `pool_locked` | Questions frozen; **real keys only work when true** |
| `leaderboard_public` | Standings visible to everyone |
| `time_limit_sec` | 3600 in production |
| `focus_loss_limit` | Switches before the prize-eligibility flag (5) |
| `focus_debounce_ms` | Server-side flap guard (1000) |

### Key row kinds

| Kind | `is_test` | `block` | On the leaderboard? |
|---|---|---|---|
| Real participant | false | 0–29 | yes |
| Pilot | true | 0 | no |
| Synthetic demo | false | 900 | yes — **purge before fieldwork** |

### Prize structure

Defined once in `lib/prizes.ts`; consent, debrief and leaderboard all read
from it. Top 3 → PHP 500. Ranks 4–10 → PHP 100. Pool: PHP 2,200.

Changing it changes the experiment: Ch. III's expected-utility function is
specified over this payoff structure.
