/**
 * Generate participant keys with block-randomized group assignment.
 *
 *   node --env-file=.env.local scripts/generate-keys.ts --dry-run
 *   node --env-file=.env.local scripts/generate-keys.ts --count 300
 *   node --env-file=.env.local scripts/generate-keys.ts --count 10 --test
 *
 * Outputs two git-ignored CSVs:
 *   out/mailmerge.csv    email,codename,key      <- NO group column, so whoever
 *                                                   sends the emails stays blind
 *   out/assignment.csv   key,codename,block,arm  <- for analysis
 *
 * and prints a sha256 of assignment.csv. COMMIT THAT HASH (not the file) as a
 * pre-registration artifact: it proves after the fact that group assignment was
 * not changed once results were known. Cheap, and an economics panel will
 * respect it.
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { randomInt, createHash } from 'node:crypto'

import { makeClient, die } from './lib/client.ts'
import { shuffle } from '../lib/quiz/randomize.ts'

// Crockford-style: no 0/O, no 1/I/L, no U. Participants retype these from an
// email, and those are the characters they get wrong.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'
const KEY_GROUPS = 2
const KEY_GROUP_LEN = 4 // KQ-XXXX-XXXX -> 8 chars -> ~39 bits
const BLOCK_SIZE = 10 // 5 treatment + 5 control per block

const ADJECTIVES = [
  'amber', 'brave', 'calm', 'clever', 'coral', 'crisp', 'dawn', 'eager',
  'early', 'fair', 'fleet', 'gentle', 'glad', 'golden', 'grand', 'green',
  'hardy', 'humble', 'ivory', 'jolly', 'keen', 'kind', 'lively', 'lucid',
  'merry', 'mild', 'noble', 'nimble', 'olive', 'patient', 'plucky', 'proud',
  'quick', 'quiet', 'rapid', 'ready', 'rustic', 'sharp', 'silent', 'silver',
  'skilled', 'smooth', 'solid', 'spry', 'steady', 'stout', 'sunny', 'swift',
  'tidy', 'true', 'upright', 'urban', 'valiant', 'vivid', 'warm', 'watchful',
  'wise', 'witty', 'young', 'zesty',
]

const ANIMALS = [
  'ayungin', 'badger', 'barbet', 'bittern', 'buffalo', 'carabao', 'civet',
  'cobra', 'crane', 'curlew', 'dolphin', 'dugong', 'eagle', 'egret', 'falcon',
  'finch', 'gecko', 'gibbon', 'heron', 'hornbill', 'ibis', 'jacana', 'kingfisher',
  'kite', 'lapwing', 'lemur', 'loris', 'macaque', 'magpie', 'marlin', 'monitor',
  'moth', 'myna', 'oriole', 'osprey', 'otter', 'owl', 'pangolin', 'parrot',
  'pelican', 'pigeon', 'pitta', 'plover', 'python', 'quail', 'robin', 'sandpiper',
  'shrike', 'skink', 'sparrow', 'starling', 'sunbird', 'swallow', 'swift',
  'tarsier', 'teal', 'tern', 'turtle', 'warbler', 'wigeon',
]

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function makeKey(): string {
  const group = () =>
    Array.from({ length: KEY_GROUP_LEN }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')
  return `KQ-${Array.from({ length: KEY_GROUPS }, group).join('-')}`
}

/**
 * Blocked randomization: within each block of 10, exactly 5 treatment and 5
 * control, shuffled. Simple randomization only guarantees 150/150 if ALL 300
 * participants show up; with attrition it drifts. Blocking keeps the groups
 * balanced at every prefix of the realized sample, which matters because
 * redemption will be spread over days.
 */
