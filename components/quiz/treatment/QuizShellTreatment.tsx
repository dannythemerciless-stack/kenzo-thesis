'use client'

import dynamic from 'next/dynamic'

import { useQuizRunner } from '@/components/quiz/shared/useQuizRunner'
import { Countdown } from '@/components/quiz/shared/Countdown'
import { QuestionCard } from '@/components/quiz/shared/QuestionCard'
import { FocusWarning } from '@/components/quiz/shared/FocusWarning'
import type { TerminalView, TreatmentQuestionView } from '@/lib/types/quiz'

// Loaded from inside the treatment shell so that the bar — and the reading of
// the count fields — land in a chunk fetched only by a browser that is
// actually rendering this shell. See ProgressHeader for why the indirection.
const ProgressHeader = dynamic(
  () => import('@/components/quiz/treatment/ProgressHeader'),
  { loading: () => <div className="h-2.5 w-full" /> },
)

/**
 * TREATMENT GROUP — identical to the control shell in every respect except
 * the ProgressBar below. Keep it that way: any layout, wording or spacing
 * difference between the two shells becomes part of the manipulation.
 */
export default function QuizShellTreatment({
  initial,
}: {
  initial: TreatmentQuestionView | TerminalView
}) {
  const { question, remainingMs, locked, selected, answer, focusWarning } =
    useQuizRunner<TreatmentQuestionView>(initial)

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
        <div className="mx-auto max-w-2xl px-6">
          <div className="flex h-14 items-center justify-between">
            <span className="text-sm font-medium text-neutral-500">
              Time remaining
            </span>
            <Countdown remainingMs={remainingMs} />
          </div>
          <ProgressHeader view={question} />
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
