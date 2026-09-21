import 'server-only'

import { redirect } from 'next/navigation'

import { rpc } from '@/lib/supabase/admin'
import { getTokenHash } from '@/lib/dal/session'

/**
 * The single source of routing truth.
 *
 * Every gated page calls `requireState()` rather than inventing its own rules,
 * so "where should this browser be right now?" is answered in exactly one
 * place. Note that Next 16's docs are explicit that Proxy is NOT a security
 * boundary — Server Functions POST to the page route, so a matcher change can
 * silently drop coverage. Hence every action and page re-validates here.
 */

export type AttemptState = 'consent' | 'in_progress' | 'survey' | 'debrief'

export type Resolved = {
  ok: true
  state: AttemptState
  codename: string
  arm?: 'control' | 'treatment'
  status?: string
  completed?: boolean
  correct?: number
  answered?: number
  deadlineAtMs?: number
  serverNowMs?: number
}

type ResolveResult = Resolved | { ok: false; reason: string }

export const ROUTE_FOR_STATE: Record<AttemptState, string> = {
  consent: '/consent',
  in_progress: '/quiz',
  survey: '/complete',
  debrief: '/debrief',
}

export async function resolveSession(): Promise<ResolveResult> {
  const tokenHash = await getTokenHash()
  if (!tokenHash) return { ok: false, reason: 'no_session' }
  return rpc<ResolveResult>('resolve_session', { p_token_hash: tokenHash })
}

/**
 * Resolve, and redirect unless the participant is where they should be.
 *
 * Back-button handling falls out of this for free: /consent bounces an
 * in-progress attempt to /quiz, so pressing Back is a no-op. No `beforeunload`
 * hack is needed — and `beforeunload` is unreliable on mobile anyway.
 */
export async function requireState(expected: AttemptState): Promise<Resolved> {
  const result = await resolveSession()

  if (!result.ok) redirect('/?e=session')
  if (result.state !== expected) redirect(ROUTE_FOR_STATE[result.state])

  return result
}
