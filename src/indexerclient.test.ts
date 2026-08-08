/**
 * The indexer client's own guarantees.
 *
 * `chainbacking.test.ts` proves them where they matter — through the scheduled job, into
 * `reconciliation_runs`, against a real indexer. This file proves the two that a database test
 * cannot reach cleanly, and it needs no database at all:
 *
 *   1. **the parse**, exhaustively, including every shape some parser in this language accepts;
 *   2. **the status rule**, which needs a peer that answers a 2xx that is not 200 — a thing the
 *      real custody route will never do, which is precisely why it must be tested against
 *      something that will. The far end of `INDEXER_URL` in production is a service mesh, a
 *      sidecar and a proxy before it is the indexer, and any of those can invent a 2xx.
 *
 * It also holds the agreement `jobs.ts` depends on and cannot state locally: an asset has an
 * indexer slug if and only if `reconcile.ts` will demand a reading for it. Those are two derived
 * facts about one list, and if they ever disagree the failure is silent in the worst direction —
 * an asset the handler skips and the reconciler demands is an asset frozen for ever with no call
 * ever having been attempted.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ON_CHAIN_ASSETS } from '@cloudsforge/contracts-chain'
import type { LedgerAssetCode } from '@cloudsforge/contracts-money'
import {
  INDEXER_SCOPES,
  breakdownFrom,
  httpIndexerClient,
  indexerChainFor,
  totalFrom,
} from './indexerclient.ts'
import { isOnChainAsset } from './reconcile.ts'

/* ------------------------------------------------------------------ the parse */

test('THE ONE RULE: only a non-negative decimal STRING becomes a number', () => {
  assert.equal(totalFrom({ total: '0' }), 0n)
  assert.equal(totalFrom({ total: '7000000000000000000' }), 7_000_000_000_000_000_000n)
  // Beyond Number.MAX_SAFE_INTEGER, digit for digit. The whole point of a string is the digits a
  // float would drop, and the low digits of an 18-decimal balance are where a drift lives.
  assert.equal(
    totalFrom({ total: '7000000000000000001' }),
    7_000_000_000_000_000_001n,
  )
})

test('every shape that would NEARLY parse is refused, and none of them becomes 0n', () => {
  const refused: readonly unknown[] = [
    // `JSON.parse` has already rounded this. `BigInt` would then accept the rounded value and
    // bless it, which is a wrong number wearing the type of a right one.
    { total: 7000000000000000000 },
    { total: 0 },
    // `BigInt('')` is `0n`. This is how an empty answer becomes a confident claim of an empty chain.
    { total: '' },
    { total: null },
    { total: undefined },
    { total: true },
    { total: '0x1a' },
    { total: '-1' },
    { total: '7e18' },
    { total: '007' },
    { total: ' 7 ' },
    { total: '7.0' },
    { total: ['7'] },
    { total: { value: '7' } },
    { addresses: 2 },
    {},
    [],
    null,
    'not an object',
    7,
    undefined,
  ]
  for (const body of refused) {
    const result = totalFrom(body)
    assert.equal(result, undefined, `${JSON.stringify(body) ?? String(body)} became a total`)
    // Stated separately from the line above, because `undefined` and `0n` are the two answers this
    // whole release exists to keep apart and an `assert.equal(x, undefined)` alone does not say so.
    assert.notEqual(result, 0n)
  }
})

/* ------------------------------------------------------------------ the breakdown, which is prose */

test('the breakdown is rendered to prose, and every figure in it stays a string', () => {
  assert.equal(
    breakdownFrom({
      total: '50000000',
      byLabelPrefix: [
        { prefix: 'deposit:', addresses: 12, total: '41000000' },
        { prefix: 'treasury:', addresses: 1, total: '9000000' },
      ],
    }),
    'deposit: 41000000 over 12 addresses, treasury: 9000000 over 1 address',
  )
  // A bucket that matched nothing is printed, because an absent bucket is ambiguous — empty, or the
  // definition changed? — and that ambiguity would be read during an incident.
  assert.equal(
    breakdownFrom({ byLabelPrefix: [{ prefix: 'treasury:', addresses: 0, total: '0' }] }),
    'treasury: 0 over 0 addresses',
  )
})

