import 'server-only'

import { rpc } from '@/lib/supabase/admin'
import type {
  BaseQuestionView,
  ControlNext,
  TerminalView,
  TreatmentNext,
} from '@/lib/types/quiz'

/**
 * Two functions, two return types, one blinding guarantee.
 *
 * `getControlView` is typed to `BaseQuestionView`, which has no progress
 * fields at all — so no caller can accidentally read a count, and no
 * refactor can accidentally forward one. The Postgres side already omits them
 * (see exp.serve_current_item's p_with_progress branch); the assertion below
 * is a cheap belt-and-braces check that fails loudly in development if that
 * ever changes.
 */

const PROGRESS_KEYS = ['answeredCount', 'totalCount', 'position', 'index'] as const

function assertBlind(payload: unknown): void {
  if (process.env.NODE_ENV === 'production') return
  if (!payload || typeof payload !== 'object') return

  for (const key of PROGRESS_KEYS) {
    if (key in payload) {
      throw new Error(
        `BLINDING VIOLATION: the control payload contains "${key}". ` +
          `A control participant must never receive progress information.`,
      )
    }
  }
}

export async function getControlView(tokenHash: string): Promise<ControlNext> {
  const view = await rpc<ControlNext>('get_current_item', { p_token_hash: tokenHash })
  assertBlind(view)
  return view as BaseQuestionView | TerminalView
}

export async function getTreatmentView(tokenHash: string): Promise<TreatmentNext> {
  return rpc<TreatmentNext>('get_current_item', { p_token_hash: tokenHash })
}

export async function submitAnswerRpc(
  tokenHash: string,
  nonce: string,
  optionId: string,
  clientAtMs: number | null,
  hiddenMs: number,
): Promise<ControlNext | TreatmentNext> {
  return rpc('submit_answer', {
    p_token_hash: tokenHash,
    p_nonce: nonce,
    p_option_id: optionId,
    p_client_at: clientAtMs ? new Date(clientAtMs).toISOString() : null,
    p_hidden_ms: Math.max(0, Math.round(hiddenMs)),
  })
}
