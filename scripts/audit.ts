/**
 * Data integrity audit. Read-only — it changes nothing.
 *
 *   pnpm x audit          (or: node --env-file=.env.local scripts/audit.ts)
 *
 * Answers the question "is the data actually correct?" by re-deriving the
 * things the app claims, straight from the raw rows, and comparing.
 *
 * Most importantly it RE-SCORES EVERY ANSWER independently: for each answered
 * item it looks up which option is flagged correct and checks that against the
 * stored is_correct. The database already enforces this with a trigger, but an
 * independent recomputation is what you show a panellist who asks "how do you
 * know the scores are right?" — "a trigger prevents it" is a weaker answer
 * than "I recounted all 30,000 of them and they match".
 *
 * Run it before issuing keys, midway through fieldwork, and before exporting.
 */

import { makeClient, die } from './lib/client.ts'

const db = makeClient()

let pass = 0
const fails: string[] = []
const warns: string[] = []

const ok = (cond: boolean, name: string, detail = '') => {
  if (cond) { pass++; console.log(`    ✔ ${name}`) }
  else { fails.push(name); console.log(`    ✖ ${name}${detail ? `  — ${detail}` : ''}`) }
}
const warn = (cond: boolean, name: string) => {
  if (!cond) { warns.push(name); console.log(`    ⚠ ${name}`) }
  else { pass++; console.log(`    ✔ ${name}`) }
}
const section = (t: string) => console.log(`\n  ${t}\n  ${'─'.repeat(t.length)}`)

/** PostgREST caps rows per request, so pull big tables in pages. */
async function fetchAll<T>(table: string, columns: string, pageSize = 1000): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await db
      .from(table).select(columns).range(from, from + pageSize - 1)
    if (error) die(`reading ${table} failed`, error)
    out.push(...((data ?? []) as T[]))
    if (!data || data.length < pageSize) break
  }
  return out
}

