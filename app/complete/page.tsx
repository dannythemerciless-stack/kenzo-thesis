import { requireState } from '@/lib/dal/attempt'
import { SurveyForm } from '@/components/SurveyForm'

export const metadata = { title: 'Finished' }

export default async function CompletePage() {
  const { completed, correct, answered, codename } = await requireState('survey')

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <header className="mb-10 space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight">
          {completed ? 'You finished the quiz.' : 'Time is up.'}
        </h1>
        <p className="text-neutral-600 dark:text-neutral-400">
          {completed
            ? 'You answered every question within the hour.'
            : 'The one-hour limit was reached. Everything you answered still counts.'}
        </p>
      </header>

      <dl className="mb-10 grid grid-cols-2 gap-4">
        <div className="rounded-xl border p-5 dark:border-neutral-800">
          <dt className="text-sm text-neutral-500">Questions answered</dt>
          <dd className="mt-1 font-mono text-2xl tabular-nums">{answered ?? 0}</dd>
        </div>
        <div className="rounded-xl border p-5 dark:border-neutral-800">
          <dt className="text-sm text-neutral-500">Correct answers</dt>
          <dd className="mt-1 font-mono text-2xl tabular-nums">{correct ?? 0}</dd>
        </div>
      </dl>

      {/* No ranking is shown during the field window: an early finisher who
          learns the competitive bar would tell friends, and later participants
          would calibrate effort to it. */}
      <p className="mb-10 rounded-lg border border-neutral-300 bg-neutral-50 px-4 py-3 text-sm dark:border-neutral-700 dark:bg-neutral-900">
        Rankings are published after data collection closes. You will appear as{' '}
        <span className="font-mono font-medium">{codename}</span>. Keep your
        access key — it is how prizes are claimed.
      </p>

      <section className="border-t pt-10 dark:border-neutral-800">
        <h2 className="mb-2 text-lg font-semibold">One last thing</h2>
        <p className="mb-8 text-sm text-neutral-600 dark:text-neutral-400">
          Five quick ratings about how the task felt. There are no right
          answers, and this does not affect your score or the prize.
        </p>
        <SurveyForm />
      </section>
    </main>
  )
}
