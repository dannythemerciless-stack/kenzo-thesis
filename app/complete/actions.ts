'use server'

import { redirect } from 'next/navigation'
import { z } from 'zod'

import { rpc } from '@/lib/supabase/admin'
import { getTokenHash } from '@/lib/dal/session'

export type SurveyState = { error?: string }

const likert = z.coerce.number().int().min(1).max(5)

const Schema = z.object({
  exhaustion: likert,
  difficulty: likert,
  focus: likert,
  stress: likert,
  overall: likert,
})

export async function submitSurvey(
  _prev: SurveyState,
  formData: FormData,
): Promise<SurveyState> {
  const tokenHash = await getTokenHash()
  if (!tokenHash) redirect('/?e=session')

  const parsed = Schema.safeParse({
    exhaustion: formData.get('exhaustion'),
    difficulty: formData.get('difficulty'),
    focus: formData.get('focus'),
    stress: formData.get('stress'),
    overall: formData.get('overall'),
  })

  if (!parsed.success) {
    return { error: 'Please answer all five rating questions.' }
  }

  const v = parsed.data

  await rpc('submit_survey', {
    p_token_hash: tokenHash,
    p_likert: [v.exhaustion, v.difficulty, v.focus, v.stress, v.overall],
    p_considers: [
      formData.get('consider_forfeit') === 'on',
      formData.get('consider_slow') === 'on',
      formData.get('consider_rush') === 'on',
      formData.get('consider_random') === 'on',
      formData.get('consider_none') === 'on',
    ],
    // Contamination check. Lets the analysis exclude participants who had the
    // quiz described to them beforehand — 300 undergrads at one university
    // will compare notes, and "did yours have a progress bar?" is the first
    // thing they will ask.
    p_heard: formData.get('heard_beforehand') === 'on',
  })

  redirect('/debrief')
}
