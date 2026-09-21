/**
* Real-browser test of the tab-switch detector and its warning banner,
 * including the adversarial cases: fast deliberate switching, and a single
 * Cmd-Tab that flaps focus repeatedly.
 *
 *   pnpm dev                       # in one terminal
 *   node --env-file=.env.local scripts/browser-test.ts
 *
 * Drives headless Chrome over the DevTools Protocol. Exists because this
 * feature broke twice in ways that only appear in a browser:
 *
 *   1. The banner never rendered, because the state was never wired through.
 *   2. Detection missed application switches entirely — `visibilitychange`
 *      does not fire when you Cmd-Tab to another app while the browser window
 *      stays on screen, which is the single most common way a participant
 *      leaves the quiz.
 *
 * Neither was catchable from Node, a unit test, or the HTML. So: a browser.
 *
 * Focus itself is the one thing that cannot be simulated headlessly, so
 * `document.hasFocus` is stubbed with a flag this script controls. Everything
 * downstream of it — the handler, the thresholds, the banner, the network
 * calls, the database write — is the real code path.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'

import { makeClient, die } from './lib/client.ts'
import { buildPlan, planHashBytea, type PoolQuestion } from '../lib/quiz/randomize.ts'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BASE = 'http://localhost:3000'
const PORT = 9222

const db = makeClient()
let passed = 0
const failures: string[] = []

const ok = (cond: boolean, name: string) => {
  if (cond) { passed++; console.log(`  ✔ ${name}`) }
  else { failures.push(name); console.log(`  ✖ ${name}`) }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const hash = (t: string) => `\\x${createHash('sha256').update(t, 'utf8').digest('hex')}`

/** Minimal CDP client — one WebSocket, request/response by id. */
class Cdp {
  private ws!: WebSocket
  private id = 0
  private pending = new Map<number, (v: unknown) => void>()

  async connect(wsUrl: string) {
    this.ws = new WebSocket(wsUrl)
    await new Promise((res, rej) => {
      this.ws.onopen = () => res(null)
      this.ws.onerror = () => rej(new Error('CDP connect failed'))
    })
    this.ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data))
      const resolve = this.pending.get(msg.id)
      if (resolve) { this.pending.delete(msg.id); resolve(msg.result) }
    }
  }

  send<T = Record<string, unknown>>(method: string, params: unknown = {}): Promise<T> {
    const id = ++this.id
    return new Promise((resolve) => {
      this.pending.set(id, resolve as (v: unknown) => void)
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  /** Evaluate in the page and return the value. */
  async eval<T>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value: T } }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    return r.result?.value
  }

  close() { this.ws.close() }
}

