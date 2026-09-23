import { timingSafeEqual } from 'node:crypto'

import { db, rpc } from '@/lib/supabase/admin'
import { env } from '@/lib/env'

/**
 * Researcher CSV export. A Route Handler because Server Actions cannot return
 * a file response.
 *
 *   curl -H "Authorization: Bearer $RESEARCHER_EXPORT_TOKEN" \
 *        https://<app>/api/export?dataset=wide -o export_wide.csv
 *
 * Datasets:
 *   wide    one row per participant, analysis-ready for STATA (the main one)
 *   timing  one row per item per participant, for the goal-gradient pace analysis
 */

export const maxDuration = 60

const DATASETS = {
  wide: 'v_export_wide',
  timing: 'v_item_timing',
} as const

function authorized(request: Request): boolean {
  const header = request.headers.get('authorization') ?? ''
  const provided = header.replace(/^Bearer\s+/i, '')
  const expected = env.RESEARCHER_EXPORT_TOKEN

  // Constant-time compare, and length-guard first since timingSafeEqual throws
  // on a length mismatch.
  if (provided.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return ''
  const headers = Object.keys(rows[0])

  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return ''
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }

  return [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => cell(r[h])).join(',')),
  ].join('\n')
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return new Response('Unauthorized', { status: 401 })
  }

  const dataset = (new URL(request.url).searchParams.get('dataset') ??
    'wide') as keyof typeof DATASETS

  if (!(dataset in DATASETS)) {
    return new Response(`Unknown dataset. Use: ${Object.keys(DATASETS).join(', ')}`, {
      status: 400,
    })
  }

  // Snapshot any attempts whose deadline has passed, so the export reflects
  // final values. Not strictly required — v_export_wide reads v_session_live,
  // which is correct regardless — but it keeps the stored columns tidy.
  try {
    await rpc('finalize_expired_sessions', { p_limit: 500 })
  } catch {
    /* the live view is authoritative anyway */
  }

  const { data, error } = await db.from(DATASETS[dataset]).select('*')

  if (error) {
    console.error('[export]', error)
    return new Response('Export failed', { status: 500 })
  }

  const csv = toCsv((data ?? []) as Record<string, unknown>[])
  const stamp = new Date().toISOString().slice(0, 10)

  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="gp_${dataset}_${stamp}.csv"`,
      'cache-control': 'no-store',
    },
  })
}
