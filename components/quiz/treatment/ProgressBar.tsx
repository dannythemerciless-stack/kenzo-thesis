'use client'

/**
 * THE INDEPENDENT VARIABLE.
 *
 * This component is the entire manipulation. It exists only in the treatment
 * chunk and is never downloaded by a control participant.
 *
 * Design constraints that come from the thesis, not from taste:
 *
 *  - PURELY SPATIAL. No "71 / 100", no percentage, no numeral of any kind.
 *    Chapter III theorises the goal gradient as a reduction in perceived
 *    SPATIAL distance to the target, so the cue must be the fill of the bar
 *    and nothing else. Adding a number would test a different construct.
 *  - CONTINUOUS. It advances on every submitted answer, giving the
 *    "continuous, visual reduction in distance to completion" the design
 *    specifies.
 *  - The accessible name is intentionally non-numeric too, so a screen-reader
 *    user in the treatment group gets the same spatial framing rather than a
 *    percentage read aloud.
 */
export function ProgressBar({
  answeredCount,
  totalCount,
}: {
  answeredCount: number
  totalCount: number
}) {
  const fraction = totalCount > 0 ? Math.min(1, answeredCount / totalCount) : 0

  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={totalCount}
      aria-valuenow={answeredCount}
      aria-valuetext="Progress toward completion"
      aria-label="Progress toward completion"
      className="h-2.5 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800"
    >
      <div
        className="h-full rounded-full bg-emerald-500 transition-[width] duration-500 ease-out dark:bg-emerald-400"
        style={{ width: `${fraction * 100}%` }}
      />
    </div>
  )
}
