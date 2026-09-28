'use client'

import { useState, useTransition } from 'react'

import { previewIssue, confirmIssue, type IssuePreview } from '@/app/admin/actions'

export function IssueKeys() {
  const [pending, start] = useTransition()
  const [preview, setPreview] = useState<IssuePreview | null>(null)
  const [done, setDone] = useState<{ count: number; csv: string } | null>(null)

  function onUpload(form: FormData) {
    setDone(null)
    start(async () => setPreview(await previewIssue(form)))
  }

  function onConfirm() {
    if (!preview?.token) return
    start(async () => {
      const r = await confirmIssue(preview.token!)
      if (r.ok && r.mailmerge) {
        setDone({ count: r.count ?? 0, csv: r.mailmerge })
        setPreview(null)
      } else {
        setPreview({ ok: false, error: r.message })
      }
    })
  }

  function download() {
    if (!done) return
    const url = URL.createObjectURL(new Blob([done.csv], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `mailmerge-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <section className="mb-10">
      <h2 className="mb-1 text-lg font-semibold">Issue access keys</h2>
      <p className="mb-3 text-sm text-neutral-500">
        Upload the Google Forms responses export. People who already have a key
        are skipped, so it is safe to upload the same file again after more
        sign-ups.
      </p>

      <div className="rounded-xl border p-4 dark:border-neutral-800">
        <form action={onUpload} className="flex flex-wrap items-center gap-3">
          <input
            type="file"
            name="file"
            accept=".csv,text/csv"
            required
            className="text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-neutral-900 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white dark:file:bg-white dark:file:text-neutral-900"
          />
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg border px-4 py-2 text-sm font-medium disabled:opacity-50 dark:border-neutral-700"
          >
            {pending ? 'Reading…' : 'Check file'}
          </button>
        </form>

        {preview && !preview.ok && (
          <p className="mt-4 rounded-lg bg-red-50 px-4 py-3 text-sm whitespace-pre-wrap text-red-900 dark:bg-red-950 dark:text-red-200">
            {preview.error}
          </p>
        )}

        {preview?.ok && preview.plan && (
          <div className="mt-4 space-y-4">
            <div className="grid grid-cols-3 gap-3 text-sm">
              <div className="rounded-lg bg-neutral-50 p-3 dark:bg-neutral-900">
                <div className="text-neutral-500">Rows in file</div>
                <div className="font-mono text-lg">{preview.totalRows}</div>
              </div>
              <div className="rounded-lg bg-neutral-50 p-3 dark:bg-neutral-900">
                <div className="text-neutral-500">Already have a key</div>
                <div className="font-mono text-lg">{preview.alreadyIssued}</div>
              </div>
              <div className="rounded-lg bg-emerald-50 p-3 dark:bg-emerald-950">
                <div className="text-emerald-700 dark:text-emerald-300">New keys</div>
                <div className="font-mono text-lg">{preview.plan.records.length}</div>
              </div>
            </div>

            <p className="text-xs text-neutral-500">
              Matched columns: <span className="font-mono">{preview.emailColumn}</span> for email,{' '}
              <span className="font-mono">{preview.codenameColumn}</span> for codename.
            </p>

            {preview.plan.pii.length > 0 && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950">
                <div className="font-medium text-amber-900 dark:text-amber-200">
                  These codenames may identify someone
                </div>
                <p className="mt-1 text-amber-800 dark:text-amber-300">
                  Codenames are published with the final rankings. Consider asking
                  these people to pick a different one before you send their key.
                </p>
                <ul className="mt-2 font-mono text-xs text-amber-900 dark:text-amber-200">
                  {preview.plan.pii.map((p) => <li key={p.email}>{p.codename}</li>)}
                </ul>
              </div>
            )}

            {preview.plan.notes.length > 0 && (
              <details className="text-sm">
                <summary className="cursor-pointer text-neutral-500">
                  {preview.plan.notes.length} thing(s) handled automatically
                </summary>
                <ul className="mt-2 list-inside list-disc text-neutral-600 dark:text-neutral-400">
                  {preview.plan.notes.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
              </details>
            )}

            {preview.plan.records.length > 0 ? (
              <button
                onClick={onConfirm}
                disabled={pending}
                className="rounded-lg bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
              >
                {pending ? 'Issuing…' : `Issue ${preview.plan.records.length} key(s)`}
              </button>
            ) : (
              <p className="text-sm text-neutral-500">
                Everyone in this file already has a key. Nothing to do.
              </p>
            )}
          </div>
        )}

        {done && (
          <div className="mt-4 rounded-lg border border-emerald-300 bg-emerald-50 p-4 dark:border-emerald-900 dark:bg-emerald-950">
            <div className="font-medium text-emerald-900 dark:text-emerald-200">
              {done.count} key(s) issued
            </div>
            <p className="mt-1 mb-3 text-sm text-emerald-800 dark:text-emerald-300">
              Download the mail-merge file and send it. It contains only the new
              people, so nobody gets a second email.
            </p>
            <button
              onClick={download}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
            >
              Download mail-merge CSV
            </button>
          </div>
        )}
      </div>
    </section>
  )
}
