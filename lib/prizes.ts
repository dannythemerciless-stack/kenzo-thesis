/**
 * The prize structure — defined ONCE, used everywhere.
 *
 * Consent, results, debrief and the leaderboard all read from here, so the
 * amounts a participant is promised cannot drift apart from the amounts the
 * leaderboard displays. If this changes, every surface changes with it.
 *
 * ⚠ Changing these numbers changes the experiment, not just the copy. The
 * tournament incentive in Ch. III is specified over this payoff structure, so
 * the expected-utility function has to match:
 *
 *   E(Uᵢ) = P₁·U(500) + P₂·U(100) + (1 − P₁ − P₂)·U(0) − C(eᵢ)
 *
 * where P₁ is the subjective probability of placing top 3 and P₂ of placing
 * 4th–10th. (The earlier flat "top 10 × PHP 500" was a two-outcome lottery;
 * this is a three-outcome one, and the paper needs to say so.)
 */

export type PrizeTier = {
  /** Inclusive upper bound of the rank range. */
  maxRank: number
  /** PHP awarded to each participant in this tier. */
  amount: number
  label: string
}

export const PRIZE_TIERS: readonly PrizeTier[] = [
  { maxRank: 3, amount: 500, label: 'Top 3' },
  { maxRank: 10, amount: 100, label: '4th – 10th' },
] as const

/** The last rank that wins anything. */
export const LAST_PAID_RANK = PRIZE_TIERS[PRIZE_TIERS.length - 1].maxRank

/** PHP for a given rank, or 0 if it wins nothing. */
export function prizeForRank(rank: number): number {
  for (const tier of PRIZE_TIERS) {
    if (rank <= tier.maxRank) return tier.amount
  }
  return 0
}

/** Which visual tier a rank belongs to. 0 = top, 1 = lower, -1 = unplaced. */
export function prizeTierIndex(rank: number): number {
  for (const [i, tier] of PRIZE_TIERS.entries()) {
    if (rank <= tier.maxRank) return i
  }
  return -1
}

/** Total pot, for the methodology section. */
export const TOTAL_PRIZE_POOL = PRIZE_TIERS.reduce((sum, tier, i) => {
  const from = i === 0 ? 1 : PRIZE_TIERS[i - 1].maxRank + 1
  return sum + (tier.maxRank - from + 1) * tier.amount
}, 0)

/** One sentence for participant-facing copy. Keep it plain. */
export const PRIZE_SUMMARY =
  'The three highest scores each receive PHP 500, and ranks 4 to 10 each receive PHP 100.'