async function main() {
  console.log('\n══ DATA INTEGRITY AUDIT ══')

  const { data: cfg } = await db.from('study_config').select('*').single()

  // ---------------------------------------------------------------- pool ---
  section('QUESTION POOL')

  const questions = await fetchAll<{ id: string; item_code: string; is_active: boolean; excluded_from_scoring: boolean }>(
    'questions', 'id, item_code, is_active, excluded_from_scoring')
  const options = await fetchAll<{ id: string; question_id: string; content: string; is_correct: boolean; source_label: string }>(
    'question_options', 'id, question_id, content, is_correct, source_label')

  const active = questions.filter((q) => q.is_active)
  ok(active.length === cfg!.item_count,
    `${cfg!.item_count} active questions`, `found ${active.length}`)

  const optsByQ = new Map<string, typeof options>()
  for (const o of options) {
    const arr = optsByQ.get(o.question_id) ?? []
    arr.push(o)
    optsByQ.set(o.question_id, arr)
  }

  const badCount = active.filter((q) => (optsByQ.get(q.id) ?? []).length !== 4)
  ok(badCount.length === 0, 'every question has exactly 4 options',
    badCount.map((q) => q.item_code).join(', '))

  const badCorrect = active.filter(
    (q) => (optsByQ.get(q.id) ?? []).filter((o) => o.is_correct).length !== 1)
  ok(badCorrect.length === 0, 'every question has exactly 1 correct option',
    badCorrect.map((q) => q.item_code).join(', '))

  const dupText = active.filter((q) => {
    const texts = (optsByQ.get(q.id) ?? []).map((o) => o.content.trim().toLowerCase())
    return new Set(texts).size !== texts.length
  })
  ok(dupText.length === 0, 'no duplicate option text within a question',
    dupText.map((q) => q.item_code).join(', '))

  ok(cfg!.pool_locked, 'the pool is LOCKED (required before real keys work)')

  // The defence exhibit: the source key was badly skewed.
  const srcDist: Record<string, number> = {}
  for (const o of options) {
    if (o.is_correct && o.source_label) srcDist[o.source_label] = (srcDist[o.source_label] ?? 0) + 1
  }
  console.log(`    ℹ source answer key was skewed: ${
    Object.entries(srcDist).sort().map(([k, v]) => `${k}=${v}`).join(' ')}`)

  // ---------------------------------------------------------------- keys ---
  section('PARTICIPANT KEYS')

  const keys = await fetchAll<{ id: string; key_code: string; codename: string; arm: string; block: number; is_test: boolean }>(
    'participant_keys', 'id, key_code, codename, arm, block, is_test')

  const real = keys.filter((k) => !k.is_test && k.block < 900)
  const demo = keys.filter((k) => k.block >= 900)
  const test = keys.filter((k) => k.is_test)

  console.log(`    ℹ ${real.length} real · ${test.length} test · ${demo.length} demo`)

  const t = real.filter((k) => k.arm === 'treatment').length
  const c = real.length - t
  ok(Math.abs(t - c) <= 1, `groups are balanced (treatment ${t}, control ${c})`,
    `difference of ${Math.abs(t - c)}`)

  const names = real.map((k) => k.codename.toLowerCase())
  ok(new Set(names).size === names.length, 'all codenames are unique')

  const piiNames = real.filter((k) => /@/.test(k.codename) || /\d{6,}/.test(k.codename))
  warn(piiNames.length === 0, piiNames.length === 0
    ? 'no codename looks identifying'
    : `codenames that may identify someone: ${piiNames.map((k) => k.codename).join(', ')}`)

  warn(demo.length === 0, demo.length === 0
    ? 'no demo/synthetic rows present'
    : `${demo.length} demo row(s) still present — run \`pnpm x demo:purge\` before fieldwork`)

  // ------------------------------------------------------------ sessions ---
  section('ATTEMPTS')

  const sessions = await fetchAll<{
    id: string; key_id: string; arm: string; answered_count: number; correct_count: number
    item_count: number; status: string; completed: boolean | null; finalized_at: string | null
    started_at: string; deadline_at: string; ended_at: string | null
    exposure_duration_sec: number | null; effort_duration_sec: number | null
    duration_censored: boolean | null; focus_loss_count: number; disqualified: boolean
  }>('sessions', 'id, key_id, arm, answered_count, correct_count, item_count, status, completed, finalized_at, started_at, deadline_at, ended_at, exposure_duration_sec, effort_duration_sec, duration_censored, focus_loss_count, disqualified')

  const keyById = new Map(keys.map((k) => [k.id, k]))
  const realSessions = sessions.filter((s) => {
    const k = keyById.get(s.key_id)
    return k && !k.is_test && k.block < 900
  })

  // Everything below audits STUDY data only. Pilot and synthetic rows are
  // scaffolding: the demo generator deliberately sets is_correct to hit a
  // target score rather than deriving it from the option chosen, so auditing
  // it would report failures that mean nothing about the real instrument.
  const studyIds = new Set(realSessions.map((s) => s.id))
  const scaffold = sessions.length - realSessions.length
  if (scaffold > 0) {
    console.log(`    ℹ ${scaffold} pilot/synthetic attempt(s) excluded from the checks below`)
  }

  console.log(`    ℹ ${realSessions.length} real attempt(s) of ${real.length} key(s) issued`)
  if (realSessions.length) {
    const done = realSessions.filter((s) => s.status === 'completed').length
    const out = realSessions.filter((s) => s.status === 'timed_out').length
    const live = realSessions.filter((s) => s.finalized_at === null).length
    console.log(`      completed ${done} · timed out ${out} · in progress ${live}`)
  }

  const armMismatch = realSessions.filter((s) => s.arm !== keyById.get(s.key_id)!.arm)
  ok(armMismatch.length === 0, 'session group matches the key it was issued under',
    `${armMismatch.length} mismatched`)

  const oneEach = new Set(realSessions.map((s) => s.key_id)).size === realSessions.length
  ok(oneEach, 'at most one attempt per key')

  // -------------------------------------------------------------- scoring --
  section('SCORING (independently recomputed)')

  const allSq = await fetchAll<{
    session_id: string; position: number; question_id: string; option_order: string[]
    answered_at: string | null; selected_option_id: string | null
    selected_slot: number | null; is_correct: boolean | null
  }>('session_questions',
    'session_id, position, question_id, option_order, answered_at, selected_option_id, selected_slot, is_correct')

  const sq = allSq.filter((r) => studyIds.has(r.session_id))

  const correctOptionOf = new Map<string, string>()
  for (const o of options) if (o.is_correct) correctOptionOf.set(o.question_id, o.id)

  const answered = sq.filter((r) => r.answered_at !== null)
  if (answered.length === 0) {
    console.log('    ℹ no real answers recorded yet — nothing to re-score')
  } else {
    console.log(`    ℹ re-scoring ${answered.length} answered item(s) independently`)
  }

  let wrongScore = 0
  let wrongSlot = 0
  let notInPlan = 0
  for (const r of answered) {
    const shouldBe = r.selected_option_id === correctOptionOf.get(r.question_id)
    if (shouldBe !== r.is_correct) wrongScore++
    if (!r.option_order.includes(r.selected_option_id!)) notInPlan++
    else if (r.option_order.indexOf(r.selected_option_id!) + 1 !== r.selected_slot) wrongSlot++
  }

  ok(wrongScore === 0, 'every stored is_correct matches the option flagged correct',
    `${wrongScore} mismatched`)
  ok(notInPlan === 0, 'every selected option was among the four shown',
    `${notInPlan} outside the plan`)
  ok(wrongSlot === 0, 'the recorded slot matches where the option actually rendered',
    `${wrongSlot} wrong`)

  // Counters must agree with the rows they summarise.
  const bySession = new Map<string, typeof sq>()
  for (const r of sq) {
    const arr = bySession.get(r.session_id) ?? []
    arr.push(r)
    bySession.set(r.session_id, arr)
  }

  let badAnswered = 0, badCorrect2 = 0, badPlanSize = 0, badForward = 0
  for (const s of realSessions) {
    const rows = bySession.get(s.id) ?? []
    if (rows.length !== s.item_count) badPlanSize++

    const a = rows.filter((r) => r.answered_at !== null)
    if (a.length !== s.answered_count) badAnswered++
    if (a.filter((r) => r.is_correct).length !== s.correct_count) badCorrect2++

    // Forward-only: the answered items must be exactly positions 1..n.
    const positions = a.map((r) => r.position).sort((x, y) => x - y)
    if (positions.some((p, i) => p !== i + 1)) badForward++
  }

  ok(badAnswered === 0, 'answered_count matches the answered rows', `${badAnswered} sessions off`)
  ok(badCorrect2 === 0, 'correct_count matches the correct rows', `${badCorrect2} sessions off`)
  ok(badPlanSize === 0, 'every attempt has a full question plan', `${badPlanSize} sessions off`)
  ok(badForward === 0, 'answers form an unbroken run from position 1', `${badForward} sessions off`)

  // ------------------------------------------------------- randomization ---
  section('RANDOMIZATION')

  let badPerm = 0, dupQ = 0
  for (const [sid, rows] of bySession) {
    if (!studyIds.has(sid)) continue
    const qs = rows.map((r) => r.question_id)
    if (new Set(qs).size !== qs.length) dupQ++
    for (const r of rows) {
      const expected = (optsByQ.get(r.question_id) ?? []).map((o) => o.id).sort()
      const got = [...r.option_order].sort()
      if (expected.length !== got.length || expected.some((x, i) => x !== got[i])) badPerm++
    }
  }
  ok(dupQ === 0, 'no question appears twice in one participant plan')
  ok(badPerm === 0, 'every option_order is a true permutation of that question')

  // The C-bias defence, measured on real data.
  const slots = [0, 0, 0, 0]
  for (const r of allSq) {   // the shuffler is the same code path for every plan
    const idx = r.option_order.indexOf(correctOptionOf.get(r.question_id)!)
    if (idx >= 0 && idx < 4) slots[idx]++
  }
  const total = slots.reduce((a, b) => a + b, 0)
  if (total > 0) {
    const pct = slots.map((s) => ((s / total) * 100).toFixed(1) + '%')
    console.log(`    ℹ correct answer landed in slots A/B/C/D: ${pct.join(' / ')}  (n=${total})`)
    const worst = Math.max(...slots.map((s) => Math.abs(s / total - 0.25)))
    ok(worst < 0.05, 'the correct answer is uniform across the four slots',
      `worst deviation ${(worst * 100).toFixed(1)}pp`)
  }

  // --------------------------------------------------------------- timing --
  section('TIMING AND DEPENDENT VARIABLES')

  const finalized = realSessions.filter((s) => s.finalized_at !== null)
  if (finalized.length === 0) {
    console.log('    ℹ no finalized real attempts yet')
  } else {
    const badExposure = finalized.filter(
      (s) => s.exposure_duration_sec === null
        || s.exposure_duration_sec < 0
        || s.exposure_duration_sec > cfg!.time_limit_sec)
    ok(badExposure.length === 0, `exposure duration within 0..${cfg!.time_limit_sec}s`,
      `${badExposure.length} out of range`)

    const badEnd = finalized.filter((s) => new Date(s.ended_at!) > new Date(s.deadline_at))
    ok(badEnd.length === 0, 'no attempt ended after its own deadline', `${badEnd.length} did`)

    const badCensor = finalized.filter((s) => s.duration_censored !== (s.completed === false))
    ok(badCensor.length === 0, 'the censoring flag matches completion', `${badCensor.length} off`)

    const timedOut = finalized.filter((s) => s.status === 'timed_out')
    const wrongCap = timedOut.filter((s) => s.exposure_duration_sec !== cfg!.time_limit_sec)
    ok(wrongCap.length === 0, 'timed-out attempts record the full time limit',
      `${wrongCap.length} do not`)
  }

  // --------------------------------------------------------------- survey --
  section('SURVEY AND ATTENTION')

  const surveys = await fetchAll<{ session_id: string }>('surveys', 'session_id')
  const finalizedIds = new Set(finalized.map((s) => s.id))
  const surveyed = surveys.filter((s) => finalizedIds.has(s.session_id)).length
  if (finalized.length) {
    console.log(`    ℹ ${surveyed} of ${finalized.length} finished participants completed the survey`)
  }
  const dq = realSessions.filter((s) => s.disqualified)
  console.log(`    ℹ ${dq.length} flagged for excessive tab-switching (excluded from prizes only)`)

  // --------------------------------------------------------------- result --
  const { data: pre } = await db.from('v_preflight_failures').select('*')
  section('PREFLIGHT VIEW')
  if (!pre?.length) { pass++; console.log('    ✔ clean') }
  else for (const f of pre) console.log(`    ✖ ${f.check_name}  ${JSON.stringify(f.detail)}`)

  console.log(`\n  ${'═'.repeat(56)}`)
  if (fails.length) {
    console.log(`  ✖ ${fails.length} FAILED · ${warns.length} warning(s) · ${pass} passed\n`)
    for (const f of fails) console.log(`     - ${f}`)
    console.log()
    process.exit(1)
  }
  console.log(`  ✔ ${pass} checks passed${warns.length ? ` · ${warns.length} warning(s)` : ''}\n`)
  for (const w of warns) console.log(`     ⚠ ${w}`)
  if (warns.length) console.log()
}

main().catch((e) => die('unexpected failure', e))
