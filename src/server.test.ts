/**
 * The HTTP surface.
 *
 * The auth tests carry the most weight here. AD-06 makes the ledger a service no product may write
 * to except through a typed, scoped posting API, and that boundary is only real if a user token is
 * refused, a missing scope is refused, and an identity outage produces a 503 rather than a 401
 * that would sign every service in the estate out at once.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type postgres from 'postgres'
import { TokenError, VerifierUnavailableError, type Principal } from '@cloudsforge/auth'
import { Lifecycle } from '@cloudsforge/lifecycle'
import { Logger, Metrics, registerHttpMetrics, registerJobMetrics } from '@cloudsforge/telemetry'
import { createServer, registerServiceMetrics, type PrincipalVerifier } from './server.ts'
import { ALICE, enabled, freshKey, migrateTestDb, openDb, resetLedger, skip } from './testsupport.ts'
import type { Db } from './outbox.ts'

/**
 * A verifier keyed on the token text, so a test names the authority it wants.
 *
 * An interface rather than a real `Verifier`, so these tests need no JWKS endpoint and no signing
 * key — the mapping from auth fault to status is what is under test, not jose.
 */
const verifier: PrincipalVerifier = {
  async principal(token: string): Promise<Principal> {
    switch (token) {
      case 'svc-all':
        return { kind: 'service', service: 'wallet', scopes: ['ledger:*'] }
      case 'svc-read':
        return { kind: 'service', service: 'reporting', scopes: ['ledger:read'] }
      case 'svc-post':
        return { kind: 'service', service: 'wallet', scopes: ['ledger:post'] }
      case 'svc-none':
        return { kind: 'service', service: 'nosy', scopes: ['other:read'] }
      case 'user':
        return { kind: 'user', userId: '11111111-1111-4111-8111-111111111111', handle: 'alice', roles: ['admin'] }
      case 'down':
        throw new VerifierUnavailableError('jwks unreachable')
      default:
        throw new TokenError('bad signature', 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED')
    }
  },
}

let sql: postgres.Sql
let server: Server
let baseUrl: string

before(async () => {
  if (!enabled) return
  sql = openDb(8)
  await migrateTestDb(sql)

  const lifecycle = new Lifecycle({ drainDelayMs: 0, drainTimeoutMs: 1_000 })
  const metrics = registerServiceMetrics(registerJobMetrics(registerHttpMetrics(new Metrics())))
  server = createServer({
    lifecycle,
    // Silenced: these tests deliberately provoke fatal-level lines, and a test run is not the
    // place to prove the logger writes to stdout.
    logger: new Logger({ service: 'ledger-test', level: 'error', sink: () => {} }),
    metrics,
    verifier,
    sql: sql as unknown as Db,
    producer: 'ledger',
  })
  await new Promise<void>((resolve) => server.listen(0, () => resolve()))
  lifecycle.markReady()
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  if (!enabled) return
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await sql.end({ timeout: 5 })
})

beforeEach(async () => {
  if (!enabled) return
  await resetLedger(sql)
})

interface Response {
  readonly status: number
  readonly body: Record<string, never>
  readonly text: string
}

async function call(
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<Response> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  })
  const text = await response.text()
  let body: Record<string, never> = {} as Record<string, never>
  try {
    body = JSON.parse(text) as Record<string, never>
  } catch {
    /* /metrics is Prometheus text, not JSON */
  }
  return { status: response.status, body, text }
}

/** A balanced deposit body, as a caller would send it: amounts as strings. */
const depositBody = (amount: string, idempotencyKey = freshKey()) => ({
  kind: 'deposit_credited',
  originatingService: 'wallet',
  actor: 'system',
  correlationId: 'c-http',
  idempotencyKey,
  postings: [
    {
      account: { subject: 'custody', assetCode: 'SHARD', purpose: 'treasury', type: 'asset' },
      direction: 'debit',
      amount,
      assetCode: 'SHARD',
      sequence: 0,
    },
    {
      account: { subject: ALICE, assetCode: 'SHARD', purpose: 'available', type: 'liability' },
      direction: 'credit',
      amount,
      assetCode: 'SHARD',
      sequence: 1,
    },
  ],
})

/* ================================================================== health */

test('livez is static and readyz reports real state', { skip }, async () => {
  const livez = await call('GET', '/livez')
  assert.equal(livez.status, 200)

  const readyz = await call('GET', '/readyz')
  assert.equal(readyz.status, 200)
})

