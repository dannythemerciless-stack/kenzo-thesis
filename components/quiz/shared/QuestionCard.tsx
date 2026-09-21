'use client'

import type { QuestionOption } from '@/lib/types/quiz'

/**
 * The question itself. Identical markup for both groups.
 *
 * Deliberately absent: any question NUMBER, any "n of N", any ordinal marker.
 * Option letters are rendered from the render index, not from any stored
 * label, and the option order differs per participant — so the position of the
 * correct answer is uniform across the four slots and the source key's C-bias
 * is unexploitable.
 */
const SLOT_LETTERS = ['A', 'B', 'C', 'D', 'E'] as const

export function QuestionCard({
  stem,
  options,
  disabled,
  selected,
  onAnswer,
}: {
  stem: string
  options: QuestionOption[]
  disabled: boolean
  selected: string | null
  onAnswer: (optionId: string) => void
}) {
  return (
    <div className="space-y-8">
      <h1 className="text-xl leading-relaxed font-medium text-balance sm:text-2xl">
        {stem}
      </h1>

      <div role="group" aria-label="Answer options" className="grid gap-3">
        {options.map((option, i) => {
          const isSelected = selected === option.id
          return (
            <button
              key={option.id}
              type="button"
              disabled={disabled}
              onClick={() => onAnswer(option.id)}
              aria-pressed={isSelected}
              className={`flex items-center gap-4 rounded-xl border px-5 py-4 text-left transition-colors ${
                isSelected
                  ? 'border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900'
                  : 'border-neutral-300 hover:border-neutral-900 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:border-white dark:hover:bg-neutral-900'
              } disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-neutral-300 disabled:hover:bg-transparent dark:disabled:hover:border-neutral-700`}
            >
              <span
                aria-hidden
                className={`flex size-8 shrink-0 items-center justify-center rounded-lg border font-mono text-sm ${
                  isSelected
                    ? 'border-white/40 dark:border-neutral-900/40'
                    : 'border-neutral-300 dark:border-neutral-700'
                }`}
              >
                {SLOT_LETTERS[i]}
              </span>
              <span className="text-base">{option.text}</span>
            </button>
          )
        })}
      </div>

      <p aria-live="polite" className="h-5 text-sm text-neutral-500">
        {disabled && selected ? 'Saving…' : ''}
      </p>
    </div>
  )
}
