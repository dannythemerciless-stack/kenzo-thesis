'use server'

import { revalidatePath } from 'next/cache'
import { parse } from 'csv-parse/sync'

import { db, rpc } from '@/lib/supabase/admin'
import {
  checkAdminKey, startAdminSession, endAdminSession, requireAdmin, hashEmail,
} from '@/lib/admin/auth'
import {
  planIssuance, normalizeRows, findColumn, EMAIL_NEEDLES, CODENAME_NEEDLES,
  type IssuePlan,
} from '@/lib/keys/issue'

export type LoginState = { error?: string }

export async function login(_prev: LoginState, form: FormData): Promise<LoginState> {
  const key = String(form.get('key') ?? '')
  if (!checkAdminKey(key)) {
    // Deliberately vague, and no hint about whether ADMIN_KEY is even set.
    return { error: 'Incorrect key.' }
  }
  await startAdminSession()
  revalidatePath('/admin')
  return {}
}

export async function logout(): Promise<void> {
  await endAdminSession()
  revalidatePath('/admin')
}

// ---------------------------------------------------------------- switches ---

export async function setPoolLocked(locked: boolean): Promise<void> {
  await requireAdmin()
  await db.from('study_config')
    .update({ pool_locked: locked, pool_locked_at: locked ? new Date().toISOString() : null })
    .eq('id', true)
  revalidatePath('/admin')
}

export async function setLeaderboardPublic(isPublic: boolean): Promise<void> {
  await requireAdmin()
  await db.from('study_config').update({ leaderboard_public: isPublic }).eq('id', true)
  revalidatePath('/admin')
  revalidatePath('/leaderboard')
}

// -------------------------------------------------------------- withdrawal ---

export async function withdrawParticipant(keyCode: string): Promise<{ ok: boolean; message: string }> {
  await requireAdmin()
  const removed = await rpc<boolean>('purge_by_key', { p_key_code: keyCode.trim() })
  revalidatePath('/admin')
  return removed
    ? { ok: true, message: `Deleted all data for ${keyCode}. The key row is kept so the participant count still adds up.` }
    : { ok: false, message: `No attempt found for ${keyCode}.` }
}

// ------------------------------------------------------------ issuing keys ---

export type IssuePreview = {
  ok: boolean
  error?: string
  emailColumn?: string
  codenameColumn?: string
  totalRows?: number
  alreadyIssued?: number
  plan?: IssuePlan
  /** The plan, signed back to the client so Confirm issues exactly what was shown. */
  token?: string
}

