/**
 * Small operational helpers. Safe: every destructive action here is scoped to
 * keys flagged is_test, so it can never touch real participant data.
 *
 *   node --env-file=.env.local scripts/dev-tools.ts <command>
 *
 *   keys              list the test keys and whether each has been used
 *   reset             wipe all TEST sessions so the test keys are fresh again
 *   timer <seconds>   change the time limit (use 120 to see the timeout screen)
 *   status            study configuration and live counts
 *   publish           make the leaderboard public (do this after fieldwork)
 *   unpublish         hide the leaderboard again
 *   lock              lock the item pool — REQUIRED before real keys work
 *   unlock            unlock the item pool (only before collection starts)
 *   withdraw <key>    delete one participant's data (right-to-withdraw)
 */

import { makeClient, die } from './lib/client.ts'

const db = makeClient()
const [cmd, arg] = process.argv.slice(2)

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await db.rpc(fn, args)
  if (error) die(`rpc ${fn} failed`, error)
  return data as T
}

async function keys() {
  const { data } = await db
    .from('participant_keys')
    .select('key_code, codename, arm, is_test')
    .eq('is_test', true)
    .order('arm')

  const { data: sessions } = await db
    .from('v_session_live')
    .select('key_id, live_status, answered_count')

  const { data: ids } = await db.from('participant_keys').select('id, key_code').eq('is_test', true)
  const byKey = new Map(ids!.map((k) => [k.key_code, k.id]))
  const byId = new Map((sessions ?? []).map((s) => [s.key_id, s]))

  for (const group of ['control', 'treatment'] as const) {
    console.log(`\n  ${group === 'control' ? 'NO PROGRESS BAR (control)' : 'WITH PROGRESS BAR (treatment)'}`)
    for (const k of data!.filter((x) => x.arm === group)) {
      const s = byId.get(byKey.get(k.key_code)!)
      const state = s ? `${s.live_status} (${s.answered_count} answered)` : 'unused'
      console.log(`    ${k.key_code}   ${k.codename.padEnd(22)} ${state}`)
    }
  }
  console.log()
}

async function status() {
  const { data: cfg } = await db.from('study_config').select('*').single()
  const { count: qCount } = await db.from('questions').select('id', { count: 'exact', head: true })
  const { count: realKeys } = await db
    .from('participant_keys').select('id', { count: 'exact', head: true }).eq('is_test', false)
  const { count: testKeys } = await db
    .from('participant_keys').select('id', { count: 'exact', head: true }).eq('is_test', true)
  const { data: pre } = await db.from('v_preflight_failures').select('*')

  console.log('\n  CONFIGURATION')
  console.log(`    time limit          ${cfg!.time_limit_sec}s (${(cfg!.time_limit_sec / 60).toFixed(0)} min)`)
  console.log(`    items expected      ${cfg!.item_count}`)
  console.log(`    pool locked         ${cfg!.pool_locked}${cfg!.pool_locked ? '' : '   <- real keys will NOT work'}`)
  console.log(`    leaderboard public  ${cfg!.leaderboard_public}`)
  console.log(`    focus-loss limit    ${cfg!.focus_loss_limit}`)
  console.log('\n  DATA')
  console.log(`    questions imported  ${qCount}`)
  console.log(`    real keys           ${realKeys}`)
  console.log(`    test keys           ${testKeys}`)
  console.log('\n  PREFLIGHT')
  if (!pre?.length) console.log('    ✔ clean — ready to collect')
  else for (const f of pre) console.log(`    ✖ ${f.check_name}  ${JSON.stringify(f.detail)}`)
  console.log()
}

