import { db } from '@/lib/supabase/admin'
import { isAdmin } from '@/lib/admin/auth'
import { AdminLogin } from '@/components/admin/AdminLogin'
import { Switches } from '@/components/admin/Switches'
import { IssueKeys } from '@/components/admin/IssueKeys'
import { Participants } from '@/components/admin/Participants'
import { DataTools } from '@/components/admin/DataTools'
import { DangerZone } from '@/components/admin/DangerZone'
import { logout } from './actions'

export const metadata = { title: 'Researcher dashboard', robots: { index: false } }

type Row = {
  key_code: string
  codename: string
  arm: string
  block: number
  is_test: boolean
  started: boolean
  status: string
  answered_count: number | null
  correct_count: number | null
  item_count: number | null
  effort_sec: number | null
  focus_loss_count: number | null
  disqualified: boolean | null
  started_at: string | null
  surveyed: boolean
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-xl border p-4 dark:border-neutral-800">
      <div className="text-xs tracking-wide text-neutral-500 uppercase">{label}</div>
      <div className="mt-1 font-mono text-2xl tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-neutral-500">{hint}</div>}
    </div>
  )
}

export default async function AdminPage() {
  if (!(await isAdmin())) return <AdminLogin />

  const [{ data: cfg }, { data: rows }, { data: preflight }] = await Promise.all([
    db.from('study_config').select('*').single(),
    db.from('v_admin_participants').select('*'),
    db.from('v_preflight_failures').select('*'),
  ])

  const all = (rows ?? []) as Row[]
  const real = all.filter((r) => !r.is_test && r.block < 900)
  const started = real.filter((r) => r.started)

  const inProgress = started.filter((r) => r.status === 'in_progress').length
  const completed = started.filter((r) => r.status === 'completed').length
  const timedOut = started.filter((r) => r.status === 'timed_out').length
  const flagged = started.filter((r) => r.disqualified).length
  const treatment = real.filter((r) => r.arm === 'treatment').length

  const { count: qCount } = await db
    .from('questions').select('id', { count: 'exact', head: true })

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Researcher dashboard</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Goal proximity and task persistence · UPLB Economics
          </p>
        </div>
        <form action={logout}>
          <button className="rounded-lg border px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-900">
            Sign out
          </button>
        </form>
      </header>

      {/* ---------------------------------------------------------- status -- */}
      <section className="mb-10">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Keys issued" value={real.length} hint={`${treatment} with bar · ${real.length - treatment} without`} />
          <Stat label="Started" value={started.length} hint={`${real.length - started.length} not yet`} />
          <Stat label="Finished" value={completed + timedOut} hint={`${completed} completed · ${timedOut} ran out of time`} />
          <Stat label="In progress" value={inProgress} hint={inProgress ? 'taking it right now' : 'nobody right now'} />
        </div>

        {preflight && preflight.length > 0 && (
          <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950">
            <div className="mb-1 font-medium text-amber-900 dark:text-amber-200">
              Things to look at before collecting data
            </div>
            <ul className="list-inside list-disc text-amber-800 dark:text-amber-300">
              {preflight.map((f: { check_name: string; detail: unknown }) => (
                <li key={f.check_name}>
                  {({
                    pool_not_locked: 'The question pool is unlocked, so real keys will be refused. Lock it below.',
                    demo_rows_present: 'Synthetic demo participants are still in the data.',
                    arm_imbalance: 'A completed block of ten is not split 5 and 5.',
                    pool_size: 'The number of questions does not match the expected count.',
                    question_bad_option_set: 'A question does not have four options with exactly one correct.',
                    multiple_partial_blocks: 'More than one block is part-filled.',
                  } as Record<string, string>)[f.check_name] ?? f.check_name}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <Switches
        poolLocked={cfg!.pool_locked}
        leaderboardPublic={cfg!.leaderboard_public}
        questionCount={qCount ?? 0}
        timeLimitSec={cfg!.time_limit_sec}
      />

      <IssueKeys />

      <Participants rows={real} flagged={flagged} />

      <DataTools />

      <DangerZone keyCount={real.length} attemptCount={started.length} />
    </main>
  )
}
