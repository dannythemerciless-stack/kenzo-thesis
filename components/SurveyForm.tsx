'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

import { submitSurvey, type SurveyState } from '@/app/complete/actions'

/** Appendix A, Section C. Wording kept verbatim so the appendix stays accurate. */
const LIKERT = [
  { name: 'exhaustion', label: 'Mental exhaustion' },
  { name: 'difficulty', label: 'Perceived difficulty of the questions' },
  { name: 'focus', label: 'Focus and concentration drain' },
  { name: 'stress', label: 'Stress from the timer' },
  { name: 'overall', label: 'Overall difficulty' },
] as const

const CONSIDERED = [
  { name: 'consider_forfeit', label: 'Giving up and closing the window' },
  { name: 'consider_slow', label: 'Slowing down to preserve mental endurance' },
  { name: 'consider_rush', label: 'Speeding up to reach the final question' },
  { name: 'consider_random', label: 'Answering without reading, to finish faster' },
  { name: 'consider_none', label: 'I did not feel significant fatigue' },
] as const

function Scale({ name, label }: { name: string; label: string }) {
  return (
    <fieldset className="border-t py-5 dark:border-neutral-800">
      <legend className="sr-only">{label}</legend>
      <div className="mb-3 text-sm font-medium">{label}</div>
      <div className="flex items-center gap-2">
        <span className="w-16 shrink-0 text-xs text-neutral-500">Not at all</span>
        <div className="flex flex-1 justify-between gap-1">
          {[1, 2, 3, 4, 5].map((n) => (
            <label
              key={n}
              className="group flex flex-1 cursor-pointer flex-col items-center gap-1.5"
            >
              <input
                type="radio"
                name={name}
                value={n}
                required
                className="peer sr-only"
              />
              <span className="flex size-10 items-center justify-center rounded-lg border font-mono text-sm transition-colors peer-checked:border-neutral-900 peer-checked:bg-neutral-900 peer-checked:text-white peer-focus-visible:ring-2 peer-focus-visible:ring-offset-2 dark:border-neutral-700 dark:peer-checked:border-white dark:peer-checked:bg-white dark:peer-checked:text-neutral-900">
                {n}
              </span>
            </label>
          ))}
        </div>
        <span className="w-16 shrink-0 text-right text-xs text-neutral-500">
          Extremely
        </span>
      </div>
    </fieldset>
  )
}

function Submit() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-lg bg-neutral-900 px-5 py-4 font-medium text-white transition-colors hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
    >
      {pending ? 'Submitting…' : 'Submit and finish'}
    </button>
  )
}

export function SurveyForm() {
  const [state, action] = useActionState<SurveyState, FormData>(submitSurvey, {})

  return (
    <form action={action} className="space-y-8">
      <div>
        {LIKERT.map((item) => (
          <Scale key={item.name} name={item.name} label={item.label} />
        ))}
      </div>

      <fieldset className="border-t pt-6 dark:border-neutral-800">
        <legend className="mb-1 text-sm font-medium">
          When you started to feel tired, did you consider any of these?
        </legend>
        <p className="mb-4 text-xs text-neutral-500">Select all that apply.</p>
        <div className="space-y-3">
          {CONSIDERED.map((c) => (
            <label key={c.name} className="flex cursor-pointer items-start gap-3 text-sm">
              <input
                type="checkbox"
                name={c.name}
                className="mt-0.5 size-5 shrink-0 accent-neutral-900 dark:accent-white"
              />
              <span>{c.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="border-t pt-6 dark:border-neutral-800">
        <label className="flex cursor-pointer items-start gap-3 text-sm">
          <input
            type="checkbox"
            name="heard_beforehand"
            className="mt-0.5 size-5 shrink-0 accent-neutral-900 dark:accent-white"
          />
          <span>
            Someone described this quiz to me before I took it. (This does not
            disqualify you — it just helps us interpret the results.)
          </span>
        </label>
      </fieldset>

      {state.error && (
        <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-900 dark:bg-red-950 dark:text-red-200">
          {state.error}
        </p>
      )}

      <Submit />
    </form>
  )
}
