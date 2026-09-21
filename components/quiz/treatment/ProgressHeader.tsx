'use client'

import { ProgressBar } from '@/components/quiz/treatment/ProgressBar'
import type { TreatmentQuestionView } from '@/lib/types/quiz'

/**
 * Wraps the progress bar AND the reading of the count fields.
 *
 * Why this indirection exists: the treatment shell is code-split, but
 * Turbopack merges the two small shell modules into one shared chunk, which a
 * control participant does download. If the shell itself wrote
 * `view.answeredCount`, those identifiers would survive minification and sit
 * in the control participant's bundle — visible to anyone who opens devtools.
 *
 * By moving the property access in here, the shared chunk contains only
 * `<ProgressHeader view={question} />`, and every trace of progress — the
 * bar, the ARIA roles, and the field names — lives in a chunk that is fetched
 * only when this component actually renders. Verified by
 * scripts/check-blinding.sh.
 */
export default function ProgressHeader({ view }: { view: TreatmentQuestionView }) {
  return (
    <div className="pb-3">
      <ProgressBar answeredCount={view.answeredCount} totalCount={view.totalCount} />
    </div>
  )
}
