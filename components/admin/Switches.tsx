'use client'

import { useState, useTransition } from 'react'

import { setPoolLocked, setLeaderboardPublic } from '@/app/admin/actions'

function Toggle({
  on, onChange, busy, onLabel, offLabel,
}: {
  on: boolean
  onChange: (v: boolean) => void
  busy: boolean
  onLabel: string
  offLabel: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={busy}
      onClick={() => onChange(!on)}
      className={`shrink-0 rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
        on
          ? 'bg-emerald-600 text-white hover:bg-emerald-700'
          : 'border border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900'
      }`}
    >
      {busy ? '…' : on ? onLabel : offLabel}
    </button>
  )
}

export function Switches({
  poolLocked, leaderboardPublic, questionCount, timeLimitSec,
}: {
  poolLocked: boolean
  leaderboardPublic: boolean
  questionCount: number
  timeLimitSec: number
}) {
  const [pending, start] = useTransition()
  const [locked, setLocked] = useState(poolLocked)
  const [pub, setPub] = useState(leaderboardPublic)

  return (
    <section className="mb-10">
      <h2 className="mb-3 text-lg font-semibold">Study controls</h2>
      <div className="divide-y rounded-xl border dark:divide-neutral-800 dark:border-neutral-800">
        <div className="flex items-center justify-between gap-6 p-4">
          <div>
            <div className="font-medium">
              Study is {locked ? 'open to participants' : 'closed'}
            </div>
            <p className="mt-0.5 text-sm text-neutral-500">
              {locked
                ? `Access keys work. The ${questionCount} questions are frozen and cannot be edited.`
                : 'Access keys are being REFUSED. Questions can still be edited. Turn this on before emailing anyone.'}
            </p>
          </div>
          <Toggle
            on={locked}
            busy={pending}
            onLabel="Open"
            offLabel="Closed"
            onChange={(v) => { setLocked(v); start(() => { void setPoolLocked(v) }) }}
          />
        </div>

        <div className="flex items-center justify-between gap-6 p-4">
          <div>
            <div className="font-medium">
              Final standings are {pub ? 'public' : 'hidden'}
            </div>
            <p className="mt-0.5 text-sm text-neutral-500">
              {pub
                ? 'Anyone can see the rankings. Turn this off while people are still taking the quiz.'
                : 'Hidden. Keep it this way during collection so early finishers cannot tell others the winning score.'}
            </p>
          </div>
          <Toggle
            on={pub}
            busy={pending}
            onLabel="Public"
            offLabel="Hidden"
            onChange={(v) => { setPub(v); start(() => { void setLeaderboardPublic(v) }) }}
          />
        </div>

        <div className="flex items-center justify-between gap-6 p-4 text-sm text-neutral-500">
          <span>Time limit per participant</span>
          <span className="font-mono">{Math.round(timeLimitSec / 60)} minutes</span>
        </div>
      </div>
    </section>
  )
}
