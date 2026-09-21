'use server'

import { rpc } from '@/lib/supabase/admin'
import { getTokenHash } from '@/lib/dal/session'
import { submitAnswerRpc } from '@/lib/dal/quiz'
import type { ControlNext, TreatmentNext } from '@/lib/types/quiz'

/**
 * The hot path: 100 submissions per participant, up to 300 participants.
 *
 * Deliberately calls none of `revalidatePath`, `refresh`, `redirect`, or a
 * cookie mutation. Per the Next 16 server-actions guide, a re-rendered RSC
 * payload is only bundled into the response when one of those happens — so
 * this response carries just the small return value, with no route re-render
 * per answer.
 *
 * Next dispatches Server Actions sequentially per client, which is a feature
 * here: rapid answers and double-clicks cannot race or arrive out of order.
 */
export async function submitAnswer(
  nonce: string,
  optionId: string,
  clientAtMs: number,
  hiddenMs: number,
): Promise<ControlNext | TreatmentNext> {
  // Re-validated inside the action, because Proxy is explicitly not a security
  // boundary — Server Functions POST to the page route.
  const tokenHash = await getTokenHash()
  if (!tokenHash) return { terminal: 'no_session' }

  return submitAnswerRpc(tokenHash, nonce, optionId, clientAtMs, hiddenMs)
}

/**
 * The client's countdown reached zero.
 *
 * The client never decides termination. If the server's clock disagrees, this
 * returns corrected timestamps and the participant carries on working.
 */
export async function finalizeAttempt(): Promise<{
  terminal: string | null
  deadlineAtMs: number
  serverNowMs: number
}> {
  const tokenHash = await getTokenHash()
  if (!tokenHash) return { terminal: 'no_session', deadlineAtMs: 0, serverNowMs: 0 }

  const result = await rpc<{
    terminal: string | null
    deadlineAtMs?: number
    serverNowMs?: number
  }>('finalize_attempt_now', { p_token_hash: tokenHash })

  return {
    terminal: result.terminal ?? null,
    deadlineAtMs: result.deadlineAtMs ?? 0,
    serverNowMs: result.serverNowMs ?? Date.now(),
  }
}
