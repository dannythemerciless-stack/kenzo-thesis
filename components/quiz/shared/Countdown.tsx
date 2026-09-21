'use client'

/**
 * Identical for both groups. The countdown is a constant of the design, not
 * part of the manipulation: everyone is told there is one hour, so everyone
 * sees the same clock. Only the progress bar varies.
 */
export function Countdown({ remainingMs }: { remainingMs: number }) {
  const total = Math.max(0, Math.floor(remainingMs / 1000))
  const mm = String(Math.floor(total / 60)).padStart(2, '0')
  const ss = String(total % 60).padStart(2, '0')

  // Visual urgency in the last five minutes. Applied to both groups equally.
  const urgent = total <= 300

  return (
    <div
      role="timer"
      aria-live="off"
      aria-label={`${mm} minutes ${ss} seconds remaining`}
      className={`font-mono text-lg tabular-nums transition-colors ${
        urgent ? 'text-red-600 dark:text-red-400' : 'text-neutral-600 dark:text-neutral-400'
      }`}
    >
      {mm}:{ss}
    </div>
  )
}
