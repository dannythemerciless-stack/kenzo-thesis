/**
 * Setup doctor. Read-only.
 *
 *   pnpm x setup
 *
 * Walks the preconditions in order, stops at the first one that is not met,
 * and prints the exact command or dashboard step to fix it. Works on a
 * completely empty project, a half-configured one, or a live study.
 *
 * The point is that the workflow lives here rather than in a document that
 * quietly goes stale.
 */

import { existsSync, readFileSync } from 'node:fs'

const STEPS = 8
let step = 0

const head = (t: string) => {
  step++
  console.log(`\n  [${step}/${STEPS}] ${t}`)
}
const good = (m: string) => console.log(`        ✔ ${m}`)
const info = (m: string) => console.log(`          ${m}`)

function stop(problem: string, fix: string[]): never {
  console.log(`        ✖ ${problem}\n`)
  console.log('  ── DO THIS NEXT ──')
  for (const line of fix) console.log(`     ${line}`)
  console.log()
  process.exit(1)
}

function done(message: string): never {
  console.log(`\n  ${'═'.repeat(56)}`)
  console.log(`  ${message}\n`)
  process.exit(0)
}

async function main() {
  console.log('\n══ SETUP CHECK ══')

  // ---------------------------------------------------------------- 1 env --
  head('Environment file')

  if (!existsSync('.env.local')) {
    stop('.env.local is missing', [
      'cp .env.example .env.local',
      '',
      'Then fill in, from Supabase → Settings → API Keys:',
      '  SUPABASE_URL          https://<project-ref>.supabase.co',
      '  SUPABASE_SECRET_KEY   the sb_secret_… key (NOT the publishable one)',
      '',
      'And generate two of your own:',
      '  SESSION_PEPPER            $(openssl rand -hex 32)',
      '  RESEARCHER_EXPORT_TOKEN   $(openssl rand -hex 32)',
    ])
  }

  const envText = readFileSync('.env.local', 'utf8')
  const missing = (['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SESSION_PEPPER',
    'RESEARCHER_EXPORT_TOKEN'] as const)
    .filter((k) => {
      const m = envText.match(new RegExp(`^${k}=(.*)$`, 'm'))
      return !m || !m[1].trim() || m[1].includes('YOUR-PROJECT')
    })

  if (missing.length) {
    stop(`not filled in: ${missing.join(', ')}`, [
      'Edit .env.local. Values come from Supabase → Settings → API Keys.',
      'Use the SECRET key (sb_secret_…), not the publishable one.',
      '',
      'For the two you generate yourself:',
      '  openssl rand -hex 32',
    ])
  }
  good('all four variables are set')

  // Import lazily: the client exits if the env is bad, and we want our own
  // message above to be the one you see.
  const { makeClient } = await import('./lib/client.ts')
  const db = makeClient()

  // ------------------------------------------------------------ 2 connect --
  head('Connection to Supabase')

  const ping = await db.from('study_config').select('pool_locked').maybeSingle()

  if (ping.error) {
    const msg = ping.error.message.toLowerCase()
    if (msg.includes('schema') || ping.error.code === 'PGRST106') {
      stop('the `exp` schema is not exposed to the Data API', [
        'Supabase dashboard → Data API → Exposed schemas → tick `exp` → Save.',
        '',
        'PostgREST refuses to route to a schema that is not listed, no matter',
        'which key you use, so every call 404s until this is done.',
        '',
        'If `exp` is not in the dropdown, the schema does not exist yet —',
        'run step 3 first, then come back and expose it.',
      ])
    }
    if (msg.includes('does not exist') || msg.includes('relation')) {
      stop('the schema has not been applied', [
        'Supabase dashboard → SQL Editor → new query.',
        'Paste the whole of supabase/apply_all.sql → Run.',
        '',
        '  pbcopy < supabase/apply_all.sql        # puts it on your clipboard',
        '',
        'It starts with `drop schema if exists exp cascade`, so it is safe',
        'to re-run. Then: Data API → Exposed schemas → add `exp`.',
      ])
    }
    stop(`could not reach the database — ${ping.error.message}`, [
      'Check SUPABASE_URL and SUPABASE_SECRET_KEY in .env.local.',
      'The secret key starts with sb_secret_ (the publishable one will not work).',
    ])
  }

  if (!ping.data) {
    stop('the config row is missing', [
      'Re-apply the schema: paste supabase/apply_all.sql in the SQL Editor.',
    ])
  }
  good('connected, `exp` schema reachable')

  // ------------------------------------------------------------- 3 schema --
  head('Schema objects')

  for (const t of ['participant_keys', 'questions', 'question_options',
    'sessions', 'session_questions', 'surveys', 'browser_sessions']) {
    const r = await db.from(t).select('*', { count: 'exact', head: true })
    if (r.error) {
      stop(`table \`${t}\` is missing`, [
        'The schema is incomplete. Re-apply it:',
        '  pbcopy < supabase/apply_all.sql',
        'then paste into the Supabase SQL Editor and Run.',
      ])
    }
  }
  const views = await db.from('v_export_wide').select('*', { count: 'exact', head: true })
  if (views.error) {
    stop('the analysis views are missing', [
      'Re-apply supabase/apply_all.sql in the SQL Editor.',
    ])
  }
  good('all 9 tables and the analysis views exist')

  // ---------------------------------------------------------- 4 questions --
  head('Question pool')

  const { data: cfg } = await db.from('study_config').select('*').single()
  const { count: qCount } = await db
    .from('questions').select('id', { count: 'exact', head: true })

  if (!qCount) {
    stop('no questions imported', [
      'pnpm seed:questions',
      '',
      'Reads data/questions.csv (100 items, already in your repo).',
      'Edit that CSV if you want to change the quiz, then re-run with --reset.',
    ])
  }
  if (qCount !== cfg!.item_count) {
    stop(`${qCount} questions imported, but item_count is ${cfg!.item_count}`, [
      'pnpm seed:questions --reset',
    ])
  }
  good(`${qCount} questions imported${cfg!.pool_source_name ? ` from ${cfg!.pool_source_name}` : ''}`)

  // ------------------------------------------------------- 5 preflight ----
  head('Pool integrity')

  const { data: pre } = await db.from('v_preflight_failures').select('*')
  const blocking = (pre ?? []).filter((f) => f.check_name !== 'pool_not_locked'
    && f.check_name !== 'demo_rows_present')

  if (blocking.length) {
    stop(`preflight found ${blocking.length} problem(s)`, [
      ...blocking.map((f) => `${f.check_name}: ${JSON.stringify(f.detail)}`),
      '',
      'Run `pnpm x audit` for the detail.',
    ])
  }
  good('every question has 4 options and exactly 1 correct answer')

  // ------------------------------------------------------------ 6 pilot ---
  head('Pilot keys')

  const { count: testKeys } = await db
    .from('participant_keys').select('id', { count: 'exact', head: true }).eq('is_test', true)

  if (!testKeys) {
    stop('no pilot keys yet', [
      'pnpm seed:keys --count 10 --test',
      '',
      'Creates 10 keys flagged is_test, so anything you do with them is',
      'excluded from every analysis view and can never reach your dataset.',
    ])
  }
  good(`${testKeys} pilot key(s) — see them with \`pnpm x keys\``)

  // ------------------------------------------------------------- 7 lock ---
  head('Pool lock')

  if (!cfg!.pool_locked) {
    console.log('        ⚠ the pool is UNLOCKED — real keys will be refused')
    info('')
    info('That is correct while you are still piloting. When you are ready')
    info('to issue keys to actual participants:')
    info('')
    info('   pnpm x lock')
    info('')
    info('It freezes the questions so nobody can be answering a different')
    info('instrument halfway through fieldwork.')
  } else {
    good('pool is locked — real keys work, questions are frozen')
  }

  // ------------------------------------------------------- 8 cleanliness --
  head('Ready for real participants?')

  const { count: demoKeys } = await db
    .from('participant_keys').select('id', { count: 'exact', head: true }).gte('block', 900)
  const { count: realKeys } = await db
    .from('participant_keys').select('id', { count: 'exact', head: true })
    .eq('is_test', false).lt('block', 900)

  const blockers: string[] = []
  if (demoKeys) blockers.push(`${demoKeys} synthetic demo row(s)  →  pnpm x demo:purge`)
  if (!cfg!.pool_locked) blockers.push('pool is unlocked          →  pnpm x lock')
  if (cfg!.leaderboard_public) blockers.push('leaderboard is public     →  pnpm x unpublish')
  if (cfg!.time_limit_sec !== 3600) {
    blockers.push(`time limit is ${cfg!.time_limit_sec}s       →  pnpm x timer 3600`)
  }

  if (blockers.length) {
    console.log('        ⚠ not yet — fix these before issuing real keys:')
    info('')
    for (const b of blockers) info(`   ${b}`)
    info('')
    info(`   then:  pnpm x audit`)
    done('Setup is usable for piloting. See the list above before going live.')
  }

  good('no demo data, pool locked, leaderboard hidden, full time limit')
  info('')
  info(`   ${realKeys} real key(s) issued so far`)
  info('')
  info('   Issue more from your Google Form export:')
  info('     pnpm issue responses.csv --dry-run')
  info('     pnpm issue responses.csv')

  done('READY. This database can take real participants.')
}

main().catch((e) => {
  console.error('\n  unexpected failure:', e instanceof Error ? e.message : e)
  process.exit(1)
})
