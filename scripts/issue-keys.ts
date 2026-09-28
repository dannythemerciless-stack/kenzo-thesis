/**
 * Issue access keys from a Google Forms export.
 *
 *   node --env-file=.env.local scripts/issue-keys.ts <responses.csv> [--dry-run]
 *
 * Reads the sign-up sheet, assigns each new respondent to a group by blocked
 * randomization, generates a one-time key, writes it to the database, and
 * produces a mail-merge file.
 *
 * SAFE TO RE-RUN. Respondents who already hold a key are skipped, so you can
 * run it again each time more people sign up and only the new ones get keys.
 *
 * THE PII BOUNDARY, which is the whole point of this design:
 *
 *   out/issued.csv       email + codename + key        (no group)
 *   out/mailmerge-*.csv  email + codename + key        (no group)
 *   out/assignment.csv   key + codename + block + arm  (no email)
 *   the database         key + codename + block + arm  (no email, ever)
 *
 * Email and group assignment never appear in the same file. Whoever sends the
 * emails therefore cannot see who is in which group, and the database holds
 * nothing that identifies a person.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs'
import { randomInt, createHash, createHmac } from 'node:crypto'
import { parse } from 'csv-parse/sync'

import { makeClient, die } from './lib/client.ts'
import { shuffle } from '../lib/quiz/randomize.ts'

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ' // no 0/O, 1/I/L, U
const BLOCK_SIZE = 10 // 5 treatment + 5 control
const LEDGER = 'out/issued.csv'

/**
 * Must match lib/admin/auth.ts hashEmail() exactly, or the dashboard will not
 * recognise keys issued here and will hand the same person a second one.
 */
function hashEmail(email: string): string {
  const pepper = process.env.SESSION_PEPPER
  if (!pepper) die('SESSION_PEPPER is missing from .env.local')
  return `\\x${createHmac('sha256', pepper).update(email.trim().toLowerCase()).digest('hex')}`
}

type Respondent = { email: string; codename: string }

// ---------------------------------------------------------------------------
// Google Forms column names are long and change if the question is reworded,
// so match on substrings rather than exact headers.
// ---------------------------------------------------------------------------
function pickColumn(headers: string[], needles: string[], label: string): string {
  for (const n of needles) {
    const hit = headers.find((h) => h.toLowerCase().includes(n))
    if (hit) return hit
  }
  die(
    `could not find the ${label} column.\n  Looked for: ${needles.join(', ')}\n` +
      `  Columns present:\n${headers.map((h) => `    - ${h}`).join('\n')}`,
  )
}

function makeKey(): string {
  const grp = () =>
    Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')
  return `KQ-${grp()}-${grp()}`
}

