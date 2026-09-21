import { NextResponse } from 'next/server'

import { rpc } from '@/lib/supabase/admin'
import { getTokenHash } from '@/lib/dal/session'

/**
 * Tab-visibility loss reporting. A Route Handler, not a Server Action, for
 * three reasons:
 *
 *  1. It must fire during `visibilitychange`/`pagehide`, where only
 *     `navigator.sendBeacon` survives. React's action dispatcher does not.
 *  2. Next dispatches Server Actions sequentially per client, so a focus
 *     report would queue behind an in-flight answer submission.
 *  3. It is fire-and-forget telemetry that must never block or fail the hot
 *     path.
 *
 * The client sends an EVENT with a dedupe key; it never sends a count. The
 * count is the server's alone, and disqualification is a database trigger, so
 * neither can be tampered with from the browser.
 *
 * This endpoint NEVER returns the focus count or the disqualified flag — the
 * participant must not learn mid-task that they are ineligible.
 */
export async function POST(request: Request) {
  const tokenHash = await getTokenHash()
  if (!tokenHash) return NextResponse.json({ ok: false }, { status: 204 })

  let dedupeKey: string | undefined
  let clientAtMs: number | undefined

  try {
    const body = (await request.json()) as { dedupeKey?: string; clientAtMs?: number }
    dedupeKey = body.dedupeKey
    clientAtMs = body.clientAtMs
  } catch {
    // A beacon can arrive with an empty or truncated body during unload.
  }

  if (!dedupeKey || !/^[0-9a-f-]{36}$/i.test(dedupeKey)) {
    return NextResponse.json({ ok: false }, { status: 204 })
  }

  try {
    await rpc('record_focus_loss', {
      p_token_hash: tokenHash,
      p_dedupe_key: dedupeKey,
      p_client_at: clientAtMs ? new Date(clientAtMs).toISOString() : null,
      p_hidden_ms: 0,
    })
  } catch {
    // Telemetry must never surface an error to the participant.
  }

  // Deliberately empty. Nothing about the count leaves the server.
  return new NextResponse(null, { status: 204 })
}
