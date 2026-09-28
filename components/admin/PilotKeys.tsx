'use client'

import { useState, useTransition } from 'react'

import { createPilotKeys, resetPilotSessions, deletePilotKeys } from '@/app/admin/actions'

type Pilot = {
  key_code: string
  codename: string
  arm: string
  status: string
  answered_count: number | null
  item_count: number | null
}

export function PilotKeys({ rows }: { rows: Pilot[] }) {
  const [pending, start] = useTransition()
  const [msg, setMsg] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [count, setCount] = useState(4)

  const used = rows.filter((r) => r.status !== 'not_started').length

  return (
    <section className="mb-10">
      <h2 className="mb-1 text-lg font-semibold">Practice keys</h2>
      <p className="mb-3 text-sm text-neutral-500">
        For trying the quiz yourself. These are excluded from the leaderboard,
        the exports and every result, so nothing you do with them can end up in
        the study. They also work while the study is closed.
      </p>

      <div className="rounded-xl border p-4 dark:border-neutral-800">
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            className="rounded-lg border px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          >
            {[2, 4, 6, 10].map((n) => (
              <option key={n} value={n}>{n} keys</option>
            ))}
          </select>
          <button
            disabled={pending}
            onClick={() => start(async () => setMsg((await createPilotKeys(count)).message))}
            className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {pending ? '…' : 'Create'}
          </button>

          {rows.length > 0 && (
            <>
              <button
                disabled={pending || used === 0}
                onClick={() => start(async () => setMsg((await resetPilotSessions()).message))}
                title="Clear the attempts so these keys can be used again"
                className="rounded-lg border px-4 py-2 text-sm font-medium disabled:opacity-40 dark:border-neutral-700"
              >
                Reuse them ({used} used)
              </button>
              <button
                disabled={pending}
                onClick={() => start(async () => setMsg((await deletePilotKeys()).message))}
                className="rounded-lg border px-4 py-2 text-sm text-neutral-500 disabled:opacity-40 dark:border-neutral-700"
              >
                Delete all
              </button>
            </>
          )}
        </div>

        {msg && <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-400">{msg}</p>}

        {rows.length > 0 && (
          <div className="mt-4 overflow-hidden rounded-lg border dark:border-neutral-800">
            <table className="w-full text-sm">
              <thead className="bg-neutral-50 text-left text-neutral-500 dark:bg-neutral-900">
                <tr>
                  <th className="px-3 py-2 font-medium">Key</th>
                  <th className="px-3 py-2 font-medium">Group</th>
                  <th className="px-3 py-2 font-medium">Used?</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key_code} className="border-t dark:border-neutral-800">
                    <td className="px-3 py-1.5">
                      <button
                        type="button"
                        onClick={() => { void navigator.clipboard.writeText(r.key_code); setCopied(r.key_code) }}
                        title="Click to copy"
                        className="font-mono text-xs underline-offset-2 hover:underline"
                      >
                        {copied === r.key_code ? 'copied' : r.key_code}
                      </button>
                    </td>
                    <td className="px-3 py-1.5 text-xs text-neutral-500">
                      {r.arm === 'treatment' ? 'progress bar' : 'no bar'}
                    </td>
                    <td className="px-3 py-1.5 text-xs text-neutral-500">
                      {r.status === 'not_started'
                        ? 'unused'
                        : `${r.answered_count}/${r.item_count} answered`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {rows.length > 0 && (
          <p className="mt-3 text-xs text-neutral-500">
            Open one &ldquo;no bar&rdquo; and one &ldquo;progress bar&rdquo; key
            in two different browsers (a normal window and an incognito one, so
            the two do not share a session). Apart from the bar, they should
            look identical.
          </p>
        )}
      </div>
    </section>
  )
}
