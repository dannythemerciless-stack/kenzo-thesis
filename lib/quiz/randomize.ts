/**
 * Per-participant randomization of question order and option order.
 *
 * This module is deliberately PURE and dependency-free so it can be unit
 * tested with an injected RNG. It is the single most validity-critical piece of
 * code in the project, for one reason:
 *
 *   The source answer key is severely position-biased. The correct option is C
 *   for ~62 of the 100 items, B for ~34, D for ~4, and A for NONE. A
 *   participant who notices that and answers all-C scores ~62/100 with
 *   essentially no effort, which would destroy both the tournament and the
 *   persistence measure.
 *
 * Shuffling the options per participant makes the correct answer land in each
 * rendered slot ~25% of the time, so no positional heuristic survives. Scoring
 * never touches a letter — see exp.submit_answer, which compares option IDs.
 */

import { createHash, randomInt } from 'node:crypto'

/** Returns a uniformly random integer in [0, maxExclusive). */
export type Rng = (maxExclusive: number) => number

/** Cryptographically secure by default; tests inject a deterministic one. */
export const secureRng: Rng = (maxExclusive) => randomInt(maxExclusive)

export type PoolQuestion = {
  id: string
  /** Every option belonging to this question, in any order. */
  optionIds: string[]
}

export type PlanRow = {
  /** 1-based position in this participant's sequence. */
  position: number
  question_id: string
  /** The option IDs in the order this participant will see them. */
  option_order: string[]
}

/**
 * Fisher-Yates. Unbiased, in contrast to the common `sort(() => rand - 0.5)`
 * idiom, which is not — and a biased shuffle here would be a biased instrument.
 * Returns a new array; the input is not mutated.
 */
export function shuffle<T>(input: readonly T[], rng: Rng = secureRng): T[] {
  const out = [...input]
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng(i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * Build one participant's randomization plan: questions in a shuffled order,
 * and within each question, the options in a shuffled order.
 */
export function buildPlan(pool: readonly PoolQuestion[], rng: Rng = secureRng): PlanRow[] {
  return shuffle(pool, rng).map((q, i) => ({
    position: i + 1,
    question_id: q.id,
    option_order: shuffle(q.optionIds, rng),
  }))
}

/**
 * Canonical serialization. This string MUST byte-match what
 * `exp.canonical_plan_text()` produces in Postgres, because `begin_attempt`
 * recomputes the hash server-side and refuses a plan whose hash does not match.
 *
 *   position:question_id:opt1,opt2,opt3,opt4     (one line per item, LF-joined)
 *
 * Published in the thesis appendix, so anyone can re-derive it from the
 * exported plan and confirm nothing was reshuffled after the fact.
 */
export function canonicalPlanText(plan: readonly PlanRow[]): string {
  return [...plan]
    .sort((a, b) => a.position - b.position)
    .map((r) => `${r.position}:${r.question_id}:${r.option_order.join(',')}`)
    .join('\n')
}

/** Lowercase hex sha256 of the canonical plan text. */
export function planHashHex(plan: readonly PlanRow[]): string {
  return createHash('sha256').update(canonicalPlanText(plan), 'utf8').digest('hex')
}

/**
 * Postgres `bytea` literal form, which is how a hash must be passed through
 * PostgREST: a `\x`-prefixed hex string.
 */
export function planHashBytea(plan: readonly PlanRow[]): string {
  return `\\x${planHashHex(plan)}`
}
