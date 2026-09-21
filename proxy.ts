import { NextResponse, type NextRequest } from 'next/server'

/**
 * Next 16 renamed `middleware` to `proxy`. Three things the docs are explicit
 * about, all of which this file depends on:
 *
 *  1. The file is `proxy.ts` at the project root and the export is named
 *     `proxy` (proxy.md).
 *  2. Do NOT add `export const runtime` — "Setting the runtime config option in
 *     Proxy will throw an error" (proxy.md line 255).
 *  3. Proxy is NOT a security boundary. Server Functions POST to the *page*
 *     route, so a matcher refactor can silently drop coverage. That is why
 *     this does cheap cookie-PRESENCE checking only, and every page and action
 *     independently re-validates via requireState() in lib/dal/attempt.ts.
 *
 * Also per proxy.md: "you should not attempt relying on shared modules or
 * globals" — hence the literal cookie name here rather than an import.
 */

const SESSION_COOKIE = 'kq_sid'

export function proxy(request: NextRequest) {
  if (!request.cookies.has(SESSION_COOKIE)) {
    const url = request.nextUrl.clone()
    url.pathname = '/'
    url.search = '?e=session'
    return NextResponse.redirect(url)
  }
  return NextResponse.next()
}

export const config = {
  // /leaderboard is deliberately absent: it is public, and the "not reachable
  // mid-attempt" rule needs the attempt status, which requires a DB read.
  matcher: ['/quiz/:path*', '/complete/:path*', '/debrief/:path*'],
}
