'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

import { login, type LoginState } from '@/app/admin/actions'

function Submit() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-lg bg-neutral-900 px-5 py-3 font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
    >
      {pending ? 'Checking…' : 'Open dashboard'}
    </button>
  )
}

export function AdminLogin() {
  const [state, action] = useActionState<LoginState, FormData>(login, {})

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-6">
      <div>
        <h1 className="text-xl font-semibold">Researcher dashboard</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Enter the dashboard key. This is not a participant access key.
        </p>
      </div>

      <form action={action} className="space-y-3">
        <input
          name="key"
          type="password"
          required
          autoFocus
          autoComplete="off"
          placeholder="Dashboard key"
          className="w-full rounded-lg border px-4 py-3 font-mono outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:focus-visible:ring-white"
        />
        {state.error && (
          <p role="alert" className="rounded-lg bg-red-50 px-4 py-2.5 text-sm text-red-900 dark:bg-red-950 dark:text-red-200">
            {state.error}
          </p>
        )}
        <Submit />
      </form>
    </main>
  )
}
