'use client'

import { useEffect } from 'react'

/**
 * Retry path, not a hard failure.
 *
 * Next 16's server-actions guide is explicit: Server Action IDs rotate on
 * deploy, so a participant still running the previous build hits "Failed to
 * find Server Action". Mid-experiment that would otherwise look like a crash
 * and lose the attempt. `reset()` re-fetches current server state, and because
 * every answer is already committed server-side, nothing is lost.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-6 text-center">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        Your progress is saved. Your answers and your remaining time are stored
        on the server, not in this browser — nothing has been lost.
      </p>
      <button
        onClick={reset}
        className="rounded-lg bg-neutral-900 px-5 py-3 font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900"
      >
        Continue
      </button>
      <p className="text-xs text-neutral-500">
        If this keeps happening, reload the page and enter your access key again.
      </p>
    </main>
  )
}
