/**
 * Supabase client for the CLI seed scripts.
 *
 * Deliberately separate from `lib/supabase/admin.ts`, which is marked
 * `server-only` and therefore cannot be imported outside the Next.js runtime.
 */

import { createClient } from '@supabase/supabase-js'

export function makeClient() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SECRET_KEY

  if (!url || !key) {
    console.error(
      'Missing SUPABASE_URL or SUPABASE_SECRET_KEY.\n' +
        'Run with:  node --env-file=.env.local scripts/<script>.ts',
    )
    process.exit(1)
  }

  return createClient(url, key, {
    db: { schema: 'exp' },
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/** Exit with a clear message rather than an unhandled rejection stack. */
export function die(message: string, detail?: unknown): never {
  console.error(`\n✖ ${message}`)
  if (detail) console.error(detail)
  process.exit(1)
}
