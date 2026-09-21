'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

import { startAttempt, type KeyEntryState } from '@/app/actions/session'

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-neutral-900 px-5 py-3 font-medium text-white transition-colors hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
    >
      {pending ? 'Checking…' : 'Continue'}
    </button>
  )
}

export function KeyEntryForm() {
  const [state, action] = useActionState<KeyEntryState, FormData>(startAttempt, {})

  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label htmlFor="key" className="text-sm font-medium">
          Access key
        </label>
        <input
          id="key"
          name="key"
          required
          autoFocus
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="KQ-XXXX-XXXX"
          aria-describedby={state.error ? 'key-error' : undefined}
          aria-invalid={state.error ? true : undefined}
          className="rounded-lg border border-neutral-300 px-4 py-3 font-mono text-lg tracking-widest uppercase outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:focus-visible:ring-white"
        />
        <p className="text-xs text-neutral-500">
          Case and dashes do not matter.
        </p>
      </div>

      {state.error && (
        <p
          id="key-error"
          role="alert"
          className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          {state.error}
        </p>
      )}

      <SubmitButton />
    </form>
  )
}
