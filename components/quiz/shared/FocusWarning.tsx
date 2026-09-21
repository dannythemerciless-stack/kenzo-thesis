'use client'

import { useEffect, useState } from 'react'

/**
 * Shown when the participant returns after switching away.
 *
 * WORDING IS DELIBERATE AND SHOULD NOT BE "IMPROVED".
 *
 * It says nothing about the prize, eligibility, or how many times they have
 * switched. Anything that implies "you can no longer win" would remove the
 * tournament incentive for the rest of the hour — and effort duration over
 * that hour is the dependent variable. Because only people who switch away
 * would see it, that contamination would be non-random, and no
 * with/without-disqualified robustness check could undo it.
 *
 * A neutral reminder discourages the behaviour without touching the payoff,
 * so persistence measured after it still means what the thesis says it means.
 *
 * Rendered identically for both groups.
 */
export function FocusWarning({ nonce }: { nonce: number }) {
  // Visibility is DERIVED from the nonce rather than mirrored into state, so
  // a new tab switch re-shows the banner without a synchronous setState in an
  // effect (which triggers a cascading render).
  const [dismissed, setDismissed] = useState(0)
  const visible = nonce > 0 && nonce !== dismissed

  useEffect(() => {
    if (!visible) return
    const id = setTimeout(() => setDismissed(nonce), 8000)
    return () => clearTimeout(id)
  }, [visible, nonce])

  if (!visible) return null

  return (
    <div
      role="alert"
      className="border-b border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950"
    >
      <div className="mx-auto flex max-w-2xl items-start gap-3 px-6 py-3">
        <svg
          aria-hidden
          viewBox="0 0 20 20"
          fill="currentColor"
          className="mt-0.5 size-5 shrink-0 text-red-600 dark:text-red-400"
        >
          <path
            fillRule="evenodd"
            d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.515 2.625H3.72c-1.345 0-2.188-1.458-1.515-2.625L8.485 2.495ZM10 5a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 10 5Zm0 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
            clipRule="evenodd"
          />
        </svg>
        <p className="text-sm text-red-900 dark:text-red-200">
          <span className="font-medium">This tab lost focus.</span>{' '}
          Please keep the quiz open and work without switching away.
        </p>
        <button
          type="button"
          onClick={() => setDismissed(nonce)}
          aria-label="Dismiss"
          className="ml-auto shrink-0 text-red-700 hover:text-red-900 dark:text-red-300 dark:hover:text-red-100"
        >
          <svg aria-hidden viewBox="0 0 20 20" fill="currentColor" className="size-5">
            <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
          </svg>
        </button>
      </div>
    </div>
  )
}
