import dynamic from 'next/dynamic'
import { redirect } from 'next/navigation'

import { requireState } from '@/lib/dal/attempt'
import { getTokenHash } from '@/lib/dal/session'
import { getControlView, getTreatmentView } from '@/lib/dal/quiz'

/**
 * Two shells in two separate chunks, chosen on the server.
 *
 * `next/dynamic` is what makes the blinding physical rather than cosmetic: a
 * control participant's browser downloads only the control chunk, so
 * ProgressBar.tsx is not merely hidden by CSS or gated behind a prop — it is
 * not in their document at all, and there is nothing to find in devtools.
 */
const ControlShell = dynamic(
  () => import('@/components/quiz/control/QuizShellControl'),
)
const TreatmentShell = dynamic(
  () => import('@/components/quiz/treatment/QuizShellTreatment'),
)

// Never "Question 34 of 100". The tab title is a leak vector too.
export const metadata = { title: 'Quiz' }

// Hobby caps at 60s; this also becomes the default for the page's Server
// Actions. `preferredRegion` is deprecated in Next 16 — set the function
// region in Vercel project settings instead.
export const maxDuration = 15

export default async function QuizPage() {
  // Reading the session cookie opts this route into dynamic rendering
  // automatically, so no `export const dynamic = 'force-dynamic'` is needed.
  const { arm } = await requireState('in_progress')

  const tokenHash = await getTokenHash()
  if (!tokenHash) redirect('/?e=session')

  if (arm === 'treatment') {
    const view = await getTreatmentView(tokenHash)
    return <TreatmentShell initial={view} />
  }

  // `view` is typed BaseQuestionView | TerminalView. There is no count in it
  // to forget to strip, because the type has no such field.
  const view = await getControlView(tokenHash)
  return <ControlShell initial={view} />
}
