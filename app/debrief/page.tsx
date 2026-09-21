import { requireState } from '@/lib/dal/attempt'
import { rpc } from '@/lib/supabase/admin'
import { getTokenHash } from '@/lib/dal/session'

export const metadata = { title: 'About this study' }

/**
 * Full debriefing. Required because the progress bar manipulation was not
 * disclosed beforehand — participants were not told that the interface varied
 * between groups, since telling them would have destroyed the effect being
 * measured.
 */
export default async function DebriefPage() {
  const { codename } = await requireState('debrief')

  const tokenHash = await getTokenHash()
  if (tokenHash) {
    try {
      await rpc('mark_debriefed', { p_token_hash: tokenHash })
    } catch {
      // Recording that the debrief was viewed must never block showing it.
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="mb-8 text-2xl font-semibold tracking-tight">
        Thank you — here is what this study was really about
      </h1>

      <div className="space-y-6 text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">
        <section className="space-y-2">
          <h2 className="font-semibold text-neutral-900 dark:text-neutral-100">
            What we did not tell you beforehand
          </h2>
          <p>
            Participants were randomly divided into two groups. One group saw a{' '}
            <strong>progress bar</strong> that filled as they answered. The
            other group saw no progress indicator at all. Everything else — the
            questions, the one-hour limit, the prize, the interface — was
            identical.
          </p>
          <p>
            We did not mention this in advance because knowing you were being
            observed for persistence would very likely have changed how long
            you persisted, which is precisely what the study measures.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-semibold text-neutral-900 dark:text-neutral-100">
            The question being asked
          </h2>
          <p>
            Economics usually assumes people decide how long to keep working by
            weighing the expected reward against the effort it costs. On that
            view, a purely cosmetic progress bar should change nothing at all:
            it alters no reward, no difficulty, and no deadline.
          </p>
          <p>
            The <strong>goal-gradient hypothesis</strong> predicts otherwise —
            that effort rises as a goal <em>appears</em> closer. This study
            tests whether making progress visible changes how long UPLB
            students persist at a demanding task, holding the actual economics
            of the task constant.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-semibold text-neutral-900 dark:text-neutral-100">
            Your data
          </h2>
          <p>
            Your answers, timing and completion status are stored under the
            codename{' '}
            <span className="font-mono font-medium text-neutral-900 dark:text-neutral-100">
              {codename}
            </span>
            . No name, email address or student number is stored with them.
            Results will be reported only in aggregate.
          </p>
          <p>
            The three highest scores each receive PHP 500, and ranks 4 to 10
            each receive PHP 100. Rankings are published under codenames once
            data collection closes.{' '}
            <strong>Keep your access key</strong> — it is how a prize is
            claimed.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-semibold text-neutral-900 dark:text-neutral-100">
            Questions or withdrawal
          </h2>
          <p>
            If you would like your data removed, or have any questions about
            the study, contact Kenzo Gavril Publico at{' '}
            <a
              href="mailto:kpublico@up.edu.ph"
              className="underline underline-offset-4"
            >
              kpublico@up.edu.ph
            </a>
            . Quote your codename.
          </p>
        </section>
      </div>

      <p className="mt-10 border-t pt-8 text-sm text-neutral-500 dark:border-neutral-800">
        You may now close this window. Thank you for your time and effort.
      </p>
    </main>
  )
}