async function main() {
  if (!(await fetch(BASE).then((r) => r.ok).catch(() => false))) {
    die('dev server is not running on :3000 — start it with `pnpm dev`')
  }

  // ---- a fresh control session -------------------------------------------
  await db.rpc('purge_test_sessions')
  await db.from('browser_sessions').delete().neq('token_hash', '\\x00')

  const { data: keys } = await db
    .from('participant_keys').select('id, key_code, arm').eq('is_test', true)
  const key = keys!.find((k) => k.arm === 'control')!

  const { data: qs } = await db
    .from('questions').select('id, question_options(id)').eq('is_active', true)
  const pool: PoolQuestion[] = qs!.map((q) => ({
    id: q.id as string,
    optionIds: (q.question_options as { id: string }[]).map((o) => o.id),
  }))

  const raw = `browsertest-${Date.now()}`
  await db.rpc('redeem_key', { p_key_code: key.key_code, p_token_hash: hash(raw), p_ttl_sec: 3600 })
  const plan = buildPlan(pool)
  await db.rpc('begin_attempt', {
    p_token_hash: hash(raw), p_plan: plan, p_plan_sha256: planHashBytea(plan), p_ua_family: 'cdp',
  })

  // ---- headless chrome ----------------------------------------------------
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    '--headless=new',
    '--no-first-run',
    '--user-data-dir=/tmp/gp-chrome-profile',
    'about:blank',
  ], { stdio: 'ignore' })

  const cdp = new Cdp()
  try {
    let wsUrl = ''
    for (let i = 0; i < 40; i++) {
      try {
        const tabs = await (await fetch(`http://localhost:${PORT}/json`)).json()
        const page = tabs.find((t: { type: string }) => t.type === 'page')
        if (page?.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break }
      } catch { /* not up yet */ }
      await sleep(250)
    }
    if (!wsUrl) die('could not reach Chrome DevTools')

    await cdp.connect(wsUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Network.enable')
    await cdp.send('Network.setCookie', {
      name: 'kq_sid', value: raw, domain: 'localhost', path: '/',
    })

    console.log('\n── loading /quiz as a control participant ──')
    await cdp.send('Page.navigate', { url: `${BASE}/quiz` })
    await sleep(4000) // compile + hydrate

    ok(await cdp.eval<boolean>(`!!document.querySelector('button')`), 'the quiz rendered')
    ok(!(await cdp.eval<boolean>(`!!document.querySelector('[role="progressbar"]')`)),
      'control sees no progress bar')

    // Stub the browser's focus source. Everything downstream is real code.
    await cdp.eval(`
      window.__focused = true;
      Object.defineProperty(document, 'hasFocus', {
        configurable: true, value: () => window.__focused,
      });
      true
    `)

    const bannerShown = () =>
      cdp.eval<boolean>(`document.body.innerText.includes('This tab lost focus')`)

    ok(!(await bannerShown()), 'no warning before switching away')

    const away = (ms: number) =>
      cdp.eval(`window.__focused = false; window.dispatchEvent(new Event('blur')); true`)
        .then(() => sleep(ms))
    const back = (ms = 1200) =>
      cdp.eval(`window.__focused = true; window.dispatchEvent(new Event('focus')); true`)
        .then(() => sleep(ms))
    const count = async () =>
      (await db.from('sessions').select('focus_loss_count').eq('key_id', key.id).single())
        .data!.focus_loss_count

    // ---- a true blip: under the minimum period, must NOT count ------------
    console.log('\n── a 150ms flick (address bar, notification) ──')
    await away(150)
    await back()
    ok(!(await bannerShown()), 'a 150ms flick shows no warning')
    ok((await count()) === 0, `a 150ms flick is not counted (count = ${await count()})`)

    // ---- ADVERSARIAL: a participant who knows and switches fast -----------
    console.log('\n── ADVERSARIAL: five deliberate 800ms switches ──')
    for (let i = 0; i < 5; i++) { await away(800); await back(900) }
    const fast = await count()
    ok(fast === 5, `all five fast switches were caught (count = ${fast})`)

    const { data: fastRow } = await db.from('sessions')
      .select('hidden_ms_total').eq('key_id', key.id).single()
    ok(fastRow!.hidden_ms_total >= 3500,
      `away-time accumulated across them (${fastRow!.hidden_ms_total}ms)`)

    // ---- ADVERSARIAL: a flapping burst must still be ONE switch -----------
    console.log('\n── ADVERSARIAL: one Cmd-Tab that flaps (the 11-event bug) ──')
    const before = await count()
    await cdp.eval(`
      window.__focused = false;
      for (let i = 0; i < 6; i++) {
        setTimeout(() => {
          window.__focused = (i % 2 === 1);
          window.dispatchEvent(new Event(i % 2 === 1 ? 'focus' : 'blur'));
          window.__focused = false;
        }, i * 120);
      }
      true
    `)
    await sleep(1400)
    await back(1200)
    const flapDelta = (await count()) - before
    ok(flapDelta === 1,
      `a flapping burst counts ONCE, not six times (delta = ${flapDelta})`)

    // reset the counter view for the sections below
    await db.from('sessions').update({ focus_loss_count: 0, disqualified: false,
      disqualified_at: null }).eq('key_id', key.id)

    // ---- a real app switch: window blur, tab still "visible" --------------
    console.log('\n── switching to another APP for 3s (window blur, tab still visible) ──')
    ok(await cdp.eval<boolean>(`document.visibilityState === 'visible'`),
      'the tab reports itself VISIBLE — this is the case that used to be missed')

    await away(3200)
    await back(1400)

    ok(await bannerShown(), 'the warning banner appears on return')
    ok(await cdp.eval<boolean>(
      `document.body.innerText.includes('Please keep the quiz open')`),
      'the banner shows the neutral reminder')
    ok(!(await cdp.eval<boolean>(
      `/prize|ineligib|disqualif/i.test(document.body.innerText)`)),
      'the banner says NOTHING about the prize or eligibility')

    const { data: afterSwitch } = await db.from('sessions')
      .select('focus_loss_count, hidden_ms_total').eq('key_id', key.id).single()
    ok(afterSwitch!.focus_loss_count === 1,
      `the switch was counted exactly once (count = ${afterSwitch!.focus_loss_count})`)
    ok(afterSwitch!.hidden_ms_total >= 3000,
      `away-time was recorded (${afterSwitch!.hidden_ms_total}ms)`)

    // ---- the banner should clear itself -----------------------------------
    console.log('\n── banner auto-dismiss ──')
    await sleep(8000)
    ok(!(await bannerShown()), 'the banner disappears on its own after ~8s')

    // ---- a tab switch (visibilitychange) still works ----------------------
    console.log('\n── backgrounding the TAB for 3s ──')
    await cdp.eval(`
      window.__focused = false;
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      true
    `)
    await sleep(3000)
    await cdp.eval(`
      window.__focused = true;
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
      true
    `)
    await sleep(1200)

    ok(await bannerShown(), 'a tab switch also warns')
    const { data: afterTab } = await db.from('sessions')
      .select('focus_loss_count').eq('key_id', key.id).single()
    ok(afterTab!.focus_loss_count === 2,
      `a backgrounded tab is counted too (count = ${afterTab!.focus_loss_count})`)
  } finally {
    cdp.close()
    chrome.kill()
    await db.rpc('purge_test_sessions')
    await db.from('browser_sessions').delete().neq('token_hash', '\\x00')
  }

  console.log(`\n${'─'.repeat(58)}`)
  if (failures.length) {
    console.log(`✖ ${failures.length} FAILED, ${passed} passed`)
    for (const f of failures) console.log(`   - ${f}`)
    process.exit(1)
  }
  console.log(`✔ all ${passed} browser checks passed`)
}

main().catch((e) => die('unexpected failure', e))
