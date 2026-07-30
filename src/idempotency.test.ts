import { test } from 'node:test'
import assert from 'node:assert/strict'
import { namespacedKey, requestFingerprint } from './idempotency.ts'

test('a retry with a fresh correlation id is a replay, not a 409', () => {
  // Regression, found by micro-wallet. A correlation id is a trace identifier and is meant to
  // change per attempt — that is what makes a retry distinguishable in a trace. Fingerprinting
  // it meant a caller doing exactly the right thing was told its idempotency key had been reused
  // with a different payload, and could not tell that apart from a genuine key collision.
  const first = { kind: 'transfer', amount: '100', correlationId: 'req-aaa' }
  const retry = { kind: 'transfer', amount: '100', correlationId: 'req-bbb' }
  assert.equal(requestFingerprint(first), requestFingerprint(retry))
})

test('a genuinely different payload under one key is still caught', () => {
  const first = { kind: 'transfer', amount: '100', correlationId: 'req-aaa' }
  const different = { kind: 'transfer', amount: '999', correlationId: 'req-aaa' }
  assert.notEqual(requestFingerprint(first), requestFingerprint(different))
})

test('field order does not change the fingerprint', () => {
  assert.equal(
    requestFingerprint({ a: 1, b: { c: 2, d: 3 } }),
    requestFingerprint({ b: { d: 3, c: 2 }, a: 1 }),
  )
})

test('a bigint amount fingerprints as its decimal string, never as a float', () => {
  assert.equal(
    requestFingerprint({ amount: 10n ** 24n }),
    requestFingerprint({ amount: '1000000000000000000000000' }),
  )
})

test('the namespaced key is scoped by service and route', () => {
  assert.equal(namespacedKey('wallet', '/v1/entries', 'abc'), 'wallet:/v1/entries:abc')
  assert.notEqual(
    namespacedKey('wallet', '/v1/entries', 'abc'),
    namespacedKey('billing', '/v1/entries', 'abc'),
  )
})
