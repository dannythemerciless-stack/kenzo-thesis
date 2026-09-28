'use client'

import { useState, useTransition } from 'react'

import { withdrawParticipant } from '@/app/admin/actions'

export function DataTools() {
  const [pending, start] = useTransition()
  const [key, setKey] = useState('')
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  return (
    <section className="mb-10 grid gap-4 md:grid-cols-2">
      <div className="rounded-xl border p-4 dark:border-neutral-800">
        <h2 className="font-semibold">Download the data</h2>
        <p className="mt-1 mb-4 text-sm text-neutral-500">
          Join these to your Google Form responses on the <code>key_code</code>{' '}
          column to attach the demographics.
        </p>
        <div className="flex flex-col gap-2">
          <a
            href="/api/export?dataset=wide&via=admin"
            className="rounded-lg border px-4 py-2.5 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Main analysis file
            <span className="block text-xs font-normal text-neutral-500">
              one row per participant — this is the one for STATA
            </span>
          </a>
          <a
            href="/api/export?dataset=timing&via=admin"
            className="rounded-lg border px-4 py-2.5 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Per-question timing
            <span className="block text-xs font-normal text-neutral-500">
              one row per question per person — for the pace analysis
            </span>
          </a>
        </div>
      </div>

      <div className="rounded-xl border p-4 dark:border-neutral-800">
        <h2 className="font-semibold">Remove one participant</h2>
        <p className="mt-1 mb-4 text-sm text-neutral-500">
          If someone asks to withdraw. Deletes their attempt and answers; the key
          row stays so your participant count still adds up.
        </p>
        <div className="flex gap-2">
          <input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="KQ-XXXX-XXXX"
            className="min-w-0 flex-1 rounded-lg border px-3 py-2 font-mono text-sm uppercase dark:border-neutral-700 dark:bg-neutral-900"
          />
          <button
            disabled={pending || !key.trim()}
            onClick={() => start(async () => {
              setResult(await withdrawParticipant(key))
              setKey('')
            })}
            className="shrink-0 rounded-lg border px-4 py-2 text-sm font-medium disabled:opacity-40 dark:border-neutral-700"
          >
            {pending ? '…' : 'Remove'}
          </button>
        </div>
        {result && (
          <p className={`mt-3 rounded-lg px-3 py-2 text-sm ${
            result.ok
              ? 'bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200'
              : 'bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-200'
          }`}>
            {result.message}
          </p>
        )}
      </div>
    </section>
  )
}
