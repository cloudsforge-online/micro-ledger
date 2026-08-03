/**
 * The producer half of the bus contract, checked against the source rather than against a list.
 *
 * The defect this repository held was the one that is hardest to see: **a registry topic this
 * service owns that no emit site produced.** `ledger.reconciliation.completed` was registered with
 * `producer: 'ledger'` before the service existed, `activity/src/classify.ts:335` classified it and
 * `analytics/src/catalogue.ts:312` recorded it, and `reconcile.ts` finished a run, froze withdrawals
 * and told nobody. Both consumers were dead code for the life of the service. Nothing reported it,
 * because a topic that is never sent produces silence, and silence is what a working system also
 * produces.
 *
 * Three families of check, for the three shapes that class takes:
 *
 *   1. **The name**, reconciled with the registry IN BOTH DIRECTIONS. Emitted-but-unregistered is
 *      the `custody.export.completed` shape; registered-but-unemitted is this repository's. Only
 *      checking both catches both.
 *   2. **The envelope**, built with the relay's own `buildEnvelope` and handed to the contract's own
 *      `classifyEnvelope`. This is the only check that finds an unreadable envelope without
 *      composing two services — and composing two services is how the estate found the
 *      integer-version defect, months late.
 *   3. **The delivery**, signed the contract's way and verified with the contract's verifier.
 *
 * No database. Pure text, set arithmetic and a few function calls, so it runs in CI even when the
 * database-backed suite skips. The end-to-end half — a REAL outbox row written by the real
 * reconciliation job, through `buildEnvelope` into the contract's classifier — is in
 * `reconcile.test.ts`, because that is where a real row exists.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  TOPIC_NAMES,
  isRegisteredTopic,
  parseVersion,
  topicSpec,
  topicsProducedBy,
  verifyDelivery,
} from '@cloudsforge/contracts-events'
import { buildEnvelope, signEvent, verifyEventSignature } from './outbox.ts'
import {
  AWAITING_REGISTRATION,
  EMITTED_TOPICS,
  KEYED_BY,
  SERVICE,
  adoptedProposals,
  envelopeDefects,
  malformedProposals,
  undeclaredTopics,
  unemittedOwnedTopics,
} from './topics.ts'

const SRC = dirname(fileURLToPath(import.meta.url))

function sourceFiles(): readonly string[] {
  return readdirSync(SRC)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && file !== 'testsupport.ts')
    .map((file) => join(SRC, file))
}

/**
 * The files a topic literal may legitimately appear in.
 *
 * `topics.ts` is excluded, and that exclusion is the whole check rather than a convenience: it is
 * the file holding `EMITTED_TOPICS` and the quarantine, and it is the thing being checked. Scanning
 * it would let a quarantine entry justify its own existence — a topic could be declared, quarantined
 * and never emitted, and every assertion below would still agree.
 */
function emitSourceFiles(): readonly string[] {
  return sourceFiles().filter((file) => !file.endsWith('/topics.ts'))
}

/**
 * A line that declares a JOB KIND rather than a topic.
 *
 * `jobs.ts` declares `REBUILD_KIND = 'ledger.balances.rebuild'` and
 * `REAP_KIND = 'ledger.idempotency.reap'`. Both are well-formed three-segment `ledger.*.*` strings
 * and neither is a topic: they are keys in the `jobs` table and never reach an outbox row. Without
 * this exclusion the scanner reports two undeclared topics and the guard is red for a reason that
 * has nothing to do with the bus — which is how a guard gets switched off.
 *
 * Excluded by the DECLARATION shape (`<NAME>_KIND = `) rather than by listing the two strings,
 * because a list of exceptions is a list somebody adds a real topic to by mistake. `topics.test.ts`
 * exercises this predicate on fixtures below, so it cannot quietly start excluding everything.
 */
function isJobKindDeclaration(line: string): boolean {
  return /\b[A-Z][A-Z0-9_]*_KIND\s*(?::\s*[A-Za-z<>[\]| ]+)?=/.test(line)
}

/**
 * Every topic literal in this service's namespace that appears anywhere in `src/`.
 *
 * **Not a scan for `topic: '<name>'`.** `ledger.entry.posted` is written by a raw
 * `insert into outbox (topic, …) values (…)` at `entries.ts:427` with no `topic:` property anywhere
 * near it and no emitter function to find, so an emit-site scan returns nothing here and passes
 * vacuously. Matching every well-formed `ledger.*.*` string literal finds it, finds the constant
 * form, and also finds a CONSTANT that no emit site uses — a name a consumer could subscribe to for
 * ever and never hear from.
 *
 * Comment lines are skipped, and that is load-bearing rather than tidy: `reconcile.ts` and
 * `topics.ts` both discuss these topics in prose while explaining the finding, and counting a
 * sentence about a topic as an emission is precisely the failure this estate found when a guard
 * passed because its own prose naming a function counted as a reference.
 */
