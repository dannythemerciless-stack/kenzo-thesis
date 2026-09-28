/**
 * Wipe all participant data and start over.
 *
 *   pnpm x wipe           shows what would go, then asks for confirmation
 *   pnpm x wipe --yes     skips the prompt
 *
 * Deletes:  sessions (and their answers, timings, surveys) + participant_keys
 *           + the out/issued.csv ledger
 * Keeps:    questions, options, and study_config
 *
 * Everything is written to out/backup-<timestamp>/ first, so a mis-click is
 * recoverable. It is not a database backup — it is a CSV snapshot good enough
 * to reconstruct what was lost.
 *
 * Why the ledger goes too: `pnpm issue` reads out/issued.csv to decide who
 * already has a key. Wipe the database but keep the ledger and the next issue
 * run quietly produces zero keys, because it thinks everyone already has one.
 * The two must always move together.
 */

import { createInterface } from 'node:readline/promises'
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'

import { makeClient, die } from './lib/client.ts'

const db = makeClient()
const skipPrompt = process.argv.includes('--yes')

function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return ''
  const headers = Object.keys(rows[0])
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return ''
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [headers.join(','), ...rows.map((r) => headers.map((h) => cell(r[h])).join(','))].join('\n')
}

/** PostgREST caps rows per request; page through. */
async function fetchAll(table: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(table).select('*').range(from, from + 999)
    if (error) die(`reading ${table} failed`, error)
    out.push(...((data ?? []) as Record<string, unknown>[]))
    if (!data || data.length < 1000) break
  }
  return out
}

async function main() {
  console.log('\n══ WIPE PARTICIPANT DATA ══')

  // ---- what is there ------------------------------------------------------
  const tables = ['participant_keys', 'sessions', 'session_questions', 'surveys'] as const
  const counts: Record<string, number> = {}

  for (const t of tables) {
    const { count, error } = await db.from(t).select('*', { count: 'exact', head: true })
    if (error) die(`could not read ${t}`, error)
    counts[t] = count ?? 0
  }

  const { count: qCount } = await db
    .from('questions').select('id', { count: 'exact', head: true })

  console.log('\n  WILL BE DELETED')
  console.log(`    participant_keys    ${String(counts.participant_keys).padStart(6)}   your keys and codenames`)
  console.log(`    sessions            ${String(counts.sessions).padStart(6)}   attempts: time, score, completion`)
  console.log(`    session_questions   ${String(counts.session_questions).padStart(6)}   their individual answers`)
  console.log(`    surveys             ${String(counts.surveys).padStart(6)}   post-quiz ratings`)
  const { readdirSync: rd } = await import('node:fs')
  const outFiles = existsSync('out')
    ? rd('out').filter((f) => f.endsWith('.csv') &&
        (f === 'issued.csv' || f === 'assignment.csv' || f.startsWith('mailmerge')))
    : []
  console.log(`    out/*.csv           ${String(outFiles.length).padStart(6)}   ledger, assignment and mail-merge files`)

  console.log('\n  WILL BE KEPT')
  console.log(`    questions           ${String(qCount ?? 0).padStart(6)}   your quiz — you do not need to re-import`)
  console.log('    study_config             1   lock / publish / timer settings')

  if (counts.participant_keys === 0 && counts.sessions === 0 && outFiles.length === 0) {
    console.log('\n  Nothing to wipe — the database is already empty.\n')
    return
  }

  // ---- confirm ------------------------------------------------------------
  if (!skipPrompt) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question('\n  Type WIPE to confirm: ')
    rl.close()
    if (answer.trim() !== 'WIPE') {
      console.log('\n  Cancelled. Nothing was deleted.\n')
      return
    }
  }

  // ---- back up ------------------------------------------------------------
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const dir = `out/backup-${stamp}`
  mkdirSync(dir, { recursive: true })

  console.log(`\n  Backing up to ${dir}/`)
  for (const t of tables) {
    const rows = await fetchAll(t)
    if (rows.length) {
      writeFileSync(`${dir}/${t}.csv`, toCsv(rows) + '\n')
      console.log(`    ${t}.csv  (${rows.length} rows)`)
    }
  }
  // Every generated file in out/ describes keys that are about to stop
  // existing. Leaving any behind means the next issue run reads a ledger that
  // disagrees with the database, or you mail from a file whose keys are dead.
  // They all move into the backup together.
  const { readdirSync, readFileSync } = await import('node:fs')
  const stale = readdirSync('out').filter(
    (f) =>
      f.endsWith('.csv') &&
      (f === 'issued.csv' || f === 'assignment.csv' || f.startsWith('mailmerge')),
  )
  for (const f of stale) {
    writeFileSync(`${dir}/${f}`, readFileSync(`out/${f}`))
    console.log(`    ${f}`)
  }

  // ---- delete -------------------------------------------------------------
  // Order matters: sessions.key_id has NO cascade, so a key with an attempt
  // cannot be deleted first — the foreign key refuses. Sessions go first, and
  // their answers, timings, surveys and cookies cascade away with them.
  console.log('\n  Deleting…')

  // PostgREST refuses an unfiltered DELETE, so filter on a value no row can
  // have. `neq` against the nil UUID matches everything.
  const NONE = '00000000-0000-0000-0000-000000000000'

  const s = await db.from('sessions').delete().neq('id', NONE)
  if (s.error) die('could not delete sessions', s.error)

  const k = await db.from('participant_keys').delete().neq('id', NONE)
  if (k.error) die('could not delete participant_keys', k.error)

  for (const f of stale) rmSync(`out/${f}`)

  // ---- verify -------------------------------------------------------------
  const after: Record<string, number> = {}
  for (const t of tables) {
    const { count } = await db.from(t).select('*', { count: 'exact', head: true })
    after[t] = count ?? 0
  }

  const leftovers = Object.entries(after).filter(([, n]) => n > 0)
  if (leftovers.length) {
    die('wipe did not fully clear', leftovers.map(([t, n]) => `${t}: ${n} left`).join('\n'))
  }

  const { count: qAfter } = await db
    .from('questions').select('id', { count: 'exact', head: true })

  console.log('    ✔ participant_keys, sessions, answers and surveys are gone')
  console.log(`    ✔ out/ cleared (${stale.length} file(s) moved to the backup)`)
  console.log(`    ✔ ${qAfter} questions untouched`)
  console.log(`\n  Backup kept at ${dir}/`)
  console.log('\n  NEXT')
  console.log('    pnpm seed:keys --count 10 --test        # pilot keys, if you want them')
  console.log('    pnpm issue <responses>.csv --dry-run    # then the real ones\n')
}

main().catch((e) => die('unexpected failure', e))