function assignArms(count: number): { arm: 'control' | 'treatment'; block: number }[] {
  if (count % BLOCK_SIZE !== 0) {
    die(`--count must be a multiple of ${BLOCK_SIZE} for balanced blocks (got ${count})`)
  }
  const out: { arm: 'control' | 'treatment'; block: number }[] = []
  for (let b = 0; b < count / BLOCK_SIZE; b++) {
    const half = BLOCK_SIZE / 2
    const arms = [
      ...Array<'treatment'>(half).fill('treatment'),
      ...Array<'control'>(half).fill('control'),
    ]
    for (const arm of shuffle(arms)) out.push({ arm, block: b })
  }
  // Shuffle block order too, so handout order carries no information.
  return shuffle(out)
}

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

async function main() {
  const count = Number(arg('count') ?? 300)
  const isTest = process.argv.includes('--test')
  const dryRun = process.argv.includes('--dry-run')
  const force = process.argv.includes('--force')

  const assignments = assignArms(count)

  // Unique keys and codenames.
  const keys = new Set<string>()
  while (keys.size < count) keys.add(makeKey())

  const codenames = new Set<string>()
  while (codenames.size < count) {
    codenames.add(
      `${ADJECTIVES[randomInt(ADJECTIVES.length)]}-${ANIMALS[randomInt(ANIMALS.length)]}`,
    )
  }

  const keyList = [...keys]
  const nameList = [...codenames]

  const records = assignments.map((a, i) => ({
    key_code: keyList[i],
    // Pilot keys get an unmistakable prefix so `is_test` can never be set wrong
    // by hand. This flag is the only thing between debugging sessions and the
    // thesis dataset.
    codename: isTest ? `test-${nameList[i]}` : nameList[i],
    arm: a.arm,
    block: a.block,
    is_test: isTest,
  }))

  // ---- balance report ----------------------------------------------------
  const t = records.filter((r) => r.arm === 'treatment').length
  console.log(`\nGenerated ${count} ${isTest ? 'TEST ' : ''}keys`)
  console.log(`  treatment (progress bar): ${t}`)
  console.log(`  control   (no bar)      : ${count - t}`)
  console.log(`  blocks                  : ${count / BLOCK_SIZE} × ${BLOCK_SIZE}`)
  console.log(`\n  sample: ${records[0].key_code}  (${records[0].codename})`)

  if (dryRun) {
    console.log('\n--dry-run: nothing written.')
    return
  }

  // ---- write to the database --------------------------------------------
  const db = makeClient()

  const { count: existing } = await db
    .from('participant_keys')
    .select('id', { count: 'exact', head: true })
    .eq('is_test', isTest)

  if (existing && existing > 0 && !force) {
    die(
      `${existing} ${isTest ? 'test ' : ''}keys already exist. ` +
        'Re-running would break the 150/150 balance.\n' +
        'Use --force only if you are certain.',
    )
  }

  const { error } = await db.from('participant_keys').insert(records)
  if (error) die('failed to insert keys', error)

  // ---- write the two CSVs ------------------------------------------------
  if (!existsSync('out')) mkdirSync('out')

  // NO arm column: whoever runs the mail merge must stay blind to assignment.
  const mailmerge =
    'email,codename,key\n' +
    records.map((r) => `,${csvEscape(r.codename)},${csvEscape(r.key_code)}`).join('\n') +
    '\n'
  writeFileSync('out/mailmerge.csv', mailmerge)

  const assignment =
    'key,codename,block,arm,treatment\n' +
    records
      .map(
        (r) =>
          `${csvEscape(r.key_code)},${csvEscape(r.codename)},${r.block},${r.arm},` +
          `${r.arm === 'treatment' ? 1 : 0}`,
      )
      .join('\n') +
    '\n'
  writeFileSync('out/assignment.csv', assignment)

  const sha = createHash('sha256').update(assignment).digest('hex')

  console.log('\n✔ Wrote out/mailmerge.csv  (email column is blank — fill from your Google Form)')
  console.log('✔ Wrote out/assignment.csv (key -> group, for analysis)')
  console.log(`\n  assignment.csv sha256:\n  ${sha}`)
  console.log('\n  COMMIT THAT HASH (not the file). It is your pre-registration proof')
  console.log('  that group assignment was fixed before any data was collected.')
}

main().catch((e) => die('unexpected failure', e))
