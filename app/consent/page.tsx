import { requireState } from '@/lib/dal/attempt'
import { beginAttempt } from '@/app/actions/session'
import { ConsentSubmit } from '@/components/ConsentSubmit'

export const metadata = { title: 'Before you begin' }

/**
 * IMPORTANT — this text is shown IDENTICALLY to both groups.
 *
 * It deliberately does not state how many questions the quiz contains. The
 * manipulated variable is the progress bar alone, so the control group must
 * not be able to compute a progress ratio even in principle, and the treatment
 * group must not receive the total in words either — their proximity cue is
 * purely spatial, from how full the bar is.
 *
 * Any edit that adds a number here changes the experiment. Do not add one.
 */
export default async function ConsentPage() {
  const { codename } = await requireState('consent')

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <header className="mb-8 space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Before you begin</h1>
        <p className="text-sm text-neutral-500">
          You are participating as{' '}
          <span className="font-mono font-medium text-neutral-900 dark:text-neutral-100">
            {codename}
          </span>
          . This is the only name attached to your responses.
        </p>
      </header>

      <div className="space-y-6 text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">
        <section className="space-y-2">
          <h2 className="font-semibold text-neutral-900 dark:text-neutral-100">
            What you will do
          </h2>
          <p>
            You will answer a series of multiple-choice mathematics questions.
            Each question has four options and exactly one correct answer. You
            must choose an answer to move on — questions cannot be skipped, and
            you cannot return to a previous question.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-semibold text-neutral-900 dark:text-neutral-100">
            Time limit
          </h2>
          <p>
            You have <strong>one hour</strong> from the moment you begin. A
            countdown is shown throughout.
          </p>
          <p className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            The clock keeps running even if you close the tab or lose your
            connection. You may return with the same access key and continue
            where you left off, but no time is given back. Please begin only
            when you can work uninterrupted.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-semibold text-neutral-900 dark:text-neutral-100">
            Prize
          </h2>
          <p>
            The <strong>three highest scores</strong> across all participants
            each receive <strong>PHP 500</strong>. Ranks{' '}
            <strong>4 to 10</strong> each receive <strong>PHP 100</strong>.
            Ties are broken by the shorter completion time. Rankings are
            published after data collection closes, under codenames only.
          </p>
          <p>
            While the quiz is open you will not be able to see anyone else&rsquo;s
            score or your own ranking.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-semibold text-neutral-900 dark:text-neutral-100">
            Fair participation
          </h2>
          {/* This sentence is what makes the silent focus-loss logging
              ethically covered: participants are told up front, rather than
              being told mid-task that they can no longer win — which would
              remove the incentive for the rest of the hour and contaminate the
              dependent variable. */}
          <p>
            Please work on your own, without other people, other applications or
            other devices. The application records when this tab loses focus.
            Excessive switching away from the quiz may make you ineligible for
            the prize, though your responses will still count toward the
            research.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-semibold text-neutral-900 dark:text-neutral-100">
            Privacy and voluntary participation
          </h2>
          <p>
            Participation is entirely voluntary. This application stores no
            name, email address or student number — only your access key, your
            codename, your answers and timing information. Data is handled in
            accordance with the Data Privacy Act of 2012 and reported only in
            aggregate.
          </p>
          <p>
            A full explanation of the study&rsquo;s purpose is shown at the end.
          </p>
        </section>
      </div>

      <form action={beginAttempt} className="mt-10 border-t pt-8 dark:border-neutral-800">
        <ConsentSubmit />
      </form>
    </main>
  )
}
