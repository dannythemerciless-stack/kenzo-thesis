import 'server-only'

import { cookies } from 'next/headers'
import { createHmac, timingSafeEqual } from 'node:crypto'

import { env } from '@/lib/env'

/**
 * Access control for the researcher dashboard.
 *
 * One shared key, no accounts — the same pattern participants use, for the
 * same reason: there is exactly one operator and a login system would be more
 * moving parts than the thing it protects.
 *
 * The session cookie is a signed expiry stamp, not a stored token, so nothing
 * needs a database round trip and nothing to leak if the table is read. The
 * signature is keyed with SESSION_PEPPER, which never leaves the server.
 *
 * THIS DASHBOARD CAN DESTROY THE STUDY — it can wipe every participant. The
 * key must be long and random (`openssl rand -hex 32`), and it is the only
 * thing standing between a stranger and the delete button.
 */

const COOKIE = 'kq_admin'
const TTL_MS = 8 * 60 * 60 * 1000 // 8 hours

function sign(expiresAt: number): string {
  return createHmac('sha256', env.SESSION_PEPPER)
    .update(`admin:${expiresAt}`)
    .digest('hex')
}

/** Constant-time compare that tolerates different lengths. */
function sameSecret(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

export function checkAdminKey(provided: string): boolean {
  if (!env.ADMIN_KEY) return false
  return sameSecret(provided.trim(), env.ADMIN_KEY)
}

export async function startAdminSession(): Promise<void> {
  const expiresAt = Date.now() + TTL_MS
  const jar = await cookies()
  jar.set(COOKIE, `${expiresAt}.${sign(expiresAt)}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(TTL_MS / 1000),
  })
}

export async function endAdminSession(): Promise<void> {
  const jar = await cookies()
  jar.delete(COOKIE)
}

export async function isAdmin(): Promise<boolean> {
  const raw = (await cookies()).get(COOKIE)?.value
  if (!raw) return false

  const [stamp, signature] = raw.split('.')
  const expiresAt = Number(stamp)

  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false
  if (!signature) return false

  return sameSecret(signature, sign(expiresAt))
}

/** Throws if the caller is not signed in. Every admin action calls this. */
export async function requireAdmin(): Promise<void> {
  if (!(await isAdmin())) {
    throw new Error('Not authorised')
  }
}

/** HMAC of an email, for de-duplicating key issuance without storing the address. */
export function hashEmail(email: string): string {
  return `\\x${createHmac('sha256', env.SESSION_PEPPER)
    .update(email.trim().toLowerCase())
    .digest('hex')}`
}
