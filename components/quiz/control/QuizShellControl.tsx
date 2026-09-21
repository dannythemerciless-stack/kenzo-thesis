'use client'

import { useQuizRunner } from '@/components/quiz/shared/useQuizRunner'
import { Countdown } from '@/components/quiz/shared/Countdown'
import { QuestionCard } from '@/components/quiz/shared/QuestionCard'
import { FocusWarning } from '@/components/quiz/shared/FocusWarning'
import type { BaseQuestionView, TerminalView } from '@/lib/types/quiz'

/**
 * CONTROL GROUP — no progress bar.
 *
 * This module must NEVER import anything from ../treatment. That is enforced
 * three further ways: the `initial` prop is typed BaseQuestionView (which has
 * no progress fields at all), an eslint no-restricted-imports rule, and a CI
 * grep over the built chunks.
 *
 * Note what is absent and must stay absent: no progress bar, no percentage,
 * no "question n", no count, no role="progressbar", no aria-valuenow, no
 * hidden counter in the DOM for a curious participant to find in devtools.
 */
export default function QuizShellControl({
  initial,
}: {
  initial: BaseQuestionView | TerminalView
}) {
  const { question, remainingMs, locked, selected, answer, focusWarning } =
    useQuizRunner(initial)

  if (!question) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-20 text-center text-neutral-500">
        Finishing up…
      </main>
    )
  }

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-10 border-b bg-white/80 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/80">
        <FocusWarning nonce={focusWarning} />
        <div className="mx-auto flex h-14 max-w-2xl items-center justify-between px-6">
          <span className="text-sm font-medium text-neutral-500">
            Time remaining
          </span>
          <Countdown remainingMs={remainingMs} />
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-6 py-10 sm:py-14">
        <QuestionCard
          stem={question.stem}
          options={question.options}
          disabled={locked}
          selected={selected}
          onAnswer={answer}
        />
      </main>
    </div>
  )
}
