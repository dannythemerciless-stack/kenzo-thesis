'use server'

import { redirect } from 'next/navigation'

import { rpc, db, hashToken } from '@/lib/supabase/admin'
import {
  mintToken,
  setSessionCookie,
  getTokenHash,
  getClientIpHash,
  getUserAgentFamily,
  SESSION_TTL_SEC,
} from '@/lib/dal/session'
import { ROUTE_FOR_STATE } from '@/lib/dal/attempt'
import { buildPlan, planHashBytea, type PoolQuestion } from '@/lib/quiz/randomize'

export type KeyEntryState = { error?: string }

type RedeemResult = {
  ok: boolean
  reason?: string
  codename?: string
  hasAttempt?: boolean
  status?: string
  surveyed?: boolean
  debriefed?: boolean
}

const MESSAGES: Record<string, string> = {
  // Deliberately identical for unknown and already-used keys. Distinguishing
  // them would turn this form into an oracle for probing which keys are valid.
  invalid: 'That access key was not recognised. Please check the email and try again.',
  rate_limited: 'Too many attempts. Please wait ten minutes and try again.',
  not_open: 'The study is not open yet. Please try the link in your email later.',
}

/** Key entry. Mints a browser session. Does NOT start the clock. */
export async function startAttempt(
  _prev: KeyEntryState,
  formData: FormData,
): Promise<KeyEntryState> {
  const key = String(formData.get('key') ?? '').trim()
  if (!key) return { error: 'Please enter your access key.' }

  const rawToken = mintToken()
  const tokenHash = hashToken(rawToken)

  const result = await rpc<RedeemResult>('redeem_key', {
    p_key_code: key,
    p_token_hash: tokenHash,
    p_ttl_sec: SESSION_TTL_SEC,
    p_ip_hash: await getClientIpHash(),
  })

  if (!result.ok) {
    return { error: MESSAGES[result.reason ?? 'invalid'] ?? MESSAGES.invalid }
  }

  await setSessionCookie(rawToken)

  // Resume: route them to wherever they actually are. The clock has been
  // running the whole time they were away.
  if (result.hasAttempt) {
    if (result.status === 'in_progress') redirect(ROUTE_FOR_STATE.in_progress)
    redirect(result.surveyed ? ROUTE_FOR_STATE.debrief : ROUTE_FOR_STATE.survey)
  }

  redirect(ROUTE_FOR_STATE.consent)
}

/**
 * Consent accepted. THE CLOCK STARTS HERE.
 *
 * The randomization plan is generated in Node with a CSPRNG (unit-tested, and
 * shown in the appendix), hashed, and verified server-side inside
 * `begin_attempt` before a single plan row is committed.
 */
export async function beginAttempt(): Promise<void> {
  const tokenHash = await getTokenHash()
  if (!tokenHash) redirect('/?e=session')

  // The pool is frozen during collection, so this read is cheap and stable.
  const { data: questions, error } = await db
    .from('questions')
    .select('id, question_options(id)')
    .eq('is_active', true)

  if (error || !questions?.length) {
    throw new Error('Question pool unavailable')
  }

  const pool: PoolQuestion[] = questions.map((q) => ({
    id: q.id as string,
    optionIds: (q.question_options as { id: string }[]).map((o) => o.id),
  }))

  const plan = buildPlan(pool)

  const result = await rpc<{ ok: boolean; reason?: string }>('begin_attempt', {
    p_token_hash: tokenHash,
    p_plan: plan,
    p_plan_sha256: planHashBytea(plan),
    p_ua_family: await getUserAgentFamily(),
  })

  if (!result.ok) redirect('/?e=session')

  redirect(ROUTE_FOR_STATE.in_progress)
}
