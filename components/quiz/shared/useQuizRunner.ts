'use client'

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

import type { BaseQuestionView, TerminalView } from '@/lib/types/quiz'
import { submitAnswer, finalizeAttempt } from '@/app/quiz/actions'

/**
 * All the quiz mechanics that BOTH groups share.
 *
 * Deliberately generic over the view type and deliberately blind: nothing here
 * reads `answeredCount` or `totalCount`, so this module can be bundled into
 * the control chunk without leaking a progress affordance. Progress rendering
 * lives only in components/quiz/treatment/.
 */

const HEARTBEAT_MS = 15_000
const TICK_MS = 250

/**
 * Tab-switch accounting. Three constants, each solving a different problem.
 *
 * The original naive version counted every `visibilitychange`, and a single
 * Cmd-Tab produced ELEVEN events ~1.2s apart — inflating the count 2x, and
 * doing so differently depending on the participant's OS and window manager,
 * so the measure partly reflected their hardware rather than their behaviour.
 *
 * The fix is NOT a long threshold (that just lets a determined participant
 * switch away quickly and escape counting). It is to debounce the RETURN:
 * a burst of flapping focus events is collapsed into ONE away-period,
 * because the brief moments of focus in between never last long enough to
 * end the period. With flapping handled structurally, the minimum period can
 * be short.
 */

/** A period must last at least this long to count as a switch. */
const MIN_AWAY_MS = 300

/** Focus must be held continuously for this long before a period is over. */
const SETTLE_MS = 600

/** Report while still away, to catch someone who leaves and never returns. */
const AWAY_REPORT_MS = 3_000

type Result<V> = V | TerminalView

