/**
 * The rules for turning form responses into access keys.
 *
 * Shared by the CLI (`pnpm issue`) and the dashboard, so the two can never
 * drift apart on something that matters — a key format, a collision rule, or
 * how groups are balanced.
 *
 * Pure: no database, no filesystem. Callers supply what already exists and
 * decide what to do with the plan.
 */

import { randomInt } from 'node:crypto'

/** Crockford-style: no 0/O, 1/I/L or U — the characters people mistype. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'
export const BLOCK_SIZE = 10 // 5 treatment + 5 control

export type FormRow = { email: string; codename: string }

export type PlannedKey = {
  email: string
  key_code: string
  codename: string
  arm: 'control' | 'treatment'
  block: number
}

export type IssuePlan = {
  records: PlannedKey[]
  /** Things that were handled automatically, worth telling the operator about. */
  notes: string[]
  /** Codenames that may identify a real person. Needs a human decision. */
  pii: { codename: string; email: string }[]
  skipped: number
}

export function makeKey(): string {
  const group = () =>
    Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')
  return `KQ-${group()}-${group()}`
}

/** Fisher–Yates over a CSPRNG. Unbiased, unlike sort(() => rand - 0.5). */
function shuffle<T>(input: readonly T[]): T[] {
  const out = [...input]
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * Continue blocked randomization from whatever has already been issued.
 *
 * Simple randomization only lands on 150/150 if everyone signs up at once.
 * People respond over days and keys go out in batches, so the split would
 * drift. Blocking keeps each completed group of ten at exactly 5 and 5, which
 * holds the balance at every point during recruitment.
 */
export function assignArms(
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

/**
 * A codename that would identify a real person once published.
 *
 * Codenames appear on the public leaderboard, so someone typing their email or
 * student number into that box quietly breaks the anonymity the consent form
 * promises. Detected, never silently rewritten — the participant should be
 * asked to choose again.
 */
export function looksIdentifying(codename: string): boolean {
  return /@/.test(codename) || /\d{6,}/.test(codename)
}

/**
 * Work out exactly what would be issued, without issuing anything.
 *
 * @param fresh        respondents who do not already hold a key
 * @param existingKeys every real key already in the database
 * @param takenKeyCodes every key code in the database, to avoid a collision
 */
export function planIssuance(
  fresh: FormRow[],
  existingKeys: { codename: string; arm: string; block: number }[],
  takenKeyCodes: Set<string>,
  skipped = 0,
): IssuePlan {
  const notes: string[] = []
  const pii: { codename: string; email: string }[] = []

  const takenNames = new Set(existingKeys.map((k) => k.codename.toLowerCase()))
  const resolved: FormRow[] = []

  for (const r of fresh) {
    let codename = r.codename.trim().slice(0, 24)

    if (!codename) {
      codename = `participant-${r.email.split('@')[0].slice(0, 8)}`
      notes.push(`${r.email}: no codename given — using "${codename}"`)
    }
    if (looksIdentifying(codename)) {
      pii.push({ codename, email: r.email })
    }

    // Two people may pick the same nickname. The second gets a suffix rather
    // than being rejected, because the database enforces uniqueness and a hard
    // failure here would block the whole batch.
    const wanted = codename
    let n = 2
    while (takenNames.has(codename.toLowerCase())) {
      codename = `${wanted}-${n++}`
    }
    if (codename !== wanted) {
      notes.push(`"${wanted}" was taken — issued as "${codename}"`)
    }
    takenNames.add(codename.toLowerCase())
    resolved.push({ email: r.email, codename })
  }

  const arms = assignArms(existingKeys, resolved.length)

  const keys: string[] = []
  const seen = new Set(takenKeyCodes)
  while (keys.length < resolved.length) {
    const k = makeKey()
    if (!seen.has(k)) {
      seen.add(k)
      keys.push(k)
    }
  }

  return {
    records: resolved.map((r, i) => ({
      email: r.email,
      key_code: keys[i],
      codename: r.codename,
      arm: arms[i].arm,
      block: arms[i].block,
    })),
    notes,
    pii,
    skipped,
  }
}

/** Normalize and de-duplicate rows straight out of a Google Forms export. */
export function normalizeRows(
  raw: Record<string, string>[],
  emailCol: string,
  codenameCol: string,
): { rows: FormRow[]; notes: string[] } {
  const notes: string[] = []
  const seen = new Set<string>()
  const rows: FormRow[] = []

  for (const [i, r] of raw.entries()) {
    const email = (r[emailCol] ?? '').trim().toLowerCase()
    const codename = (r[codenameCol] ?? '').trim()

    if (!email || !email.includes('@')) {
      notes.push(`row ${i + 2}: missing or malformed email — skipped`)
      continue
    }
    if (seen.has(email)) {
      notes.push(`row ${i + 2}: ${email} appears twice — keeping the first`)
      continue
    }
    seen.add(email)
    rows.push({ email, codename })
  }
  return { rows, notes }
}

/**
 * Google Forms uses the question text as the column header, so headers are long
 * and change whenever a question is reworded. Match on a substring instead.
 */
export function findColumn(
  headers: string[],
  needles: string[],
): string | null {
  for (const n of needles) {
    const hit = headers.find((h) => h.toLowerCase().includes(n))
    if (hit) return hit
  }
  return null
}

export const EMAIL_NEEDLES = ['username', 'email', 'e-mail']
export const CODENAME_NEEDLES = ['codename', 'code name']
