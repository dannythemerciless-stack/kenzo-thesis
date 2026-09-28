'use client'

import { useState } from 'react'

type Row = {
  key_code: string
  codename: string
  arm: string
  status: string
  answered_count: number | null
  correct_count: number | null
  item_count: number | null
  effort_sec: number | null
  focus_loss_count: number | null
  disqualified: boolean | null
  started_at: string | null
  surveyed: boolean
}

const STATUS_LABEL: Record<string, string> = {
  not_started: 'Not started',
  in_progress: 'Taking it now',
  completed: 'Completed',
  timed_out: 'Ran out of time',
}

function mmss(sec: number | null) {
  if (sec === null) return '—'
  return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`
}

export function Participants({ rows, flagged }: { rows: Row[]; flagged: number }) {
  const [filter, setFilter] = useState<'all' | 'started' | 'flagged'>('all')
  const [q, setQ] = useState('')

  const shown = rows
    .filter((r) =>
      filter === 'all' ? true
      : filter === 'started' ? r.status !== 'not_started'
      : r.disqualified,
    )
    .filter((r) =>
      !q || r.codename.toLowerCase().includes(q.toLowerCase())
        || r.key_code.toLowerCase().includes(q.toLowerCase()),
    )

  return (
    <section className="mb-10">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Participants</h2>
        <div className="flex items-center gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search codename or key"
            className="rounded-lg border px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          {(['all', 'started', 'flagged'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-lg px-3 py-1.5 text-sm capitalize ${
                filter === f
                  ? 'bg-neutral-900 text-white dark:bg-white dark:text-neutral-900'
                  : 'border dark:border-neutral-700'
              }`}
            >
              {f}{f === 'flagged' && flagged > 0 ? ` (${flagged})` : ''}
            </button>
          ))}
        </div>
      </div>

      {flagged > 0 && (
        <p className="mb-3 rounded-lg bg-neutral-50 px-4 py-2.5 text-sm text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400">
          <strong>{flagged}</strong> participant(s) switched away from the quiz
          five or more times. They are still ranked and their data still counts —
          whether they keep a prize is your call.
        </p>
      )}

      <div className="overflow-x-auto rounded-xl border dark:border-neutral-800">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-neutral-500 dark:bg-neutral-900">
            <tr>
              <th className="px-3 py-2 font-medium">Codename</th>
              <th className="px-3 py-2 font-medium">Group</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 text-right font-medium">Answered</th>
              <th className="px-3 py-2 text-right font-medium">Score</th>
              <th className="px-3 py-2 text-right font-medium">Time</th>
              <th className="px-3 py-2 text-right font-medium">Tab switches</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.key_code} className="border-t dark:border-neutral-800">
                <td className="px-3 py-2 font-mono">
                  {r.codename}
                  {r.disqualified && (
                    <span title="Switched away 5+ times" className="ml-1.5 text-amber-600">⚑</span>
                  )}
                </td>
                <td className="px-3 py-2 text-neutral-500">
                  {r.arm === 'treatment' ? 'progress bar' : 'no bar'}
                </td>
                <td className="px-3 py-2">
                  <span className={
                    r.status === 'in_progress' ? 'text-emerald-600 dark:text-emerald-400'
                    : r.status === 'not_started' ? 'text-neutral-400'
                    : ''
                  }>
                    {STATUS_LABEL[r.status] ?? r.status}
                  </span>
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">
                  {r.started_at ? `${r.answered_count}/${r.item_count}` : '—'}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">
                  {r.started_at ? r.correct_count : '—'}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-neutral-500">
                  {mmss(r.effort_sec)}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-neutral-500">
                  {r.started_at ? r.focus_loss_count : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && (
          <p className="px-3 py-8 text-center text-sm text-neutral-500">
            {rows.length === 0 ? 'No keys issued yet.' : 'Nothing matches that filter.'}
          </p>
        )}
      </div>
    </section>
  )
}
