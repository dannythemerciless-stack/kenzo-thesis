/**
 * The payload contract between server and browser.
 *
 * The type split is load-bearing, not cosmetic. `BaseQuestionView` is what a
 * CONTROL participant receives, and it structurally cannot carry progress:
 * there is no optional `totalCount` to forget to strip. The treatment view is
 * a separate type produced by a separate DAL function, so the control code
 * path never computes the number 100 at all.
 */

export type QuestionOption = {
  /** Opaque UUID. Carries no ordering or correctness information. */
  id: string
  text: string
}

/** Sent to BOTH groups. Nothing here reveals position or total. */
export type BaseQuestionView = {
  /** Rotates on every serve. The client submits this, never a position. */
  nonce: string
  stem: string
  options: QuestionOption[]
  /** Absolute epoch ms, from the Postgres clock. */
  deadlineAtMs: number
  /** Absolute epoch ms, from the same clock, for skew correction. */
  serverNowMs: number
  /** Set when the server rejected a stale submission and re-synced. */
  resync?: boolean
}

/** TREATMENT ONLY. Never imported by the control shell. */
export type TreatmentQuestionView = BaseQuestionView & {
  answeredCount: number
  totalCount: number
}

export type TerminalView = {
  terminal: 'completed' | 'timed_out' | 'no_session'
}

export type ControlNext = BaseQuestionView | TerminalView
export type TreatmentNext = TreatmentQuestionView | TerminalView

export function isTerminal(v: ControlNext | TreatmentNext): v is TerminalView {
  return 'terminal' in v
}