test('a breakdown this file cannot vouch for is absent, and never a repaired one', () => {
  // Each of these is a body that would still yield a perfectly good `total`. The split is a
  // diagnosis: it is dropped whole rather than partially rendered, and dropping it never withholds
  // the number the solvency check is actually made of.
  const refused: unknown[] = [
    // Nothing sent it — an indexer older than this release. Not an error.
    { total: '7' },
    { total: '7', byLabelPrefix: [] },
    { total: '7', byLabelPrefix: 'deposit: 7' },
    // A JSON number for an amount, which is the same defect `totalFrom` refuses one field up:
    // `JSON.parse` has already rounded anything above 2^53.
    { byLabelPrefix: [{ prefix: 'deposit:', addresses: 1, total: 7 }] },
    { byLabelPrefix: [{ prefix: 'deposit:', addresses: 1, total: '-7' }] },
    { byLabelPrefix: [{ prefix: 'deposit:', addresses: 1, total: '0x7' }] },
    { byLabelPrefix: [{ prefix: 'deposit:', addresses: 1.5, total: '7' }] },
    { byLabelPrefix: [{ prefix: 'deposit:', addresses: -1, total: '7' }] },
    { byLabelPrefix: [{ prefix: 'deposit:', addresses: '1', total: '7' }] },
    { byLabelPrefix: [{ prefix: '', addresses: 1, total: '7' }] },
    { byLabelPrefix: [{ addresses: 1, total: '7' }] },
    { byLabelPrefix: [null] },
    // Nine buckets against a bound of eight. REFUSED ENTIRELY rather than truncated to the first
    // eight: the whole claim of the phrase is that the parts explain the total, and eight of nine
    // parts under a total is a sentence that reads as a shortfall it is not.
    {
      byLabelPrefix: Array.from({ length: 9 }, (_, i) => ({
        prefix: `p${i}:`,
        addresses: 0,
        total: '0',
      })),
    },
    null,
    'not an object',
  ]
  for (const body of refused) {
    assert.equal(
      breakdownFrom(body),
      null,
      `${JSON.stringify(body) ?? String(body)} produced a breakdown`,
    )
  }
})

test('a prefix cannot reshape the freeze message it is pasted into', () => {
  // This string travels from another service's JSON into `asset_freezes.reason`, which is what the
  // console shows an operator first. A newline, an escape sequence, or two hundred characters of
  // padding would be writing into an incident message.
  assert.equal(
    breakdownFrom({
      byLabelPrefix: [{ prefix: 'dep\nosit:[31m', addresses: 1, total: '7' }],
    }),
    'deposit:31m 7 over 1 address',
  )
  const long = breakdownFrom({
    byLabelPrefix: [{ prefix: `d${'e'.repeat(400)}p:`, addresses: 1, total: '7' }],
  })
  assert.ok(long !== null && long.length < 60, `unbounded prefix: ${String(long)}`)
  // A prefix made ENTIRELY of characters that do not survive the filter leaves nothing to name the
  // bucket with, and an unnamed bucket in a breakdown is worse than no breakdown.
  assert.equal(breakdownFrom({ byLabelPrefix: [{ prefix: '\n\n', addresses: 1, total: '7' }] }), null)
})

/* ------------------------------------------------------------------ the status rule */

