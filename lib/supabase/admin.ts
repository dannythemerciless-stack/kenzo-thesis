import 'server-only'

import { createClient } from '@supabase/supabase-js'
import { createHmac, createHash } from 'node:crypto'

import { env } from '@/lib/env'

/**
 * The ONE database client in the application.
 *
 * Everything goes through the service role, because the browser never talks to
 * Supabase at all — there is no anon key in the client bundle, no Supabase
 * Auth, and no RLS policies to reason about. Access control is: this module is
 * `server-only`, and every `exp` table has all grants revoked from `anon` and
 * `authenticated` (see 0001_schema.sql).
 *
 * `db.schema` targets `exp`, so `.rpc()` resolves to `exp.<fn>`. That schema
 * must be listed under Supabase → Settings → API → Exposed schemas, otherwise
 * PostgREST refuses to route to it regardless of which key is used.
 */
export const db = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  db: { schema: 'exp' },
  auth: { persistSession: false, autoRefreshToken: false },
  global: { headers: { 'x-application-name': 'goal-proximity-experiment' } },
})

/**
 * Call a Postgres function, throwing on error.
 *
 * Every state transition in this app is exactly one of these. supabase-js has
 * no transaction API, so anything needing "lock, read, decide, write" lives in
 * plpgsql where it can hold a row lock — see 0002_functions.sql.
 */
export async function rpc<T = unknown>(
  fn: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const { data, error } = await db.rpc(fn, args)
  if (error) {
    // Never echo the raw Postgres error to a participant; it can name tables
    // and constraints. Log it server-side, surface something generic upstream.
    console.error(`[rpc:${fn}]`, error.code, error.message, error.details ?? '')
    throw new Error(`Database call failed: ${fn}`)
  }
  return data as T
}

/** sha256 of the raw cookie token. Only the hash is ever stored. */
export function hashToken(rawToken: string): string {
  return `\\x${createHash('sha256').update(rawToken, 'utf8').digest('hex')}`
}

/**
 * HMAC of a client IP, for rate limiting only. Keyed, not a bare hash, so the
 * stored value is not brute-forceable back to an address.
 */
export function hashIp(ip: string | null): string | null {
  if (!ip) return null
  return `\\x${createHmac('sha256', env.SESSION_PEPPER).update(ip).digest('hex')}`
}