function topicsInSource(): readonly string[] {
  const found = new Set<string>()
  const literal = new RegExp(`'(${SERVICE}\\.[a-z0-9_]+\\.[a-z0-9_]+)'`, 'g')
  for (const file of emitSourceFiles()) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trimStart()
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue
      if (/\b(?:action|scope|resource|permission)\s*:/.test(line)) continue
      if (isJobKindDeclaration(line)) continue
      for (const match of line.matchAll(literal)) if (match[1]) found.add(match[1])
    }
  }
  return [...found].sort()
}

/* ------------------------------------------------------------------ the names */

test('the job-kind exclusion excludes job kinds and nothing else', () => {
  // The predicate is exercised before it is trusted. An exclusion that matched everything would
  // empty the scanner and make every assertion below pass over nothing — the "check that cannot
  // fail" this estate keeps rediscovering.
  assert.equal(isJobKindDeclaration("export const REAP_KIND = 'ledger.idempotency.reap'"), true)
  assert.equal(isJobKindDeclaration("export const REBUILD_KIND = 'ledger.balances.rebuild'"), true)
  assert.equal(isJobKindDeclaration("export const ENTRY_POSTED = 'ledger.entry.posted'"), false)
  assert.equal(
    isJobKindDeclaration("export const RECONCILIATION_COMPLETED = 'ledger.reconciliation.completed'"),
    false,
  )
  // And a topic that merely mentions a job kind on the same line is still counted.
  assert.equal(isJobKindDeclaration("emit({ topic: 'ledger.entry.posted', key: REAP_KIND })"), false)
})

test('the source emits exactly the topics this service declares', () => {
  // Both halves of the drift: a literal in `src/` that EMITTED_TOPICS does not list, and an entry
  // in EMITTED_TOPICS that no literal backs. The second half is what stops the list being repaired
  // by editing the list.
  assert.deepEqual(
    topicsInSource(),
    [...EMITTED_TOPICS].sort(),
    'src/ and EMITTED_TOPICS disagree about what this service puts on the bus',
  )
})

