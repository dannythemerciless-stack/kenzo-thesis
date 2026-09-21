/**
 * Unit tests for the randomization. Run with:  pnpm test
 *
 * The slot-uniformity test is the important one: it is the evidence, for the
 * thesis defense, that the source answer key's C-bias cannot be exploited.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  shuffle,
  buildPlan,
  canonicalPlanText,
  planHashHex,
  type PoolQuestion,
  type Rng,
} from './randomize.ts'

/** Deterministic RNG so failures are reproducible. Mulberry32. */
function seededRng(seed: number): Rng {
  let a = seed >>> 0
  return (maxExclusive: number) => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296
    return Math.floor(r * maxExclusive)
  }
}

/** Mirrors the real pool: 100 items, 4 options each, option index 2 == "C". */
function makePool(n = 100): PoolQuestion[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `q${String(i + 1).padStart(3, '0')}`,
    optionIds: ['a', 'b', 'c', 'd'].map((L) => `q${String(i + 1).padStart(3, '0')}-${L}`),
  }))
}

describe('shuffle', () => {
  it('returns a permutation and does not mutate the input', () => {
    const input = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8])
    const out = shuffle(input, seededRng(1))
    assert.deepEqual([...out].sort((x, y) => x - y), [...input])
    assert.deepEqual(input, [1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('is unbiased — every element reaches every position at ~1/n', () => {
    const N = 5
    const TRIALS = 60_000
    const counts = Array.from({ length: N }, () => new Array(N).fill(0))
    const rng = seededRng(42)

    for (let t = 0; t < TRIALS; t++) {
      shuffle([0, 1, 2, 3, 4], rng).forEach((value, pos) => counts[value][pos]++)
    }

    const expected = TRIALS / N
    for (let v = 0; v < N; v++) {
      for (let p = 0; p < N; p++) {
        const deviation = Math.abs(counts[v][p] - expected) / expected
        assert.ok(
          deviation < 0.06,
          `value ${v} at position ${p}: ${counts[v][p]} vs expected ${expected} (${(deviation * 100).toFixed(1)}% off)`,
        )
      }
    }
  })
})

describe('buildPlan', () => {
  it('covers every question exactly once, positions 1..N', () => {
    const pool = makePool(100)
    const plan = buildPlan(pool, seededRng(7))

    assert.equal(plan.length, 100)
    assert.deepEqual(
      plan.map((r) => r.position),
      Array.from({ length: 100 }, (_, i) => i + 1),
    )
    assert.equal(new Set(plan.map((r) => r.question_id)).size, 100)
  })

  it('keeps each option set intact, only reordered', () => {
    const pool = makePool(20)
    const byId = new Map(pool.map((q) => [q.id, [...q.optionIds].sort()]))

    for (const row of buildPlan(pool, seededRng(9))) {
      assert.deepEqual([...row.option_order].sort(), byId.get(row.question_id))
    }
  })

  it('actually reorders questions', () => {
    const pool = makePool(100)
    const plan = buildPlan(pool, seededRng(3))
    const inOrder = plan.filter((r, i) => r.question_id === pool[i].id).length
    // With 100 items the expected number of fixed points is 1.
    assert.ok(inOrder < 10, `question order barely changed (${inOrder} fixed points)`)
  })

  it('gives two participants different plans', () => {
    const pool = makePool(100)
    const a = canonicalPlanText(buildPlan(pool, seededRng(1)))
    const b = canonicalPlanText(buildPlan(pool, seededRng(2)))
    assert.notEqual(a, b)
  })
})

describe('option-slot uniformity — the C-bias defense', () => {
  it('lands the correct answer in each slot ~25% of the time', () => {
    // The real source key: correct option is "C" (index 2) for ~62% of items,
    // and "A" (index 0) for NONE. If any of that survived shuffling, a
    // participant answering all-C would score ~62/100 for free.
    const PARTICIPANTS = 10_000
    const slotCounts = [0, 0, 0, 0]
    const rng = seededRng(2026)
    const pool = makePool(1)
    const correctId = 'q001-c' // the source-"C" option

    for (let p = 0; p < PARTICIPANTS; p++) {
      const [row] = buildPlan(pool, rng)
      slotCounts[row.option_order.indexOf(correctId)]++
    }

    const expected = PARTICIPANTS / 4
    slotCounts.forEach((count, slot) => {
      const deviation = Math.abs(count - expected) / expected
      assert.ok(
        deviation < 0.05,
        `slot ${slot}: ${count} (${((count / PARTICIPANTS) * 100).toFixed(1)}%), expected ~25%`,
      )
    })

    // And slot A (index 0) must be well represented, since it never occurs in
    // the source key at all.
    assert.ok(slotCounts[0] > expected * 0.95, 'slot A is under-represented')
  })
})

describe('canonicalPlanText', () => {
  it('matches the documented format exactly', () => {
    const text = canonicalPlanText([
      { position: 2, question_id: 'q2', option_order: ['x', 'y'] },
      { position: 1, question_id: 'q1', option_order: ['a', 'b', 'c'] },
    ])
    assert.equal(text, '1:q1:a,b,c\n2:q2:x,y')
  })

  it('is order-independent — sorted by position, not input order', () => {
    const rows = [
      { position: 1, question_id: 'q1', option_order: ['a'] },
      { position: 2, question_id: 'q2', option_order: ['b'] },
    ]
    assert.equal(canonicalPlanText(rows), canonicalPlanText([...rows].reverse()))
  })

  it('produces the same hash Postgres does', () => {
    // CROSS-LANGUAGE REGRESSION GUARD. This literal was verified against
    //   select encode(sha256(convert_to('1:q1:a,b,c,d','UTF8')),'hex');
    // If canonicalPlanText ever changes shape, exp.begin_attempt will start
    // rejecting every plan with 'plan hash mismatch' — and this test will tell
    // you why before you deploy it.
    const hash = planHashHex([
      { position: 1, question_id: 'q1', option_order: ['a', 'b', 'c', 'd'] },
    ])
    assert.equal(hash, '09914935c9069ec9c42b8e5ade09967a1e221a2eec9e20948827152275f8658b')
  })
})