async function main() {
  switch (cmd) {
    case 'keys':
      await keys()
      break

    case 'reset': {
      const n = await rpc<number>('purge_test_sessions')
      await db.from('browser_sessions').delete().neq('token_hash', '\\x00')
      console.log(`\n  ✔ wiped ${n} test session(s). All test keys are fresh again.`)
      console.log('    (Real participant data is untouched — this only targets is_test keys.)\n')
      break
    }

    case 'timer': {
      const secs = Number(arg)
      if (!Number.isInteger(secs) || secs < 10) die('usage: timer <seconds>, minimum 10')
      await db.from('study_config').update({ time_limit_sec: secs }).eq('id', true)
      console.log(`\n  ✔ time limit is now ${secs}s.`)
      if (secs !== 3600) console.log('    ⚠ REMEMBER to set this back to 3600 before the real study.\n')
      break
    }

    case 'status':
      await status()
      break

    case 'publish':
      await db.from('study_config').update({ leaderboard_public: true }).eq('id', true)
      console.log('\n  ✔ leaderboard is now PUBLIC.\n')
      break

    case 'unpublish':
      await db.from('study_config').update({ leaderboard_public: false }).eq('id', true)
      console.log('\n  ✔ leaderboard is hidden.\n')
      break

    case 'lock':
      await db.from('study_config')
        .update({ pool_locked: true, pool_locked_at: new Date().toISOString() }).eq('id', true)
      console.log('\n  ✔ item pool LOCKED. Questions can no longer be edited, and real keys now work.\n')
      break

    case 'unlock':
      await db.from('study_config').update({ pool_locked: false }).eq('id', true)
      console.log('\n  ✔ item pool unlocked. Do this only before collection starts.\n')
      break

    case 'show': {
      // Make one test key visible on the leaderboard / in the export.
      //
      // Every analysis view filters `is_test`, which is what stops pilot runs
      // contaminating the dataset — so a test key can only appear by being
      // temporarily un-flagged. It is also put in block 900 so
      // exp.purge_demo_data() will sweep it up with the rest of the demo rows,
      // and `hide` puts it back.
      if (!arg) die('usage: show <access-key>')
      const { error } = await db
        .from('participant_keys')
        .update({ is_test: false, block: 900 })
        .eq('key_code', arg.toUpperCase())
      if (error) die('could not update that key', error)
      console.log(`\n  ✔ ${arg} now appears on the leaderboard.`)
      console.log(`    Undo with:  pnpm x hide ${arg}\n`)
      break
    }

    case 'hide': {
      if (!arg) die('usage: hide <access-key>')
      const { error } = await db
        .from('participant_keys')
        .update({ is_test: true, block: 0 })
        .eq('key_code', arg.toUpperCase())
      if (error) die('could not update that key', error)
      console.log(`\n  ✔ ${arg} is a pilot key again and is excluded from all analysis views.\n`)
      break
    }

    case 'demo': {
      const n = Number(arg ?? 40)
      await rpc('purge_demo_data')
      const made = await rpc<number>('make_demo_data', { p_n: n })
      console.log(`\n  ✔ created ${made} synthetic participants (block 900).`)
      console.log('    ⚠ FAKE DATA. Remove before fieldwork with:  pnpm x demo:purge\n')
      break
    }

    case 'demo:purge': {
      const n = await rpc<number>('purge_demo_data')
      console.log(`\n  ✔ removed ${n} demo participant(s).\n`)
      break
    }

    case 'withdraw': {
      if (!arg) die('usage: withdraw <access-key>')
      const removed = await rpc<boolean>('purge_by_key', { p_key_code: arg })
      console.log(removed
        ? `\n  ✔ all data for ${arg} has been deleted. The key row is kept for the CONSORT count.\n`
        : `\n  ✖ no attempt found for ${arg}.\n`)
      break
    }

    default:
      console.log(`
  Usage: node --env-file=.env.local scripts/dev-tools.ts <command>

    keys              list test keys and whether each has been used
    reset             wipe all TEST sessions so the test keys are fresh
    timer <seconds>   change the time limit (120 to see the timeout screen)
    status            configuration, counts and preflight
    publish           make the leaderboard public (after fieldwork)
    unpublish         hide the leaderboard
    show <key>        make a TEST key appear on the leaderboard
    hide <key>        put it back to pilot-only
    demo [n]          create n synthetic participants (default 40)
    demo:purge        remove all synthetic participants
    lock              lock the item pool — REQUIRED before real keys work
    unlock            unlock the item pool
    withdraw <key>    delete one participant's data
`)
  }
}

main().catch((e) => die('unexpected failure', e))