test('the literal scanner finds the RAW-INSERT topic, not just the constant', () => {
  // The scanner is exercised on the real source before it is trusted. `ledger.entry.posted` is the
  // case that breaks an emit-site scan, so finding it is what proves this scanner is the right one.
  assert.ok(topicsInSource().length >= 2, 'the scanner found nothing — it is broken, not the source')
  assert.ok(topicsInSource().includes('ledger.entry.posted'))
  assert.ok(topicsInSource().includes('ledger.reconciliation.completed'))
  // And the raw insert really is still a raw insert — if it ever becomes an ordinary emit, this
  // assertion is the place to notice, rather than discovering the scanner was over-built.
  const entries = readFileSync(join(SRC, 'entries.ts'), 'utf8')
  assert.match(entries, /insert into outbox \(topic, key, producer/)
})

test('every topic this service emits is one the estate has a name for', () => {
  assert.deepEqual(
    undeclaredTopics(topicsInSource()),
    [],
    'emitted, but in neither the registry nor AWAITING_REGISTRATION — decide which, then say so',
  )
})

test('THE DEFECT: every registry topic this service owns is actually emitted', () => {
  // **The direction this repository was wrong in, for the life of the service.**
  // `ledger.reconciliation.completed` was registered, classified by activity and recorded by
  // analytics, and no emit site produced it. Nothing broke and nothing logged.
  assert.deepEqual(
    unemittedOwnedTopics(topicsInSource()),
    [],
    'the registry says ledger produces these and no emit site does — every consumer of each is dead code',
  )
  // And the registry is being read rather than the check passing vacuously.
  assert.ok(topicsProducedBy(SERVICE).includes('ledger.reconciliation.completed'))
  assert.ok(topicsProducedBy(SERVICE).includes('ledger.entry.posted'))
  assert.equal(topicsProducedBy(SERVICE).length, 2)
  assert.ok(TOPIC_NAMES.length >= 40)
})

test('the ordering key is the registry’s, character for character', () => {
  // `key` is the ordering partition: events sharing a `(topic, key)` are delivered in the order they
  // were written and no other pair has any ordering relationship at all. A producer that picks its
  // own key silently reorders every consumer's view of the topic, and nothing anywhere reports it.
  for (const topic of EMITTED_TOPICS) {
    const keyedBy = KEYED_BY[topic]
    assert.ok(keyedBy, `${topic} has no declared ordering key`)
    assert.equal(topicSpec(topic).keyedBy, keyedBy, `${topic} disagrees with the registry`)
  }
  // Named explicitly, because this is the one a reconciliation emit could plausibly have got wrong:
  // the asset is the obvious choice and it is not the registry's.
  assert.equal(topicSpec('ledger.reconciliation.completed').keyedBy, 'chain:network')
})

test('a pending proposal disappears once contracts adopts it', () => {
  // Without this the quarantine becomes a permanent allow-list: the topic gets registered, the entry
  // stays, and the next reader believes the topic is still unregistered. The quarantine is EMPTY
  // today, which is the correct end state — both topics were registered before either was emitted.
  assert.deepEqual(
    adoptedProposals(),
    [],
    'the registry now names these — delete them from AWAITING_REGISTRATION',
  )
  for (const topic of EMITTED_TOPICS) {
    assert.equal(isRegisteredTopic(topic), true)
    assert.equal(Object.hasOwn(AWAITING_REGISTRATION, topic), false)
  }
})

test('every pending proposal carries a spec that could be pasted into the registry', () => {
  assert.deepEqual(
    malformedProposals(),
    [],
    'a proposal needs a well-formed ledger topic, a real ordering key, and a reason worth reading',
  )
})

/* ------------------------------------------------------------------ the envelope */

/**
 * A stored outbox row exactly as the RECONCILIATION emit writes one.
 *
 * **`actor` and `correlation_id` are null, and that is what makes this fixture the right one.** The
 * reconciliation job is woken by a schedule: there is no principal and no inbound request, so both
 * columns are null on every row it writes. `ledger.entry.posted` always carries a request's actor
 * and correlation id and would therefore pass any envelope check by accident — a fixture built from
 * it would have proved nothing about the event this commit adds.
 */
const ROW = {
  id: '018f0000-0000-7000-8000-0000000000a1',
  topic: 'ledger.reconciliation.completed',
  key: 'platform:testnet',
  occurred_at: new Date('2026-08-03T10:00:00.000Z'),
  producer: SERVICE,
  version: 1,
  actor: null,
  correlation_id: null,
  payload: { assetCode: 'EMBER', drift: '0', status: 'clean' },
}

/**
 * **THE TRAP, STATED FIRST: prove the reader can fail before trusting that it passed.**
 *
 * A test in this estate stayed green with the logic deliberately broken because the payload lacked
 * the field being read and an absent field is null to every reader — null being the expected answer.
 * The same vacuity is available here: `envelopeDefects` returning `[]` proves nothing unless
 * something is known to make it return a non-empty list.
 *
 * So YESTERDAY'S ENVELOPE is built by hand first — the exact object the relay used to construct,
 * with the integer version and the nulls passed straight through — and every one of its three
 * defects is named. If this test ever goes green, the classifier has stopped classifying and every
 * assertion below it is worthless.
 */
test('the pre-migration envelope is refused, and all three reasons are named', () => {
  const yesterday = {
    id: ROW.id,
    topic: ROW.topic,
    key: ROW.key,
    occurredAt: ROW.occurred_at.toISOString(),
    producer: ROW.producer,
    version: ROW.version as unknown as string,
    actor: ROW.actor,
    correlationId: ROW.correlation_id,
    payload: ROW.payload,
  }
  const defects = envelopeDefects(yesterday)
  assert.ok(defects.some((e) => e.startsWith('version:')), `version must be named: ${defects.join('; ')}`)
  assert.ok(defects.some((e) => e.startsWith('actor:')), `actor must be named: ${defects.join('; ')}`)
  assert.ok(
    defects.some((e) => e.startsWith('correlationId:')),
    `correlationId must be named: ${defects.join('; ')}`,
  )
})

test('THE RULE: the envelope this relay builds is one the contract accepts', () => {
  // The check whose absence lets a service relay nothing but refusals. `classifyEnvelope` is the
  // contract's own function and is literally what activity's ingest and notify run on a delivered
  // body — not a restatement of it here.
  for (const topic of topicsInSource()) {
    const built = buildEnvelope({ ...ROW, topic })
    assert.ok(built.ok, `${topic}: the relay would refuse its own envelope`)
    assert.deepEqual(
      envelopeDefects(JSON.parse(JSON.stringify(built.value))),
      [],
      `an event on ${topic} would be refused by every consumer in the estate`,
    )
  }
})

test('the version on the wire is "major.minor", never the stored integer', () => {
  const built = buildEnvelope(ROW)
  assert.ok(built.ok)
  assert.equal(typeof built.value.version, 'string')
  assert.equal(built.value.version, '1.0')
  assert.equal(parseVersion(built.value.version).ok, true)
  assert.equal(parseVersion(String(ROW.version)).ok, false, 'the stored integer is NOT a wire version')
})

test('a row with no actor and no correlation id still makes a readable envelope', () => {
  const built = buildEnvelope(ROW)
  assert.ok(built.ok)
  // `system` is the contract's own value for "no principal did this", which is exactly what a null
  // actor column means for a job woken by a schedule. Inventing a user would put a machine's
  // decision in somebody's name.
  assert.equal(built.value.actor, 'system')
  assert.equal(built.value.correlationId, ROW.id)
})

test('the relay refuses a row it cannot make an envelope from', () => {
  // Refused rather than sent: an envelope the contract rejects is one every subscriber rejects, so
  // relaying it burns a retry budget delivering something nobody can accept.
  assert.equal(buildEnvelope({ ...ROW, key: '' }).ok, false, 'an empty key leaves ordering undefined')
  assert.equal(
    buildEnvelope({ ...ROW, topic: 'ledger.nothing.happened' }).ok,
    false,
    'an unregistered topic is a defect here: both of this service’s topics are registered',
  )
  assert.equal(
    buildEnvelope({ ...ROW, producer: 'wallet' }).ok,
    false,
    'the topic namespace is the ownership boundary',
  )
})

/* ------------------------------------------------------------------ the delivery */

const SECRET = 'K2sN4vQ8xR1wB6tY9zL3mF7hC5jD0pA4'

test('the delivery this relay signs is one a contract-following consumer verifies', () => {
  const built = buildEnvelope(ROW)
  assert.ok(built.ok)
  const body = JSON.stringify(built.value)

  assert.equal(SIGNATURE_HEADER, 'cf-signature')
  assert.equal(EVENT_ID_HEADER, 'cf-event-id')
  assert.equal(verifyDelivery(body, signEvent(body, SECRET), [SECRET]).ok, true)
  assert.equal(verifyEventSignature(body, SECRET, signEvent(body, SECRET)), true)

  // The pre-contract scheme is not what this service produces, and its shape is genuinely different
  // rather than a second name for the same thing.
  assert.ok(!signEvent(body, SECRET).startsWith('sha256='))
  assert.match(signEvent(body, SECRET), /^t=\d+,v1=[0-9a-f]{64}$/)

  // Tampering, a wrong secret and an absent header are all refused.
  assert.equal(verifyEventSignature(`${body} `, SECRET, signEvent(body, SECRET)), false)
  assert.equal(
    verifyEventSignature(body, 'a-different-secret-that-is-long-enough', signEvent(body, SECRET)),
    false,
  )
  assert.equal(verifyEventSignature(body, SECRET, ''), false)
})

/* ------------------------------------------------------------------ reachability */

/**
 * A guard that proves a topic name is correct proves nothing about whether the emit is reached.
 *
 * `identity/src/sessions.ts:390` exports `emitSessionRevoked` and NOTHING CALLS IT — so
 * `identity.session.revoked` is produced by dead code while identity's own guard passes, because it
 * scans literals rather than reachability. This is the cheapest check that catches that exact shape,
 * and it is the same shape as this repository's own defect one level down: a name that is correct
 * everywhere and reached from nowhere.
 */
function unreachedEmitters(files: readonly { name: string; text: string }[]): readonly string[] {
  const declared: { symbol: string; where: string }[] = []
  for (const file of files) {
    file.text.split('\n').forEach((line, index) => {
      const match = /^export (?:async )?function (emit[A-Za-z0-9_]*)/.exec(line)
      if (match?.[1]) declared.push({ symbol: match[1], where: `${file.name}:${index + 1}` })
    })
  }
  return declared
    .filter(({ symbol }) => {
      const reference = new RegExp(`\\b${symbol}\\b`)
      for (const file of files) {
        for (const line of file.text.split('\n')) {
          const trimmed = line.trimStart()
          if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue
          if (/^export (?:async )?function /.test(trimmed)) continue
          if (reference.test(line)) return false
        }
      }
      return true
    })
    .map(({ symbol, where }) => `${symbol} (${where})`)
    .sort()
}

test('the unreachable-emitter detector can actually fail', () => {
  const dead = [{ name: 'sessions.ts', text: 'export function emitSessionRevoked(): void {}\n' }]
  assert.deepEqual(unreachedEmitters(dead), ['emitSessionRevoked (sessions.ts:1)'])

  const alive = [
    { name: 'sessions.ts', text: 'export function emitSessionRevoked(): void {}\n' },
    { name: 'server.ts', text: 'emitSessionRevoked()\n' },
  ]
  assert.deepEqual(unreachedEmitters(alive), [])
})

test('every exported emitter is reached from somewhere', () => {
  assert.deepEqual(
    unreachedEmitters(sourceFiles().map((name) => ({ name, text: readFileSync(name, 'utf8') }))),
    [],
    'exported, emits an event, and no code path reaches it — the topic is produced by dead code',
  )
})

/**
 * A topic CONSTANT that is declared and never used to emit anything.
 *
 * The gap between the two checks above, and it is a real one. The literal scanner reads names out of
 * `src/`, so `export const RECONCILIATION_COMPLETED = 'ledger.reconciliation.completed'` satisfies it
 * whether or not any emit site references the constant — delete the `emit(...)` call and the name
 * check stays green, because the DECLARATION is still a literal in `src/`. And `unreachedEmitters`
 * cannot see it either, because it looks for exported `emit*` FUNCTIONS and this estate emits inline.
 *
 * Proved by breaking it: removing the reconciliation emit left the name reconciliation green and only
 * the database-backed tests red. A guard that needs a database to fail is a guard that is skipped
 * exactly when someone is in a hurry.
 *
 * So: every constant whose value is one of this service's topics must be REFERENCED somewhere else in
 * `src/`, outside its own declaration, outside a comment, and outside `topics.ts` — because
 * `topics.ts` is the list being checked and a reference from there would let the list justify itself.
 */
function unusedTopicConstants(files: readonly { name: string; text: string }[]): readonly string[] {
  const topicLiteral = new RegExp(`^export const ([A-Z][A-Z0-9_]*) = '${SERVICE}\\.[a-z0-9_]+\\.[a-z0-9_]+'`)
  const declared: { symbol: string; where: string }[] = []
  for (const file of files) {
    file.text.split('\n').forEach((line, index) => {
      const match = topicLiteral.exec(line)
      if (match?.[1]) declared.push({ symbol: match[1], where: `${file.name}:${index + 1}` })
    })
  }
  return declared
    .filter(({ symbol }) => {
      const reference = new RegExp(`\\b${symbol}\\b`)
      for (const file of files) {
        for (const line of file.text.split('\n')) {
          const trimmed = line.trimStart()
          if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue
          if (topicLiteral.test(line)) continue
          if (reference.test(line)) return false
        }
      }
      return true
    })
    .map(({ symbol, where }) => `${symbol} (${where})`)
    .sort()
}

test('the unused-topic-constant detector can actually fail', () => {
  // The fixture is the exact regression that motivated this check: a constant declared, named in the
  // registry, and never referenced by an emit.
  const dead = [{ name: 'a.ts', text: `export const T = '${SERVICE}.thing.happened'\n` }]
  assert.deepEqual(unusedTopicConstants(dead), ['T (a.ts:1)'])

  // A reference from a COMMENT does not count — that is how a guard passes because its own prose
  // names the thing it is checking.
  const prose = [
    { name: 'a.ts', text: `export const T = '${SERVICE}.thing.happened'\n` },
    { name: 'b.ts', text: '// T is emitted somewhere, honest\n' },
  ]
  assert.deepEqual(unusedTopicConstants(prose), ['T (a.ts:1)'])

  const alive = [
    { name: 'a.ts', text: `export const T = '${SERVICE}.thing.happened'\n` },
    { name: 'b.ts', text: 'emit({ topic: T, key: row.id, payload: {} })\n' },
  ]
  assert.deepEqual(unusedTopicConstants(alive), [])
})

test('every topic constant is referenced by something that emits', () => {
  assert.deepEqual(
    unusedTopicConstants(emitSourceFiles().map((name) => ({ name, text: readFileSync(name, 'utf8') }))),
    [],
    'declared, registered, and no emit site references it — the topic is a name and nothing more',
  )
})
