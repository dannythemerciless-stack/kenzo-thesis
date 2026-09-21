import 'server-only'

import { cookies, headers } from 'next/headers'
import { randomBytes } from 'node:crypto'

import { hashToken, hashIp } from '@/lib/supabase/admin'

/**
 * Cookie-backed browser session.
 *
 * The cookie holds an OPAQUE 256-bit random token — not a JWT, not
 * `{attemptId, arm, position}`. This matters: httpOnly keeps the value out of
 * JavaScript but NOT out of devtools → Application → Cookies, which any
 * curious participant can open. An opaque token leaks nothing when read, and
 * only its sha256 is ever stored, so a database leak does not hand over live
 * sessions either.
 */

const SESSION_COOKIE = 'kq_sid' // deliberately meaningless name

/** Six hours: comfortably covers a 1-hour attempt plus resume after a break. */
export const SESSION_TTL_SEC = 60 * 60 * 6

export function mintToken(): string {
  return randomBytes(32).toString('base64url')
}

export async function setSessionCookie(rawToken: string): Promise<void> {
  const jar = await cookies() // async in Next 16
  jar.set(SESSION_COOKIE, rawToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax', // survives the redirect back from an emailed link
    path: '/',
    maxAge: SESSION_TTL_SEC,
  })
}

export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies()
  jar.delete(SESSION_COOKIE)
}

/** The hashed token, which is what every RPC is keyed by. */
export async function getTokenHash(): Promise<string | null> {
  const jar = await cookies()
  const raw = jar.get(SESSION_COOKIE)?.value
  return raw ? hashToken(raw) : null
}

/** Hashed client IP, for rate limiting key entry. Never stored unhashed. */
export async function getClientIpHash(): Promise<string | null> {
  const h = await headers()
  const forwarded = h.get('x-forwarded-for')?.split(',')[0]?.trim()
  return hashIp(forwarded || h.get('x-real-ip') || null)
}

export async function getUserAgentFamily(): Promise<string | null> {
  const ua = (await headers()).get('user-agent') ?? ''
  // Coarse buckets only. Enough to report a device-type breakdown alongside
  // the tab-visibility counts, without storing a fingerprintable string.
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios'
  if (/Android/i.test(ua)) return 'android'
  if (/Macintosh/i.test(ua)) return 'mac'
  if (/Windows/i.test(ua)) return 'windows'
  if (/Linux/i.test(ua)) return 'linux'
  return ua ? 'other' : null
}