/** Answer one request with a chosen status and body, on a real socket. */
async function against(status: number, body: unknown): Promise<bigint | undefined> {
  const server = createHttpServer((_req, res) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    })
    res.end(payload)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const client = httpIndexerClient({
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    token: () => 'a-service-token-that-is-long-enough',
    deadlineMs: 2_000,
  })
  try {
    return await client.observedTotalFor('ember', 'testnet')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test('a 200 with a real total is the ONLY thing that returns a number', async () => {
  assert.equal(await against(200, { total: '7000000000000000000' }), 7_000_000_000_000_000_000n)
})

test('A 2xx THAT IS NOT 200 IS NOT AN ANSWER, even carrying a perfect body', async () => {
  // `HttpClient.request` returns a parsed body for every `res.ok` and does not surface the status,
  // so without the `exactly200` seam in the client each of these would reach the parser and become
  // a total. The custody route answers 200 or it refuses; a 2xx from anything else in the path is
  // that thing talking, not the indexer.
  for (const status of [201, 202, 203, 206, 226]) {
    const observed = await against(status, { total: '7000000000000000000' })
    assert.equal(observed, undefined, `a ${status} became a total`)
    assert.notEqual(observed, 0n)
  }
  // 204 has no body at all, and must not fall through some "empty means zero" path either.
  assert.equal(await against(204, ''), undefined)
})

test('every refusal status is undefined, and the fault code is never read as a value', async () => {
  for (const status of [400, 401, 403, 404, 429, 500, 501, 502, 503, 504]) {
    const observed = await against(status, {
      error: 'custody_total_unavailable',
      code: 'chain_not_followed',
      total: '7000000000000000000',
    })
    assert.equal(observed, undefined, `a ${status} became a total`)
  }
})

test('a 200 that is not JSON at all is undefined rather than an exception', async () => {
  assert.equal(await against(200, '<html>502 Bad Gateway</html>'), undefined)
  assert.equal(await against(200, '{ truncated'), undefined)
})

test('NOTHING IS RETRIED: a leased handler must not spend its lease on an outage', async () => {
  let requests = 0
  const server = createHttpServer((_req, res) => {
    requests += 1
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end('{"code":"rpc_unavailable"}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const client = httpIndexerClient({
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    token: () => 'a-service-token-that-is-long-enough',
    deadlineMs: 2_000,
  })
  const observed = await client.observedTotalFor('ember', 'testnet')
  await new Promise<void>((resolve) => server.close(() => resolve()))

  assert.equal(observed, undefined)
  // `HttpClient` retries an idempotent GET twice by default and 503 is in its retriable set, so
  // this is a real difference and not a tautology. The reconciliation job runs again in fifteen
  // minutes; that is the retry.
  assert.equal(requests, 1, `the client retried (${requests} requests)`)
})

/* ------------------------------------------------------------------ the two derived facts agree */

test('AN ASSET HAS A SLUG IF AND ONLY IF THE RECONCILER DEMANDS A READING FOR IT', () => {
  // Both are derived from `ON_CHAIN_ASSETS`, so today this cannot fail — which is the point of
  // writing it down: the next edit that gives either one its own list fails here instead of
  // freezing an asset nobody ever called about.
  const candidates: readonly string[] = [
    ...(ON_CHAIN_ASSETS as readonly string[]),
    'SHARD',
    'USD',
    'TOKEN:0xabc',
    'ember',
    '',
  ]
  for (const asset of candidates) {
    assert.equal(
      indexerChainFor(asset) !== undefined,
      isOnChainAsset(asset as LedgerAssetCode),
      `${asset}: the job's gate and the reconciler's rule disagree`,
    )
  }
})

test('the slug is the asset code lowercased, which is what the indexer and txUrn both use', () => {
  assert.equal(indexerChainFor('EMBER'), 'ember')
  assert.equal(indexerChainFor('BTC'), 'btc')
  // SHARD is in `CHAINS` only so that record is total. The indexer refuses the slug by design, and
  // a 404 there would freeze an asset that has no chain to be backed by.
  assert.equal(indexerChainFor('SHARD'), undefined)
})

/* ------------------------------------------------------------------ the grant */

test('the declared scope is exactly what the custody route demands, and no more', () => {
  // Read by `deploy/scripts/derive-grants.mjs` off this source and turned into ledger's entry in
  // `IDENTITY_SERVICE_TOKEN_GRANTS`. A hand-added grant in compose would FAIL that check, so this
  // constant is what provisions the credential.
  assert.deepEqual([...INDEXER_SCOPES], ['indexer:read'])
  // `indexer:write` would let this service register watched addresses. It registers none, and it
  // must never learn which addresses are custody's — the route answers one number for that reason.
  assert.equal(INDEXER_SCOPES.includes('indexer:write' as never), false)
  assert.equal(Object.isFrozen(INDEXER_SCOPES), true)
})
