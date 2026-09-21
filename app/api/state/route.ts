import { NextResponse } from 'next/server'

import { rpc } from '@/lib/supabase/admin'
import { getTokenHash } from '@/lib/dal/session'

/**
 * GET  — clock resync and terminal-state poll.
 * POST — visibility-gated heartbeat, which feeds engaged_duration_sec.
 *
 * A Route Handler rather than a Server Action because these are polled on an
 * interval and on `visibilitychange`, and must not enter the sequential action
 * queue behind an answer submission.
 *
 * Both responses carry the server clock and NOTHING about progress, so this
 * endpoint is identical for both groups. A control participant watching the
 * network tab learns only the time.
 */

const noStore = { 'cache-control': 'no-store' }

export async function GET() {
  const tokenHash = await getTokenHash()
  if (!tokenHash) {
    return NextResponse.json({ terminal: 'no_session' }, { headers: noStore })
  }

  const result = await rpc<{
    ok: boolean
    state?: string
    deadlineAtMs?: number
    serverNowMs?: number
  }>('resolve_session', { p_token_hash: tokenHash })

  if (!result.ok) {
    return NextResponse.json({ terminal: 'no_session' }, { headers: noStore })
  }

  return NextResponse.json(
    {
      terminal: result.state === 'in_progress' ? null : (result.state ?? null),
      deadlineAtMs: result.deadlineAtMs ?? null,
      serverNowMs: result.serverNowMs ?? Date.now(),
    },
    { headers: noStore },
  )
}

export async function POST(request: Request) {
  const tokenHash = await getTokenHash()
  if (!tokenHash) {
    return NextResponse.json({ terminal: 'no_session' }, { headers: noStore })
  }

  // Optional body carries away-time from a tab switch. It adds to
  // hidden_ms_total WITHOUT counting another switch — the count comes only
  // from /api/focus, so away-time and switch-count can never disagree.
  let hiddenMs = 0
  try {
    const body = (await request.json()) as { hiddenMs?: number }
    if (typeof body.hiddenMs === 'number' && body.hiddenMs > 0) {
      hiddenMs = Math.min(body.hiddenMs, 3_600_000)
    }
  } catch {
    // A plain heartbeat has no body.
  }

  const result = await rpc<{
    ok: boolean
    terminal?: string
    deadlineAtMs?: number
    serverNowMs?: number
  }>('record_heartbeat', { p_token_hash: tokenHash, p_hidden_ms_delta: hiddenMs })

  return NextResponse.json(
    {
      terminal: result.terminal ?? null,
      deadlineAtMs: result.deadlineAtMs ?? null,
      serverNowMs: result.serverNowMs ?? Date.now(),
    },
    { headers: noStore },
  )
}
