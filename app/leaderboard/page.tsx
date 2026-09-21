import Link from 'next/link'

import { db } from '@/lib/supabase/admin'
import { resolveSession } from '@/lib/dal/attempt'
import { prizeForRank, prizeTierIndex, PRIZE_TIERS, LAST_PAID_RANK } from '@/lib/prizes'

export const metadata = { title: 'Standings' }

type Row = {
  prize_rank: number
  codename: string
  correct_count: number
  effort_sec: number
}

function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}m ${String(s).padStart(2, '0')}s`
}

export default async function LeaderboardPage() {
  // Two independent gates.
  //
  // (1) Never reachable MID-ATTEMPT. Chapter III assumes participants cannot
  //     monitor their peers, which is what makes the tournament a clean
  //     expected-utility structure.
  const session = await resolveSession()
  if (session.ok && session.state === 'in_progress') {
    return (
      <main className="mx-auto max-w-xl px-6 py-20 text-center">
        <h1 className="mb-3 text-xl font-semibold">Not available right now</h1>
        <p className="mb-8 text-neutral-600 dark:text-neutral-400">
          Standings cannot be viewed while your attempt is in progress.
        </p>
        <Link href="/quiz" className="underline underline-offset-4">
          Return to the quiz
        </Link>
      </main>
    )
  }

  // (2) Hidden until the field window closes, so an early finisher cannot leak
  //     the competitive bar to participants who run later.
  const { data: cfg } = await db
    .from('study_config')
    .select('leaderboard_public')
    .single()

  if (!cfg?.leaderboard_public) {
    return (
      <main className="mx-auto max-w-xl px-6 py-20 text-center">
        <h1 className="mb-3 text-xl font-semibold">Standings are not published yet</h1>
        <p className="mb-8 text-neutral-600 dark:text-neutral-400">
          Rankings are released once data collection closes, so that everyone
          takes the quiz under the same conditions.
        </p>
        <Link href="/" className="underline underline-offset-4">
          Back
        </Link>
      </main>
    )
  }

  const { data } = await db
    .from('v_leaderboard')
    .select('prize_rank, codename, correct_count, effort_sec')
    .order('prize_rank')
    .limit(50)

  const rows = (data ?? []) as Row[]

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <header className="mb-8 space-y-2">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm text-neutral-500 underline-offset-4 hover:underline"
        >
          <span aria-hidden>&larr;</span> Back
        </Link>
        <h1 className="pt-2 text-2xl font-semibold tracking-tight">Final standings</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          The three highest scores each receive{' '}
          <strong>PHP {PRIZE_TIERS[0].amount}</strong>; ranks 4 to{' '}
          {LAST_PAID_RANK} each receive{' '}
          <strong>PHP {PRIZE_TIERS[1].amount}</strong>. Ties were broken by the
          shorter completion time.
        </p>
      </header>

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-neutral-500 dark:border-neutral-800">
            <th scope="col" className="py-2 pr-3 font-medium">#</th>
            <th scope="col" className="py-2 pr-3 font-medium">Codename</th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">Score</th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">Time</th>
            <th scope="col" className="py-2 text-right font-medium">Prize</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const tier = prizeTierIndex(r.prize_rank)
            const prize = prizeForRank(r.prize_rank)

            // Three visual weights, matching the three payoff levels, so the
            // table reads as the prize structure rather than a flat list.
            const rowClass =
              tier === 0
                ? 'bg-amber-50 font-semibold text-neutral-900 dark:bg-amber-950/40 dark:text-amber-50'
                : tier === 1
                  ? 'bg-neutral-50 font-medium dark:bg-neutral-900/50'
                  : 'text-neutral-500'

            return (
              <tr
                key={r.codename}
                className={`border-b dark:border-neutral-800 ${rowClass}`}
              >
                <td className="py-2.5 pr-3 font-mono tabular-nums">
                  {tier === 0 && (
                    <span aria-hidden className="mr-1.5 text-amber-500">&#9733;</span>
                  )}
                  {r.prize_rank}
                </td>
                <td className="py-2.5 pr-3 font-mono">{r.codename}</td>
                <td className="py-2.5 pr-3 text-right font-mono tabular-nums">
                  {r.correct_count}
                </td>
                <td className="py-2.5 pr-3 text-right font-mono tabular-nums">
                  {fmtDuration(r.effort_sec)}
                </td>
                <td
                  className={`py-2.5 text-right font-mono tabular-nums ${
                    tier === 0 ? 'text-amber-700 dark:text-amber-300' : ''
                  }`}
                >
                  {prize > 0 ? `₱${prize}` : '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {rows.length === 0 && (
        <p className="py-8 text-center text-neutral-500">No results yet.</p>
      )}
    </main>
  )
}
