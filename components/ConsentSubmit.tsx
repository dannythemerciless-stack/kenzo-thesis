'use client'

import { useState } from 'react'
import { useFormStatus } from 'react-dom'

/**
 * Explicit consent checkbox plus the irreversible "begin" action.
 *
 * The button is disabled until the box is ticked AND stays disabled while the
 * action is in flight — double-submitting consent must not be possible. (The
 * server is idempotent about it anyway, but the clock starting twice would be
 * an alarming thing to leave to the server alone.)
 */
export function ConsentSubmit() {
  const [agreed, setAgreed] = useState(false)
  const { pending } = useFormStatus()

  return (
    <div className="space-y-5">
      <label className="flex cursor-pointer items-start gap-3 text-sm">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          className="mt-0.5 size-5 shrink-0 accent-neutral-900 dark:accent-white"
        />
        <span>
          I have read the information above, I am an enrolled UPLB
          undergraduate, and I consent to participate.
        </span>
      </label>

      <button
        type="submit"
        disabled={!agreed || pending}
        className="w-full rounded-lg bg-neutral-900 px-5 py-4 text-base font-medium text-white transition-colors hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
      >
        {pending ? 'Starting…' : 'Begin — the clock starts now'}
      </button>

      <p className="text-center text-xs text-neutral-500">
        Once you press this, the one-hour countdown begins and cannot be paused.
      </p>
    </div>
  )
}