test('metrics renders Prometheus text and declares the ledger gauges', { skip }, async () => {
  const response = await call('GET', '/metrics')
  assert.equal(response.status, 200)
  assert.match(response.text, /# TYPE ledger_trial_balance_delta gauge/)
  assert.match(response.text, /# TYPE ledger_postings_total counter/)
  assert.match(response.text, /# TYPE ledger_entries_total counter/)
  assert.match(response.text, /# TYPE ledger_reconciliation_drift gauge/)
  // The standard RED and job sets, from the runtime package.
  assert.match(response.text, /# TYPE http_requests_total counter/)
  assert.match(response.text, /# TYPE jobs_claimed_total counter/)
})

/* ================================================================== auth */

test('an unauthenticated request is 401, and says nothing about why', { skip }, async () => {
  const response = await call('POST', '/entries', { body: depositBody('100') })
  assert.equal(response.status, 401)
  // "signature verification failed" versus "expired" tells an attacker which half to fix.
  assert.equal(response.body['error']!['code'], 'unauthenticated')
  assert.doesNotMatch(response.text, /signature|expired/i)
})

test('a bad token is 401 but an unreachable JWKS is 503', { skip }, async () => {
  assert.equal((await call('GET', '/trial-balance', { token: 'garbage' })).status, 401)
  // The single most important line in the auth mapping: answering 401 here would sign every
  // service in the estate out because identity is having a bad minute.
  const outage = await call('GET', '/trial-balance', { token: 'down' })
  assert.equal(outage.status, 503)
  assert.equal(outage.body['error']!['code'], 'verifier_unavailable')
})

test('a USER token is refused even for reads, and even for an admin', { skip }, async () => {
  // The ledger has no user-facing surface by design. `wallet` is what a user talks to.
  assert.equal((await call('GET', '/trial-balance', { token: 'user' })).status, 403)
  assert.equal((await call('POST', '/entries', { token: 'user', body: depositBody('100') })).status, 403)
})

test('scopes are enforced per route', { skip }, async () => {
  // A read-only reporting token may not post.
  const posted = await call('POST', '/entries', { token: 'svc-read', body: depositBody('100') })
  assert.equal(posted.status, 403)
  assert.match(posted.body['error']!['message'], /ledger:post/)

  // A posting token may not reserve: three authorities, not one.
  const reserved = await call('POST', '/reservations', {
    token: 'svc-post',
    body: { subject: ALICE, assetCode: 'SHARD', amount: '10', originatingService: 'market', actor: 'service:market', idempotencyKey: freshKey() },
  })
  assert.equal(reserved.status, 403)
  assert.match(reserved.body['error']!['message'], /ledger:reserve/)

  // A token with no ledger scope at all reads nothing.
  assert.equal((await call('GET', '/entries', { token: 'svc-none' })).status, 403)
})

test('a wildcard scope grants the family', { skip }, async () => {
  assert.equal((await call('GET', '/trial-balance', { token: 'svc-all' })).status, 200)
})

/* ================================================================== posting */

test('a balanced entry is 201 and a replay is 200', { skip }, async () => {
  const body = depositBody('1000')

  const first = await call('POST', '/entries', { token: 'svc-all', body })
  assert.equal(first.status, 201)
  assert.equal(first.body['replayed'], false)

  // 200 rather than 201 on a replay, so the caller can tell whether its retry did the work or
  // merely found it done, without comparing bodies.
  const second = await call('POST', '/entries', { token: 'svc-all', body })
  assert.equal(second.status, 200)
  assert.equal(second.body['replayed'], true)
  assert.equal(second.body['entry']!['id'], first.body['entry']!['id'])
})

test('the same key with a different body is 409', { skip }, async () => {
  const key = freshKey()
  await call('POST', '/entries', { token: 'svc-all', body: depositBody('1000', key) })
  const conflict = await call('POST', '/entries', { token: 'svc-all', body: depositBody('9999', key) })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body['error']!['code'], 'idempotency_key_reuse')
})

test('an unbalanced entry is 400 and names the asset and the difference', { skip }, async () => {
  const body = depositBody('1000')
  ;(body.postings[1] as { amount: string }).amount = '999'

  const response = await call('POST', '/entries', { token: 'svc-all', body })
  assert.equal(response.status, 400)
  assert.equal(response.body['error']!['code'], 'invalid_entry')
  assert.match(JSON.stringify(response.body['error']!['problems']), /SHARD is out by 1/)
})

test('overspending is 409, not 400 — the request was well formed', { skip }, async () => {
  await call('POST', '/entries', { token: 'svc-all', body: depositBody('100') })
  const response = await call('POST', '/entries', {
    token: 'svc-all',
    body: {
      kind: 'withdrawal_requested',
      originatingService: 'wallet',
      actor: 'system',
      idempotencyKey: freshKey(),
      postings: [
        { account: { subject: ALICE, assetCode: 'SHARD', purpose: 'available', type: 'liability' }, direction: 'debit', amount: '500', assetCode: 'SHARD', sequence: 0 },
        { account: { subject: 'custody', assetCode: 'SHARD', purpose: 'treasury', type: 'asset' }, direction: 'credit', amount: '500', assetCode: 'SHARD', sequence: 1 },
      ],
    },
  })
  assert.equal(response.status, 409)
  assert.equal(response.body['error']!['code'], 'insufficient_funds')
})

/* ================================================================== reading */

test('trial-balance answers zero, and every amount is a string', { skip }, async () => {
  await call('POST', '/entries', { token: 'svc-all', body: depositBody('1000') })

  const response = await call('GET', '/trial-balance', { token: 'svc-read' })
  assert.equal(response.status, 200)
  assert.equal(response.body['balanced'], true)
  assert.equal(response.body['totalAbsoluteDelta'], '0')
  // A JSON number here would lose the low bits of an 18-decimal amount.
  assert.equal(typeof response.body['assets']![0]!['debits'], 'string')
})

test('entries are paginated, and the page size is capped', { skip }, async () => {
  for (let i = 0; i < 5; i++) {
    await call('POST', '/entries', { token: 'svc-all', body: depositBody(String(i + 1)) })
  }

  const page = await call('GET', '/entries?limit=2', { token: 'svc-read' })
  assert.equal(page.status, 200)
  assert.equal((page.body['entries'] as unknown as unknown[]).length, 2)
  assert.ok(page.body['nextCursor'], 'a further page must be offered')

  // The existing wallet returns the entire unpaginated ledger on every call. A caller cannot
  // ask this one to do that.
  const capped = await call('GET', '/entries?limit=100000', { token: 'svc-read' })
  assert.ok((capped.body['entries'] as unknown as unknown[]).length <= 200)
})

test('balances are read by subject, and a malformed subject is 400 not 500', { skip }, async () => {
  await call('POST', '/entries', { token: 'svc-all', body: depositBody('1000') })

  const response = await call('GET', `/accounts/${encodeURIComponent(ALICE)}/balances`, { token: 'svc-read' })
  assert.equal(response.status, 200)
  const available = (response.body['balances'] as unknown as { purpose: string; amount: string }[]).find(
    (b) => b.purpose === 'available',
  )
  assert.equal(available!.amount, '1000')

  const bad = await call('GET', '/accounts/not-a-subject/balances', { token: 'svc-read' })
  assert.equal(bad.status, 400)
})

test('an unknown route is 404 and carries a request id', { skip }, async () => {
  const response = await call('GET', '/nope')
  assert.equal(response.status, 404)
  assert.ok(response.body['error']!['requestId'], 'every error carries the id the user will quote')
})

test('a reservation round-trips through HTTP', { skip }, async () => {
  await call('POST', '/entries', { token: 'svc-all', body: depositBody('1000') })

  const reserved = await call('POST', '/reservations', {
    token: 'svc-all',
    body: { subject: ALICE, assetCode: 'SHARD', amount: '400', originatingService: 'market', actor: 'service:market', idempotencyKey: freshKey() },
  })
  assert.equal(reserved.status, 201)
  const reservationId = reserved.body['reservationId'] as unknown as string
  assert.ok(reservationId)

  const balances = await call('GET', `/accounts/${encodeURIComponent(ALICE)}/balances`, { token: 'svc-read' })
  const byPurpose = Object.fromEntries(
    (balances.body['balances'] as unknown as { purpose: string; amount: string }[]).map((b) => [b.purpose, b.amount]),
  )
  assert.equal(byPurpose['available'], '600')
  assert.equal(byPurpose['reserved'], '400')

  const released = await call('POST', `/reservations/${reservationId}/release`, {
    token: 'svc-all',
    body: { originatingService: 'market', actor: 'service:market', idempotencyKey: freshKey() },
  })
  assert.equal(released.status, 201)

  // A second, different release request is 409.
  const again = await call('POST', `/reservations/${reservationId}/release`, {
    token: 'svc-all',
    body: { originatingService: 'market', actor: 'service:market', idempotencyKey: freshKey() },
  })
  assert.equal(again.status, 409)
  assert.equal(again.body['error']!['code'], 'already_released')
})

test('a reversal round-trips through HTTP', { skip }, async () => {
  const posted = await call('POST', '/entries', { token: 'svc-all', body: depositBody('700') })
  const entryId = posted.body['entry']!['id'] as unknown as string

  const reversed = await call('POST', `/entries/${entryId}/reverse`, {
    token: 'svc-all',
    body: { originatingService: 'ops', actor: 'operator:1', idempotencyKey: freshKey() },
  })
  assert.equal(reversed.status, 201)
  assert.equal(reversed.body['entry']!['reversesEntryId'], entryId)

  const trial = await call('GET', '/trial-balance', { token: 'svc-read' })
  assert.equal(trial.body['balanced'], true)
  assert.equal(trial.body['entryCount'], 2, 'the mistake AND the fix are both in the journal')
})

test('reversing something that does not exist is 404', { skip }, async () => {
  const response = await call('POST', '/entries/019a0000-0000-7000-8000-0000000000ff/reverse', {
    token: 'svc-all',
    body: { originatingService: 'ops', actor: 'operator:1', idempotencyKey: freshKey() },
  })
  assert.equal(response.status, 404)
})

test('the metric label uses the route PATTERN, so a path parameter cannot mint time series', { skip }, async () => {
  for (let i = 0; i < 3; i++) {
    await call('POST', `/entries/019a0000-0000-7000-8000-00000000000${i}/reverse`, {
      token: 'svc-all',
      body: { originatingService: 'ops', actor: 'operator:1', idempotencyKey: freshKey() },
    })
  }
  const metrics = await call('GET', '/metrics')
  // One series for the pattern, not three for the ids. Unbounded cardinality here would let any
  // caller take the scrape target down.
  assert.match(metrics.text, /route="\/entries\/:id\/reverse"/)
  assert.doesNotMatch(metrics.text, /route="\/entries\/019a0000/)
})
