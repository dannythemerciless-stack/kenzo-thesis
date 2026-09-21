import Link from 'next/link'
import { redirect } from 'next/navigation'

import { KeyEntryForm } from '@/components/KeyEntryForm'
import { db } from '@/lib/supabase/admin'
import { resolveSession, ROUTE_FOR_STATE } from '@/lib/dal/attempt'

export const metadata = { title: 'Access' }

const NOTICES: Record<string, string> = {
  session: 'Your session has ended. Please enter your access key again to continue.',
  expired: 'Your session has expired.',
}

export default async function LandingPage({
  searchParams,
}: {
  // Async in Next 16 — synchronous access was fully removed.
  searchParams: Promise<{ e?: string }>
}) {
  const { e } = await searchParams
  const notice = e ? NOTICES[e] : undefined

  /**
   * Someone who already holds a session must never be shown a key form.
   *
   * Without this, a participant who hits "home" mid-attempt sees what looks
   * like a fresh start while their clock is still running — and the clock
   * does not pause. They could sit here losing minutes, or re-enter their key
   * believing they had lost their place. Send them straight back to wherever
   * they actually are.
   *
   * `debrief` is excluded deliberately: they are finished, so there is
   * nothing to interrupt, and bouncing them would put the standings out of
   * reach from the landing page.
   */
  const session = await resolveSession()
  const finished = session.ok && session.state === 'debrief'

  if (session.ok && !finished) {
    redirect(ROUTE_FOR_STATE[session.state])
  }

  // Only advertise the standings once they are actually published, so nobody
  // clicks through to "not published yet" during fieldwork.
  const { data: cfg } = await db
    .from('study_config')
    .select('leaderboard_public')
    .single()

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-8 px-6 py-16">
      <header className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-neutral-500 uppercase">
          UPLB Department of Economics
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-balance">
          Digital Micro-Labor Performance Quiz
        </h1>
        <p className="text-neutral-600 dark:text-neutral-400">
          {finished
            ? 'You have already completed this study.'
            : 'Enter the one-time access key from your invitation email to begin.'}
        </p>
      </header>

      {notice && !finished && (
        <p
          role="status"
          className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          {notice}
        </p>
      )}

      {finished ? (
        // One key is one attempt, forever. Offering a key box here would
        // invite someone to try a second run that the database will refuse.
        <div className="space-y-4 rounded-xl border p-6 dark:border-neutral-800">
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Thank you for taking part. Your responses have been recorded, and
            each access key may only be used once.
          </p>
          <Link
            href="/debrief"
            className="inline-flex items-center gap-2 text-sm font-medium underline underline-offset-4 hover:no-underline"
          >
            Read about the study again
            <span aria-hidden>&rarr;</span>
          </Link>
        </div>
      ) : (
        <>
          <KeyEntryForm />
          <noscript>
            <p className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900">
              This study requires JavaScript. Please enable it and reload the page.
            </p>
          </noscript>
        </>
      )}

      <footer className="space-y-4 border-t pt-6 dark:border-neutral-800">
        {cfg?.leaderboard_public && (
          <Link
            href="/leaderboard"
            className="inline-flex items-center gap-2 text-sm font-medium underline underline-offset-4 hover:no-underline"
          >
            View final standings
            <span aria-hidden>&rarr;</span>
          </Link>
        )}
        <p className="text-xs leading-relaxed text-neutral-500">
          Your access key is the only identifier used. No name, email address
          or student number is stored by this application.
        </p>
      </footer>
    </main>
  )
}