function csvEscape(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

/**
 * Continue blocked randomization from whatever is already issued.
 *
 * Simple randomization only lands on 150/150 if everyone shows up; with
 * attrition it drifts. Blocking keeps the two groups balanced at every prefix
 * of the realized sample, which matters because keys go out in batches and
 * people respond over days.
 */
function assignArms(
  existing: { arm: string; block: number }[],
  n: number,
): { arm: 'control' | 'treatment'; block: number }[] {
  const byBlock = new Map<number, { t: number; c: number }>()
  for (const e of existing) {
    const b = byBlock.get(e.block) ?? { t: 0, c: 0 }
    if (e.arm === 'treatment') b.t++
    else b.c++
    byBlock.set(e.block, b)
  }

  const out: { arm: 'control' | 'treatment'; block: number }[] = []
  let block = 0

  while (out.length < n) {
    const used = byBlock.get(block) ?? { t: 0, c: 0 }
    const slots: ('control' | 'treatment')[] = [
      ...Array<'treatment'>(Math.max(0, BLOCK_SIZE / 2 - used.t)).fill('treatment'),
      ...Array<'control'>(Math.max(0, BLOCK_SIZE / 2 - used.c)).fill('control'),
    ]

    if (slots.length === 0) {
      block++
      continue
    }

    for (const arm of shuffle(slots)) {
      if (out.length >= n) break
      out.push({ arm, block })
    }
    block++
  }
  return out
}

async function main() {
  const csvPath = process.argv[2]
  const dryRun = process.argv.includes('--dry-run')
  if (!csvPath || csvPath.startsWith('--')) {
    die('usage: node --env-file=.env.local scripts/issue-keys.ts <responses.csv> [--dry-run]')
  }
  if (!existsSync(csvPath)) die(`file not found: ${csvPath}`)

  const db = makeClient()

  // ---- read the form export ----------------------------------------------
  const rows = parse(readFileSync(csvPath), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[]

  if (rows.length === 0) die('the CSV has no rows')

  const headers = Object.keys(rows[0])
  const emailCol = pickColumn(headers, ['username', 'email', 'e-mail'], 'email')
  const nameCol = pickColumn(headers, ['codename', 'code name'], 'codename')

  console.log(`\n  Reading ${csvPath}`)
  console.log(`    email column     "${emailCol}"`)
  console.log(`    codename column  "${nameCol}"`)
  console.log(`    responses        ${rows.length}`)

  // ---- normalize and de-duplicate within the file ------------------------
  const seenEmail = new Set<string>()
  const respondents: Respondent[] = []
  const problems: string[] = []

  for (const [i, r] of rows.entries()) {
    const email = (r[emailCol] ?? '').trim().toLowerCase()
    let codename = (r[nameCol] ?? '').trim()

    if (!email || !email.includes('@')) {
      problems.push(`row ${i + 2}: missing or malformed email — skipped`)
      continue
    }
    if (seenEmail.has(email)) {
      problems.push(`row ${i + 2}: ${email} appears twice in the file — keeping the first`)
      continue
    }
    seenEmail.add(email)

    if (!codename) {
      codename = `participant-${email.split('@')[0].slice(0, 8)}`
      problems.push(`row ${i + 2}: no codename given — generated "${codename}"`)
    }
    respondents.push({ email, codename })
  }

  // ---- who already has a key? --------------------------------------------
  if (!existsSync('out')) mkdirSync('out')

  const ledger = existsSync(LEDGER)
    ? (parse(readFileSync(LEDGER), { columns: true, skip_empty_lines: true }) as Record<
        string,
        string
      >[])
    : []
  const alreadyIssued = new Set(ledger.map((r) => r.email.toLowerCase()))

  // Keys issued before email_hash existed have none, which makes them
  // invisible to the dashboard's de-duplication. The ledger still has their
  // addresses, so fill them in on the way past.
  const { data: unhashed } = await db
    .from('participant_keys')
    .select('key_code')
    .is('email_hash', null)
    .eq('is_test', false)

  if (unhashed?.length) {
    let filled = 0
    for (const row of unhashed) {
      const entry = ledger.find((l) => l.key === row.key_code)
      if (!entry) continue
      const { error } = await db
        .from('participant_keys')
        .update({ email_hash: hashEmail(entry.email) })
        .eq('key_code', row.key_code)
      if (!error) filled++
    }
    if (filled) console.log(`\n  (filled in the email marker for ${filled} older key(s))`)
  }

  const fresh = respondents.filter((r) => !alreadyIssued.has(r.email))

  console.log(`    already issued   ${respondents.length - fresh.length}`)
  console.log(`    NEW this run     ${fresh.length}`)

  if (fresh.length === 0) {
    console.log('\n  Nothing to do — every respondent already holds a key.\n')
    return
  }

  // ---- codenames: collisions and accidental PII --------------------------
  const { data: existingKeys } = await db
    .from('participant_keys')
    .select('codename, arm, block')
    .lt('block', 900) // exclude demo rows
    .eq('is_test', false)

  const takenNames = new Set((existingKeys ?? []).map((k) => k.codename.toLowerCase()))
  const pii: string[] = []

  for (const r of fresh) {
    // A codename is published on the leaderboard. If someone types their real
    // name or email into that box, the anonymity claim quietly breaks.
    if (/@/.test(r.codename) || /\d{6,}/.test(r.codename)) {
      pii.push(`"${r.codename}" (${r.email}) — looks like an email or an ID number`)
    }
    if (r.codename.length > 24) {
      r.codename = r.codename.slice(0, 24)
    }

    let candidate = r.codename
    let n = 2
    while (takenNames.has(candidate.toLowerCase())) {
      candidate = `${r.codename}-${n++}`
    }
    if (candidate !== r.codename) {
      problems.push(`codename "${r.codename}" was taken — issued as "${candidate}"`)
      r.codename = candidate
    }
    takenNames.add(candidate.toLowerCase())
  }

  // ---- assign groups, continuing the existing blocks ---------------------
  const arms = assignArms(existingKeys ?? [], fresh.length)

  // ---- unique keys --------------------------------------------------------
  const { data: allKeys } = await db.from('participant_keys').select('key_code')
  const takenKeys = new Set((allKeys ?? []).map((k) => k.key_code))
  const keys: string[] = []
  while (keys.length < fresh.length) {
    const k = makeKey()
    if (!takenKeys.has(k)) {
      takenKeys.add(k)
      keys.push(k)
    }
  }

  const records = fresh.map((r, i) => ({
    email: r.email,
    key_code: keys[i],
    codename: r.codename,
    arm: arms[i].arm,
    block: arms[i].block,
    is_test: false,
  }))

  // ---- report -------------------------------------------------------------
  if (problems.length) {
    console.log('\n  NOTES')
    for (const p of problems) console.log(`    · ${p}`)
  }
  if (pii.length) {
    console.log('\n  ⚠ CODENAMES THAT MAY IDENTIFY SOMEONE')
    console.log('    These get published on the leaderboard. Consider asking')
    console.log('    these participants to pick a different one.')
    for (const p of pii) console.log(`    · ${p}`)
  }

  const t = records.filter((r) => r.arm === 'treatment').length
  console.log('\n  THIS BATCH')
  console.log(`    treatment (progress bar)  ${t}`)
  console.log(`    control   (no bar)        ${records.length - t}`)

  const totalT = (existingKeys ?? []).filter((k) => k.arm === 'treatment').length + t
  const totalC = (existingKeys ?? []).length - (existingKeys ?? []).filter((k) => k.arm === 'treatment').length
                 + (records.length - t)
  console.log('\n  RUNNING TOTAL')
  console.log(`    treatment  ${totalT}`)
  console.log(`    control    ${totalC}`)

  if (dryRun) {
    console.log('\n  --dry-run: nothing written.\n')
    console.log('  sample of what would be issued:')
    for (const r of records.slice(0, 3)) {
      console.log(`    ${r.email.padEnd(28)} ${r.key_code}  ${r.codename}`)
    }
    console.log()
    return
  }

  // ---- write --------------------------------------------------------------
  const { error } = await db.from('participant_keys').insert(
    records.map(({ email, ...row }) => ({
      ...row,
      // The address itself never reaches the database — only a one-way HMAC,
      // so the dashboard can tell who already holds a key.
      email_hash: hashEmail(email),
    })),
  )
  if (error) die('failed to insert keys', error)

  // Ledger: email + key, NO group. Used to skip people on the next run.
  if (!existsSync(LEDGER)) {
    writeFileSync(LEDGER, 'email,codename,key,issued_at\n')
  }
  const now = new Date().toISOString()
  appendFileSync(
    LEDGER,
    records
      .map((r) => `${csvEscape(r.email)},${csvEscape(r.codename)},${csvEscape(r.key_code)},${now}`)
      .join('\n') + '\n',
  )

  // Mail merge for THIS batch only. No group column, so whoever sends the
  // emails stays blind to the assignment.
  const stamp = now.slice(0, 19).replace(/[:T]/g, '-')
  const mailmerge = `out/mailmerge-${stamp}.csv`
  writeFileSync(
    mailmerge,
    'email,codename,key\n' +
      records
        .map((r) => `${csvEscape(r.email)},${csvEscape(r.codename)},${csvEscape(r.key_code)}`)
        .join('\n') + '\n',
  )

  // Assignment file for analysis. No email.
  const { data: everyKey } = await db
    .from('participant_keys')
    .select('key_code, codename, block, arm')
    .lt('block', 900)
    .eq('is_test', false)
    .order('codename')

  const assignment =
    'key,codename,block,arm,treatment\n' +
    (everyKey ?? [])
      .map(
        (k) =>
          `${csvEscape(k.key_code)},${csvEscape(k.codename)},${k.block},${k.arm},` +
          `${k.arm === 'treatment' ? 1 : 0}`,
      )
      .join('\n') + '\n'
  writeFileSync('out/assignment.csv', assignment)

  console.log('\n  ✔ WRITTEN')
  console.log(`    ${mailmerge}      <- mail merge from this (email, codename, key)`)
  console.log(`    ${LEDGER}              <- running ledger, so re-runs skip these people`)
  console.log('    out/assignment.csv         <- key -> group, for analysis (no email)')
  console.log(`\n    assignment.csv sha256:`)
  console.log(`    ${createHash('sha256').update(assignment).digest('hex')}`)
  console.log('\n    Commit that hash (not the file) each time you issue a batch.')
  console.log('    It is your proof that group assignment was fixed in advance.\n')
}

main().catch((e) => die('unexpected failure', e))
