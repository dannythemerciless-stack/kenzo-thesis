/**
 * End-to-end verification against the REAL Supabase project.
 *
 *   node --env-file=.env.local scripts/e2e.ts
 *
 * Drives the same RPCs the Next.js server calls, in the same order, using the
 * test keys (is_test = true, excluded from every export view). Re-runnable:
 * it resets its own sessions first.
 *
 * This is the check that the deployed database behaves like the Docker one.
 */

import { createHash, randomUUID } from 'node:crypto'

import { makeClient, die } from './lib/client.ts'
import { buildPlan, planHashBytea, type PoolQuestion } from '../lib/quiz/randomize.ts'

const db = makeClient()

let passed = 0
const failures: string[] = []

function ok(cond: boolean, name: string) {
  if (cond) {
    passed++
    console.log(`  ✔ ${name}`)
  } else {
    failures.push(name)
    console.log(`  ✖ ${name}`)
  }
}

function tokenFor(label: string): string {
  return `\\x${createHash('sha256').update(`e2e-${label}`).digest('hex')}`
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args)
  if (error) die(`rpc ${fn} failed`, error)
  return data as T
}

async function pool(): Promise<PoolQuestion[]> {
  const { data, error } = await db
    .from('questions')
    .select('id, question_options(id)')
    .eq('is_active', true)
  if (error) die('failed to read pool', error)
  return data!.map((q) => ({
    id: q.id as string,
    optionIds: (q.question_options as { id: string }[]).map((o) => o.id),
  }))
}

/** Answer the current item correctly; returns the next payload. */
async function answerCorrectly(token: string, item: Record<string, unknown>) {
  const nonce = item.nonce as string
  const { data: sq } = await db
    .from('session_questions')
    .select('question_id')
    .eq('serve_nonce', nonce)
    .single()

  const { data: correct } = await db
    .from('question_options')
    .select('id')
    .eq('question_id', sq!.question_id)
    .eq('is_correct', true)
    .single()

  return rpc<Record<string, unknown>>('submit_answer', {
    p_token_hash: token,
    p_nonce: nonce,
    p_option_id: correct!.id,
    p_client_at: new Date().toISOString(),
    p_hidden_ms: 0,
  })
}

