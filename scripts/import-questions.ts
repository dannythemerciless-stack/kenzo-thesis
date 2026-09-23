/**
 * Import the 100-item question bank from data/questions.csv into Postgres.
 *
 *   node --env-file=.env.local scripts/import-questions.ts [--reset]
 *
 * The critical transformation: the CSV carries a `correct_letter` column, but
 * the letter is used ONLY to decide which option row gets `is_correct = true`.
 * It is then stored as `source_label` for audit purposes and never consulted by
 * scoring again. Combined with per-participant option shuffling, that is what
 * kills the all-C exploit in the source key.
 */

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { parse } from 'csv-parse/sync'
import { z } from 'zod'

import { makeClient, die } from './lib/client.ts'

const CSV_PATH = 'data/questions.csv'
const LETTERS = ['A', 'B', 'C', 'D'] as const

const RowSchema = z.object({
  ord: z.coerce.number().int().positive(),
  stem: z.string().trim().min(5),
  option_a: z.string().trim().min(1),
  option_b: z.string().trim().min(1),
  option_c: z.string().trim().min(1),
  option_d: z.string().trim().min(1),
  correct_letter: z.enum(LETTERS),
  topic: z.string().trim().default(''),
})

async function main() {
  const reset = process.argv.includes('--reset')
  const db = makeClient()

  // ---- read and validate -------------------------------------------------
  const raw = readFileSync(CSV_PATH)
  const fileSha = createHash('sha256').update(raw).digest('hex')

  // A hand-rolled split(',') corrupts stems containing commas, and a corrupted
  // question bank invalidates the instrument.
  const records = parse(raw, { columns: true, skip_empty_lines: true, trim: true })

  const parsed = z.array(RowSchema).safeParse(records)
  if (!parsed.success) {
    die('questions.csv failed validation', z.prettifyError(parsed.error))
  }
  const rows = parsed.data

  // ---- structural checks the database cannot make for us -----------------
  const problems: string[] = []

  const expected = await db.from('study_config').select('item_count').single()
  const itemCount = expected.data?.item_count ?? 100
  if (rows.length !== itemCount) {
    problems.push(`expected ${itemCount} rows, found ${rows.length}`)
  }

  const seenOrd = new Set<number>()
  for (const r of rows) {
    if (seenOrd.has(r.ord)) problems.push(`duplicate ord ${r.ord}`)
    seenOrd.add(r.ord)

    const options = [r.option_a, r.option_b, r.option_c, r.option_d]
    const normalized = options.map((o) => o.toLowerCase().trim())
    if (new Set(normalized).size !== 4) {
      // Two identical distractors would let a participant pick a "wrong"
      // option whose text equals the right answer.
      problems.push(`item ${r.ord} has duplicate option text`)
    }
  }

  if (problems.length) die('questions.csv has structural problems', problems.join('\n'))

  // ---- report the key bias (the reason option shuffling exists) ----------
  const dist = Object.fromEntries(LETTERS.map((L) => [L, 0])) as Record<string, number>
  for (const r of rows) dist[r.correct_letter]++
  console.log('\nSource answer-key distribution (this is why options are shuffled):')
  for (const L of LETTERS) {
    const pct = ((dist[L] / rows.length) * 100).toFixed(0)
    console.log(`  ${L}: ${String(dist[L]).padStart(3)}  ${'█'.repeat(dist[L])} ${pct}%`)
  }

  // ---- write -------------------------------------------------------------
  const { data: cfg } = await db.from('study_config').select('pool_locked').single()
  if (cfg?.pool_locked) {
    die('the item pool is LOCKED. Unlock it only if collection has not started:\n' +
        "  update exp.study_config set pool_locked = false;")
  }

  const { count: existing } = await db
    .from('questions')
    .select('id', { count: 'exact', head: true })

  if (existing && existing > 0) {
    if (!reset) {
      die(`${existing} questions already exist. Re-run with --reset to replace them.`)
    }
    console.log(`\nDeleting ${existing} existing questions…`)
    const { error } = await db.from('questions').delete().neq('item_code', '')
    if (error) die('failed to clear questions', error)
  }

  const questionRows = rows.map((r) => ({
    item_code: `Q${String(r.ord).padStart(3, '0')}`,
    stem: r.stem,
    topic: r.topic || null,
  }))

  const { data: inserted, error: qErr } = await db
    .from('questions')
    .insert(questionRows)
    .select('id, item_code')
  if (qErr) die('failed to insert questions', qErr)

  const byCode = new Map(inserted!.map((q) => [q.item_code, q.id]))

  const optionRows = rows.flatMap((r) => {
    const qid = byCode.get(`Q${String(r.ord).padStart(3, '0')}`)!
    const texts = [r.option_a, r.option_b, r.option_c, r.option_d]
    return texts.map((content, i) => ({
      question_id: qid,
      content,
      // The ONLY place the letter is used. After this it is audit data.
      is_correct: LETTERS[i] === r.correct_letter,
      source_label: LETTERS[i],
      source_ordinal: i + 1,
    }))
  })

  const { error: oErr } = await db.from('question_options').insert(optionRows)
  if (oErr) die('failed to insert options', oErr)

  // Provenance: which file produced this pool, and its hash.
  await db.from('study_config').update({
    pool_source_name: CSV_PATH,
    pool_source_sha256: `\\x${fileSha}`,
    pool_imported_at: new Date().toISOString(),
  }).eq('id', true)

  console.log(`\n✔ Imported ${rows.length} questions and ${optionRows.length} options.`)
  console.log(`  source sha256: ${fileSha}`)

  // ---- preflight ---------------------------------------------------------
  const { data: failures } = await db.from('v_preflight_failures').select('*')
  if (failures?.length) {
    console.log('\n⚠ Preflight is not clean yet:')
    for (const f of failures) console.log(`  - ${f.check_name}: ${JSON.stringify(f.detail)}`)
    console.log('\n  (pool_not_locked is expected until you lock the pool before go-live.)')
  } else {
    console.log('\n✔ Preflight clean.')
  }
}

main().catch((e) => die('unexpected failure', e))
