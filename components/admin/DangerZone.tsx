'use client'

import { useState, useTransition } from 'react'

import { wipeEverything } from '@/app/admin/actions'

export function DangerZone({ keyCount, attemptCount }: { keyCount: number; attemptCount: number }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [pending, start] = useTransition()
  const [result, setResult] = useState<string | null>(null)

  return (
    <section className="mb-16">
      <div className="rounded-xl border border-red-300 dark:border-red-900">
        <button
          onClick={() => setOpen(!open)}
          className="flex w-full items-center justify-between px-4 py-3 text-left"
        >
          <span className="font-semibold text-red-700 dark:text-red-400">Start over</span>
          <span className="text-sm text-neutral-500">{open ? 'Hide' : 'Show'}</span>
        </button>

        {open && (
          <div className="border-t border-red-200 p-4 dark:border-red-900">
            <p className="mb-1 text-sm">
              Permanently deletes <strong>{keyCount} key(s)</strong> and{' '}
              <strong>{attemptCount} attempt(s)</strong> with all their answers
              and survey responses.
            </p>
            <p className="mb-4 text-sm text-neutral-500">
              Your questions and settings are kept. There is no undo from here —
              if you might want the data back, download it first.
            </p>

            <div className="flex gap-2">
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Type WIPE"
                className="min-w-0 flex-1 rounded-lg border px-3 py-2 font-mono text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
              <button
                disabled={pending || text !== 'WIPE'}
                onClick={() => start(async () => {
                  const r = await wipeEverything(text)
                  setResult(r.message)
                  setText('')
                })}
                className="shrink-0 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
              >
                {pending ? 'Deleting…' : 'Delete everything'}
              </button>
            </div>

            {result && <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-400">{result}</p>}
          </div>
        )}
      </div>
    </section>
  )
}