export function useQuizRunner<V extends BaseQuestionView>(initial: Result<V>) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [view, setView] = useState<Result<V>>(initial)
  const [locked, setLocked] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)

  const question = 'terminal' in view ? null : view
  const firstQuestion = 'terminal' in initial ? null : initial

  /**
   * serverNow - clientNow. Every payload carries both clocks, so a participant
   * whose device is ten minutes fast still sees the correct remaining time.
   * The device clock is only ever a delta source, never trusted absolutely.
   *
   * Starts at 0 and is corrected by the effect below on the first commit; the
   * initial `remainingMs` is taken straight from the server's own numbers, so
   * the very first paint is already right without reading the device clock
   * during render.
   */
  const skewRef = useRef(0)
  const deadlineRef = useRef(firstQuestion?.deadlineAtMs ?? 0)

  /** Milliseconds this tab has been hidden since the current question loaded. */
  const hiddenMsRef = useRef(0)
  const hiddenSinceRef = useRef<number | null>(null)
  const hideTimerRef = useRef<number | null>(null)
  const settleTimerRef = useRef<number | null>(null)
  const returnedAtRef = useRef<number | null>(null)
  const reportedHideRef = useRef(false)
  const expiredRef = useRef(false)

  /** Bumped each time the participant returns from a real tab switch. */
  const [focusWarning, setFocusWarning] = useState(0)

  const [remainingMs, setRemainingMs] = useState(() =>
    firstQuestion ? firstQuestion.deadlineAtMs - firstQuestion.serverNowMs : 0,
  )

  // Adopt the clocks from whichever payload is currently displayed.
  useEffect(() => {
    if (!question) return
    skewRef.current = question.serverNowMs - Date.now()
    deadlineRef.current = question.deadlineAtMs
  }, [question])

  const goTerminal = useCallback(() => {
    router.push('/complete')
  }, [router])

  const apply = useCallback(
    (next: Result<V>) => {
      if ('terminal' in next) {
        goTerminal()
        return
      }
      setView(next)
      setSelected(null)
      setLocked(false)
      hiddenMsRef.current = 0
      hiddenSinceRef.current = null
    },
    [goTerminal],
  )

  // ---- clock resync ------------------------------------------------------

  const resync = useCallback(async () => {
    try {
      const res = await fetch('/api/state', { cache: 'no-store' })
      if (!res.ok) return
      const data = (await res.json()) as {
        terminal?: string | null
        deadlineAtMs?: number | null
        serverNowMs?: number
      }
      if (data.terminal) {
        goTerminal()
        return
      }
      if (data.serverNowMs && data.deadlineAtMs) {
        skewRef.current = data.serverNowMs - Date.now()
        deadlineRef.current = data.deadlineAtMs
      }
    } catch {
      /* transient network failure; the next tick or answer resyncs */
    }
  }, [goTerminal])

  // ---- answering ---------------------------------------------------------

  const answer = useCallback(
    (optionId: string) => {
      if (!question || locked) return

      // Optimistic LOCK, not optimistic data: disable the options immediately
      // so perceived latency is near zero, but never guess the next question.
      setSelected(optionId)
      setLocked(true)

      // Close off any in-progress hidden interval so it is attributed here.
      if (hiddenSinceRef.current !== null) {
        hiddenMsRef.current += Date.now() - hiddenSinceRef.current
        hiddenSinceRef.current = Date.now()
      }

      startTransition(async () => {
        const next = (await submitAnswer(
          question.nonce,
          optionId,
          Date.now(),
          hiddenMsRef.current,
        )) as Result<V>
        apply(next)
      })
    },
    [question, locked, apply],
  )

  // ---- countdown ---------------------------------------------------------

  const handleExpiry = useCallback(() => {
    if (expiredRef.current) return
    expiredRef.current = true
    setLocked(true)

    // The CLIENT NEVER DECIDES TERMINATION. If the server disagrees — because
    // this device's clock ran fast — it returns corrected timestamps and we
    // unlock and carry on. Nobody loses working time to a bad clock.
    startTransition(async () => {
      const result = await finalizeAttempt()
      if (result.terminal) {
        goTerminal()
        return
      }
      skewRef.current = result.serverNowMs - Date.now()
      deadlineRef.current = result.deadlineAtMs
      expiredRef.current = false
      setLocked(false)
    })
  }, [goTerminal])

  useEffect(() => {
    if (!question) return

    // Recompute from timestamps on every tick rather than decrementing a
    // counter. A background tab throttled to one tick per minute therefore
    // still shows the correct value the instant it renders.
    const tick = () => {
      const left = deadlineRef.current - (Date.now() + skewRef.current)
      setRemainingMs(left)
      if (left <= 0) handleExpiry()
    }

    tick()
    const id = setInterval(tick, TICK_MS)
    return () => clearInterval(id)
  }, [question, handleExpiry])

  // ---- visibility: focus loss, hidden time, bfcache ----------------------

  useEffect(() => {
    if (!question) return

    const postFocusLoss = (dedupeKey: string) => {
      const body = JSON.stringify({ dedupeKey, clientAtMs: Date.now() })
      // sendBeacon survives page unload, which a Server Action would not — and
      // Next dispatches actions sequentially per client, so a focus report
      // would otherwise queue behind an in-flight answer.
      const sent = navigator.sendBeacon?.(
        '/api/focus',
        new Blob([body], { type: 'application/json' }),
      )
      if (!sent) {
        void fetch('/api/focus', {
          method: 'POST',
          body,
          headers: { 'content-type': 'application/json' },
          keepalive: true,
        }).catch(() => {})
      }
    }

    /** Report away-time without counting another switch. */
    const postHiddenTime = (ms: number) => {
      void fetch('/api/state', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hiddenMs: Math.round(ms) }),
      }).catch(() => {})
    }

    /**
     * "Away" means EITHER the tab is backgrounded OR the window lost focus.
     *
     * Both are needed, and using only the first is a real hole:
     * `visibilitychange` fires when the tab is hidden behind another tab or
     * the window is minimised, but NOT when the participant switches to
     * another application while the browser window stays on screen — which on
     * macOS is what Cmd-Tab usually does. Relying on visibility alone silently
     * missed exactly the case the measure exists to catch.
     *
     * `document.hasFocus()` covers the app switch; visibility covers the tab
     * switch and the minimise.
     */
    const isAway = () => document.visibilityState === 'hidden' || !document.hasFocus()

    const enterAway = () => {
      if (hiddenSinceRef.current !== null) return // already away
      hiddenSinceRef.current = Date.now()
      reportedHideRef.current = false

      // Only report once the absence is sustained. This also covers the
      // participant who leaves and never comes back: the timer fires while
      // they are away and the beacon still goes out.
      hideTimerRef.current = window.setTimeout(() => {
        if (isAway() && !reportedHideRef.current) {
          reportedHideRef.current = true
          postFocusLoss(crypto.randomUUID())
          postHiddenTime(AWAY_REPORT_MS)
        }
      }, AWAY_REPORT_MS)
    }

    const leaveAway = () => {
      if (hideTimerRef.current !== null) {
        clearTimeout(hideTimerRef.current)
        hideTimerRef.current = null
      }
      if (hiddenSinceRef.current === null) return // was not away

      // Measure to the moment focus came back, not to the end of the settle
      // window, or every period would be inflated by SETTLE_MS.
      const away = (returnedAtRef.current ?? Date.now()) - hiddenSinceRef.current
      hiddenSinceRef.current = null
      returnedAtRef.current = null

      if (away >= MIN_AWAY_MS) {
        if (reportedHideRef.current) {
          // Already counted by the timer; just top up the away-time.
          postHiddenTime(Math.max(0, away - AWAY_REPORT_MS))
        } else {
          // Background timers get throttled hard; catch it on return.
          postFocusLoss(crypto.randomUUID())
          postHiddenTime(away)
        }
        setFocusWarning((n) => n + 1)
      } else {
        // A sub-threshold blip — clicking the address bar and back, a
        // notification stealing focus for an instant. Not a switch, but the
        // time still happened, so it rides along with the next answer.
        hiddenMsRef.current += away
      }
      reportedHideRef.current = false
    }

    const onAwayChange = () => {
      if (isAway()) {
        // Going away again during the settle window means the focus blip was
        // flapping, not a real return — cancel it and stay in the same period.
        if (settleTimerRef.current !== null) {
          clearTimeout(settleTimerRef.current)
          settleTimerRef.current = null
        }
        enterAway()
        return
      }

      // Focus is back, but do not trust it yet.
      if (settleTimerRef.current !== null) return // already settling
      returnedAtRef.current = Date.now()
      settleTimerRef.current = window.setTimeout(() => {
        settleTimerRef.current = null
        leaveAway()
        void resync()
      }, SETTLE_MS)
    }

    // bfcache restore (tapping Back on mobile Safari). Without this the
    // participant sees a frozen timer and a stale question.
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) void resync()
    }

    document.addEventListener('visibilitychange', onAwayChange)
    window.addEventListener('blur', onAwayChange)
    window.addEventListener('focus', onAwayChange)
    window.addEventListener('pageshow', onPageShow)
    return () => {
      document.removeEventListener('visibilitychange', onAwayChange)
      window.removeEventListener('blur', onAwayChange)
      window.removeEventListener('focus', onAwayChange)
      window.removeEventListener('pageshow', onPageShow)
      if (hideTimerRef.current !== null) clearTimeout(hideTimerRef.current)
      if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current)
    }
  }, [question, resync])

  // ---- heartbeat ---------------------------------------------------------

  useEffect(() => {
    if (!question) return

    const beat = () => {
      // ONLY while visible. Sending while hidden would defeat the entire point
      // of engaged_duration_sec.
      if (document.visibilityState !== 'visible') return
      void fetch('/api/state', { method: 'POST', cache: 'no-store' }).catch(() => {})
    }

    const id = setInterval(beat, HEARTBEAT_MS)
    return () => clearInterval(id)
  }, [question])

  return {
    question,
    remainingMs: Math.max(0, remainingMs),
    locked: locked || isPending,
    selected,
    answer,
    focusWarning,
  }
}