/** Read the upload and work out what would happen. Writes nothing. */
export async function previewIssue(form: FormData): Promise<IssuePreview> {
  await requireAdmin()

  const file = form.get('file')
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: 'Choose a CSV file first.' }
  }
  if (file.size > 5_000_000) {
    return { ok: false, error: 'That file is unusually large for a form export. Check it is the right one.' }
  }

  let raw: Record<string, string>[]
  try {
    raw = parse(Buffer.from(await file.arrayBuffer()), {
      columns: true, skip_empty_lines: true, trim: true,
    }) as Record<string, string>[]
  } catch {
    return { ok: false, error: 'Could not read that file as CSV. Export from Google Forms as .csv.' }
  }

  if (raw.length === 0) return { ok: false, error: 'That file has no rows.' }

  const headers = Object.keys(raw[0])
  const emailCol = findColumn(headers, EMAIL_NEEDLES)
  const nameCol = findColumn(headers, CODENAME_NEEDLES)

  if (!emailCol) {
    return { ok: false, error:
      `No email column found. Looked for a heading containing "username", "email" or "e-mail".\nFound: ${headers.join(' · ')}` }
  }
  if (!nameCol) {
    return { ok: false, error:
      `No codename column found. Looked for a heading containing "codename".\nFound: ${headers.join(' · ')}` }
  }

  const { rows, notes } = normalizeRows(raw, emailCol, nameCol)

  // Who already holds a key?
  const { data: existing } = await db
    .from('participant_keys')
    .select('key_code, codename, arm, block, email_hash')
    .eq('is_test', false)
    .lt('block', 900)

  const issuedHashes = new Set((existing ?? []).map((k) => k.email_hash).filter(Boolean))

  // Fallback for keys issued before email tracking existed: they have no hash,
  // so match them on codename instead. Reported rather than done silently,
  // because two different people could in principle have chosen the same
  // nickname — in which case the second would wrongly be treated as already
  // holding a key.
  const legacyNames = new Set(
    (existing ?? []).filter((k) => !k.email_hash).map((k) => k.codename.toLowerCase()),
  )

  const matchedByName: string[] = []
  const fresh = rows.filter((r) => {
    if (issuedHashes.has(hashEmail(r.email))) return false
    if (legacyNames.has(r.codename.trim().toLowerCase())) {
      matchedByName.push(r.codename.trim())
      return false
    }
    return true
  })

  const { data: allKeys } = await db.from('participant_keys').select('key_code')

  const plan = planIssuance(
    fresh,
    (existing ?? []).map((k) => ({ codename: k.codename, arm: k.arm, block: k.block })),
    new Set((allKeys ?? []).map((k) => k.key_code)),
    rows.length - fresh.length,
  )
  plan.notes = [...notes, ...plan.notes]

  if (matchedByName.length) {
    plan.notes.unshift(
      `Skipped ${matchedByName.length} person(s) matched by codename only ` +
      `(${matchedByName.join(', ')}) — these keys pre-date email tracking. ` +
      `Check they really are the same people.`,
    )
  }

  return {
    ok: true,
    emailColumn: emailCol,
    codenameColumn: nameCol,
    totalRows: rows.length,
    alreadyIssued: rows.length - fresh.length,
    plan,
    token: Buffer.from(JSON.stringify(plan.records)).toString('base64'),
  }
}

export type IssueResult = {
  ok: boolean
  message: string
  /** CSV text for the mail merge, handed straight back for download. */
  mailmerge?: string
  count?: number
}

/** Commit the plan the operator just looked at. */
export async function confirmIssue(token: string): Promise<IssueResult> {
  await requireAdmin()

  let records: { email: string; key_code: string; codename: string; arm: string; block: number }[]
  try {
    records = JSON.parse(Buffer.from(token, 'base64').toString('utf8'))
  } catch {
    return { ok: false, message: 'That preview expired. Upload the file again.' }
  }
  if (!Array.isArray(records) || records.length === 0) {
    return { ok: false, message: 'Nothing to issue.' }
  }

  // The email never reaches the database — only its HMAC, for de-duplication.
  const { error } = await db.from('participant_keys').insert(
    records.map((r) => ({
      key_code: r.key_code,
      codename: r.codename,
      arm: r.arm,
      block: r.block,
      is_test: false,
      email_hash: hashEmail(r.email),
    })),
  )
  if (error) return { ok: false, message: `Could not save the keys: ${error.message}` }

  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  const mailmerge =
    'email,codename,key\n' +
    records.map((r) => `${esc(r.email)},${esc(r.codename)},${esc(r.key_code)}`).join('\n') +
    '\n'

  revalidatePath('/admin')
  return {
    ok: true,
    count: records.length,
    message: `Issued ${records.length} key${records.length === 1 ? '' : 's'}.`,
    mailmerge,
  }
}

// -------------------------------------------------------------------- wipe ---

export async function wipeEverything(confirmation: string): Promise<{ ok: boolean; message: string }> {
  await requireAdmin()

  if (confirmation !== 'WIPE') {
    return { ok: false, message: 'Type WIPE exactly to confirm.' }
  }

  const NONE = '00000000-0000-0000-0000-000000000000'

  // Sessions first: participant_keys has no cascade from sessions, so a key
  // with an attempt cannot be removed until the attempt is gone.
  const s = await db.from('sessions').delete().neq('id', NONE)
  if (s.error) return { ok: false, message: `Could not delete attempts: ${s.error.message}` }

  const k = await db.from('participant_keys').delete().neq('id', NONE)
  if (k.error) return { ok: false, message: `Could not delete keys: ${k.error.message}` }

  revalidatePath('/admin')
  revalidatePath('/leaderboard')
  return { ok: true, message: 'All participants, attempts and answers deleted. Questions and settings kept.' }
}
