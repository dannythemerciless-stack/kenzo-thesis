import 'server-only'

import { z } from 'zod'

/**
 * Validated server environment.
 *
 * Next 16 removed `serverRuntimeConfig`/`publicRuntimeConfig`, and only
 * `NEXT_PUBLIC_`-prefixed variables are inlined into the client bundle. None of
 * these carry that prefix, and this module is marked `server-only`, so a Client
 * Component that imports it (directly or transitively) fails the BUILD rather
 * than shipping a service-role key to a participant's browser.
 */
const schema = z.object({
  SUPABASE_URL: z.string().url(),

  // The service role key bypasses RLS by design. It must never leave the server.
  SUPABASE_SECRET_KEY: z.string().min(20),

  // HMAC pepper for the rate-limit IP hash. A bare SHA-256 of an IPv4 address
  // is trivially reversible by brute force, which would put recoverable network
  // identifiers into a database that claims to hold no PII.
  SESSION_PEPPER: z.string().min(32, 'generate with: openssl rand -hex 32'),

  // Bearer token for GET /api/export.
  RESEARCHER_EXPORT_TOKEN: z.string().min(32, 'generate with: openssl rand -hex 32'),
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  // Fail loudly at boot rather than at 2am mid-experiment with a cryptic
  // "undefined is not a string" from deep inside the Supabase client.
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join('.')}: ${i.message}`)
    .join('\n')
  throw new Error(`Invalid environment configuration:\n${issues}`)
}

export const env = parsed.data