async function main() {
  console.log('\n── resetting test sessions ──')
  const { data: testKeys } = await db
    .from('participant_keys')
    .select('id, key_code, codename, arm')
    .eq('is_test', true)

  if (!testKeys?.length) die('No test keys found. Run: pnpm seed:keys --count 10 --test')

  // Sessions cannot be deleted casually — the cascade would hit the append-only
  // event log. purge_test_sessions() is the sanctioned path and touches only
  // keys flagged is_test.
  const wiped = await rpc<number>('purge_test_sessions', {})
  await db.from('browser_sessions').delete().in('key_id', testKeys.map((k) => k.id))
  console.log(`  purged ${wiped} stale test session(s)`)

  const control = testKeys.find((k) => k.arm === 'control')!
  const treatment = testKeys.find((k) => k.arm === 'treatment')!
  const expiring = testKeys.filter((k) => k.arm === 'control')[1]!

  // ─────────────────────────────────────────────────────────────────────
  console.log('\n── key entry ──')

  const bad = await rpc<{ ok: boolean; reason: string }>('redeem_key', {
    p_key_code: 'KQ-XXXX-XXXX',
    p_token_hash: tokenFor('bad'),
    p_ttl_sec: 3600,
  })
  ok(bad.ok === false && bad.reason === 'invalid', 'an unknown key is rejected')

  const tC = tokenFor('control')
  const red = await rpc<{ ok: boolean; codename: string; hasAttempt: boolean }>(
    'redeem_key',
    // lower case, no dashes — normalization must still find it
    { p_key_code: control.key_code.toLowerCase().replace(/-/g, ''), p_token_hash: tC, p_ttl_sec: 3600 },
  )
  ok(red.ok && red.codename === control.codename, 'a valid key is accepted, normalized')
  ok(red.hasAttempt === false, 'key entry does NOT start the clock')

  const stateBefore = await rpc<{ state: string }>('resolve_session', { p_token_hash: tC })
  ok(stateBefore.state === 'consent', 'the participant is routed to consent first')

  // ─────────────────────────────────────────────────────────────────────
  console.log('\n── consent: the clock starts ──')

  const p = await pool()
  ok(p.length === 100, `the pool has 100 items (got ${p.length})`)

  const planC = buildPlan(p)
  const begun = await rpc<{ ok: boolean }>('begin_attempt', {
    p_token_hash: tC,
    p_plan: planC,
    p_plan_sha256: planHashBytea(planC),
    p_ua_family: 'e2e',
  })
  ok(begun.ok, 'begin_attempt accepts a Node-generated plan (hash verified in SQL)')

  const badHash = await db.rpc('begin_attempt', {
    p_token_hash: tokenFor('nonexistent'),
    p_plan: planC,
    p_plan_sha256: '\\xdeadbeef',
  })
  ok(badHash.data?.ok === false, 'begin_attempt refuses a token with no browser session')

  // ─────────────────────────────────────────────────────────────────────
  console.log('\n── blinding ──')

  const itemC = await rpc<Record<string, unknown>>('get_current_item', { p_token_hash: tC })
  ok(!('answeredCount' in itemC) && !('totalCount' in itemC),
    'CONTROL payload carries no progress fields')
  ok(!('position' in itemC), 'CONTROL payload carries no position')
  ok(!JSON.stringify(itemC).includes('is_correct'), 'the payload never leaks the answer key')
  ok((itemC.options as unknown[]).length === 4, 'four options are served')

  const tT = tokenFor('treatment')
  await rpc('redeem_key', { p_key_code: treatment.key_code, p_token_hash: tT, p_ttl_sec: 3600 })
  const planT = buildPlan(p)
  await rpc('begin_attempt', {
    p_token_hash: tT, p_plan: planT, p_plan_sha256: planHashBytea(planT), p_ua_family: 'e2e',
  })
  const itemT = await rpc<Record<string, unknown>>('get_current_item', { p_token_hash: tT })
  ok(itemT.totalCount === 100 && itemT.answeredCount === 0,
    'TREATMENT payload does carry progress')

  // ─────────────────────────────────────────────────────────────────────
  console.log('\n── answering ──')

  let cur = await answerCorrectly(tC, itemC)
  ok('nonce' in cur, 'the next item rides back in the submit response')

  const { data: s1 } = await db.from('sessions').select('correct_count, answered_count')
    .eq('key_id', control.id).single()
  ok(s1!.correct_count === 1 && s1!.answered_count === 1,
    'a correct answer scored, by option identity')

  // Replay the first answer: must be idempotent.
  const { data: firstAnswered } = await db
    .from('session_questions')
    .select('serve_nonce, selected_option_id')
    .eq('session_id', (await db.from('sessions').select('id').eq('key_id', control.id).single()).data!.id)
    .not('answered_at', 'is', null)
    .limit(1).single()

  await rpc('submit_answer', {
    p_token_hash: tC,
    p_nonce: firstAnswered!.serve_nonce,
    p_option_id: firstAnswered!.selected_option_id,
  })
  const { data: s2 } = await db.from('sessions').select('answered_count')
    .eq('key_id', control.id).single()
  ok(s2!.answered_count === 1, 'replaying the same answer does not double count')

  const stale = await rpc<Record<string, unknown>>('submit_answer', {
    p_token_hash: tC, p_nonce: randomUUID(), p_option_id: (itemC.options as {id:string}[])[0].id,
  })
  ok(stale.resync === true, 'a forged nonce triggers a clean resync')
  ok(stale.nonce !== cur.nonce,
    'the serve nonce rotates, so the pre-resync nonce is now dead')

  // Adopt the resynced payload: the previous nonce is no longer valid, which
  // is exactly the replay protection working.
  cur = stale

  // Answer 9 more so we have a pace trail.
  for (let i = 0; i < 9; i++) cur = await answerCorrectly(tC, cur)
  const { data: s3 } = await db.from('sessions').select('answered_count, correct_count')
    .eq('key_id', control.id).single()
  ok(s3!.answered_count === 10 && s3!.correct_count === 10, 'ten correct answers recorded')

  // ─────────────────────────────────────────────────────────────────────
  console.log('\n── option-slot uniformity (the C-bias defense, live data) ──')

  const { data: slots } = await db
    .from('session_questions')
    .select('option_order, question_id')
    .limit(200)

  const { data: allCorrect } = await db
    .from('question_options').select('id, question_id').eq('is_correct', true)
  const correctByQ = new Map(allCorrect!.map((o) => [o.question_id, o.id]))

  const dist = [0, 0, 0, 0]
  for (const row of slots ?? []) {
    const idx = (row.option_order as string[]).indexOf(correctByQ.get(row.question_id)!)
    if (idx >= 0) dist[idx]++
  }
  const total = dist.reduce((a, b) => a + b, 0)
  const pct = dist.map((d) => ((d / total) * 100).toFixed(0) + '%')
  console.log(`     correct answer landed in slots A/B/C/D: ${pct.join(' / ')} (n=${total})`)
  ok(dist.every((d) => d / total > 0.15 && d / total < 0.35),
    'the correct answer is spread across all four slots, not concentrated in C')

  // ─────────────────────────────────────────────────────────────────────
  console.log('\n── resume in a different browser ──')

  const tC2 = tokenFor('control-second-browser')
  const { data: before } = await db.from('sessions').select('deadline_at, answered_count')
    .eq('key_id', control.id).single()

  const resumed = await rpc<{ ok: boolean; hasAttempt: boolean; status: string }>('redeem_key', {
    p_key_code: control.key_code, p_token_hash: tC2, p_ttl_sec: 3600,
  })
  ok(resumed.hasAttempt && resumed.status === 'in_progress', 'the same key resumes the attempt')

  const { data: after } = await db.from('sessions').select('deadline_at, answered_count')
    .eq('key_id', control.id).single()
  ok(after!.deadline_at === before!.deadline_at,
    'the deadline is UNCHANGED — no time is given back')
  ok(after!.answered_count === 10, 'progress is preserved across browsers')

  const oldTokenItem = await rpc<Record<string, unknown>>('get_current_item', { p_token_hash: tC })
  ok(oldTokenItem.terminal === 'no_session',
    'the abandoned browser is logged out — exactly one live session per key')

  const newItem = await rpc<Record<string, unknown>>('get_current_item', { p_token_hash: tC2 })
  ok('nonce' in newItem, 'the new browser continues where the old one stopped')

  // ─────────────────────────────────────────────────────────────────────
  console.log('\n── focus loss is silent ──')

  await db.from('study_config').update({ focus_debounce_ms: 0 }).eq('id', true)
  for (let i = 0; i < 6; i++) {
    await rpc('record_focus_loss', { p_token_hash: tC2, p_dedupe_key: randomUUID() })
  }
  await db.from('study_config').update({ focus_debounce_ms: 1000 }).eq('id', true)

  const { data: dq } = await db.from('sessions')
    .select('focus_loss_count, disqualified, status').eq('key_id', control.id).single()
  ok(dq!.focus_loss_count >= 5, 'focus losses accumulate server-side')
  ok(dq!.disqualified === true, 'the disqualified flag is set')
  ok(dq!.status === 'in_progress', 'the attempt continues — nothing is shown to the participant')

  const stillWorks = await rpc<Record<string, unknown>>('get_current_item', { p_token_hash: tC2 })
  ok('nonce' in stillWorks, 'a disqualified participant can still answer normally')

  // ─────────────────────────────────────────────────────────────────────
  console.log('\n── expiry while the tab is closed ──')

  const tE = tokenFor('expiring')
  await rpc('redeem_key', { p_key_code: expiring.key_code, p_token_hash: tE, p_ttl_sec: 3600 })
  const planE = buildPlan(p)
  await rpc('begin_attempt', {
    p_token_hash: tE, p_plan: planE, p_plan_sha256: planHashBytea(planE), p_ua_family: 'e2e',
  })
  const itemE = await rpc<Record<string, unknown>>('get_current_item', { p_token_hash: tE })
  await answerCorrectly(tE, itemE)

  // Backdate as though they started 3 days ago and walked away after 10 min.
  const startedAt = new Date(Date.now() - 3 * 86400_000)
  const deadline = new Date(startedAt.getTime() + 3600_000)
  const lastAnswer = new Date(startedAt.getTime() + 600_000)
  await db.from('sessions').update({
    started_at: startedAt.toISOString(),
    deadline_at: deadline.toISOString(),
    first_answer_at: lastAnswer.toISOString(),
    last_answer_at: lastAnswer.toISOString(),
  }).eq('key_id', expiring.id)

  const { data: live } = await db.from('v_session_live')
    .select('live_status').eq('key_id', expiring.id).single()
  ok(live!.live_status === 'timed_out', 'v_session_live reports timed_out before any sweep runs')

  const reEntry = await rpc<{ status: string }>('redeem_key', {
    p_key_code: expiring.key_code, p_token_hash: tokenFor('expiring-return'), p_ttl_sec: 3600,
  })
  ok(reEntry.status === 'timed_out', 'returning after expiry finalizes rather than serving item 2')

  const { data: fin } = await db.from('sessions')
    .select('status, completed, ended_at, deadline_at, exposure_duration_sec, effort_duration_sec, duration_censored')
    .eq('key_id', expiring.id).single()

  ok(fin!.exposure_duration_sec === 3600,
    `exposure = the time LIMIT, not the 3-day lag (got ${fin!.exposure_duration_sec})`)
  ok(fin!.effort_duration_sec === 600,
    `effort = time to last answer (got ${fin!.effort_duration_sec})`)
  ok(fin!.ended_at === fin!.deadline_at, 'ended_at is the deadline, not the finalization moment')
  ok(fin!.duration_censored === true, 'the censoring indicator is set')
  ok(fin!.completed === false, 'DV1 completed = 0')

  const afterEnd = await rpc<Record<string, unknown>>('get_current_item', {
    p_token_hash: tokenFor('expiring-return'),
  })
  ok(afterEnd.terminal === 'timed_out', 'no further questions are served after expiry')

  // ─────────────────────────────────────────────────────────────────────
  console.log('\n── survey and debrief ──')

  const tR = tokenFor('expiring-return')
  const st = await rpc<{ state: string }>('resolve_session', { p_token_hash: tR })
  ok(st.state === 'survey', 'a timed-out participant is routed to the survey')

  await rpc('submit_survey', {
    p_token_hash: tR,
    p_likert: [4, 5, 3, 4, 5],
    p_considers: [true, false, true, false, false],
    p_heard: false,
  })
  const st2 = await rpc<{ state: string }>('resolve_session', { p_token_hash: tR })
  ok(st2.state === 'debrief', 'after the survey they go to the debrief')

  await rpc('mark_debriefed', { p_token_hash: tR })
  const { data: deb } = await db.from('sessions').select('debriefed_at').eq('key_id', expiring.id).single()
  ok(deb!.debriefed_at !== null, 'the debrief view is recorded')

  // ─────────────────────────────────────────────────────────────────────
  console.log('\n── export ──')

  const { data: wide } = await db.from('v_export_wide').select('*')
  ok((wide?.length ?? 0) === 0, 'test keys are excluded from the export (0 real rows)')

  const { data: timing } = await db.from('v_item_timing').select('*').limit(5)
  ok((timing?.length ?? 0) === 0, 'test keys are excluded from the timing view too')

  const { data: bias } = await db.from('v_source_key_bias').select('*')
  console.log('     source key bias (for the defense exhibit):',
    bias?.map((b) => `${b.source_label}=${b.n_correct}`).join(' '))
  ok((bias?.length ?? 0) > 0, 'the source-key-bias exhibit is queryable')

  // ─────────────────────────────────────────────────────────────────────
  console.log('\n── cleanup ──')
  const removed = await rpc<number>('purge_test_sessions', {})
  await db.from('browser_sessions').delete().in('key_id', testKeys.map((k) => k.id))
  console.log(`  removed ${removed} test session(s)`)

  console.log(`\n${'─'.repeat(60)}`)
  if (failures.length) {
    console.log(`✖ ${failures.length} FAILED, ${passed} passed`)
    for (const f of failures) console.log(`   - ${f}`)
    process.exit(1)
  }
  console.log(`✔ all ${passed} end-to-end checks passed against the live database`)
}

main().catch((e) => die('unexpected failure', e))
