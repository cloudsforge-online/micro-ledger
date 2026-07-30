import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * A valid environment, applied to the process before `./env.ts` is imported.
 *
 * The import itself is a test: `env.ts` validates eagerly and calls `process.exit(1)` on a bad
 * configuration, so if these values were not sufficient this file would not run at all. The
 * failure cases below go through `loadEnv`, which is pure over its source and therefore testable
 * without a child process.
 */
const VALID: Record<string, string> = {
  LEDGER_DATABASE_URL: 'postgres://ledger:pw@127.0.0.1:5432/ledger',
  IDENTITY_JWKS_URL: 'http://identity.test/.well-known/jwks.json',
  IDENTITY_ISSUER: 'http://identity.test',
  OUTBOX_SIGNING_SECRET: 'K2sN4vQ8xR1wB6tY9zL3mF7hC5jD0pA4',
}
for (const [key, value] of Object.entries(VALID)) process.env[key] = value

const { EnvError, SERVICE, env, loadEnv, parseAssetTolerance } = await import('./env.ts')

const BASE = VALID

test('a complete environment loads, and importing the module did not exit', () => {
  assert.equal(env.databaseUrl, VALID['LEDGER_DATABASE_URL'])
  assert.equal(env.port, 4000)
  assert.equal(SERVICE, 'ledger')
})

test('a missing variable names itself', () => {
  assert.throws(
    () => loadEnv({ ...BASE, LEDGER_DATABASE_URL: undefined }),
    (err: unknown) => err instanceof EnvError && /LEDGER_DATABASE_URL is required/.test(err.message),
  )
  assert.throws(() => loadEnv({ ...BASE, IDENTITY_JWKS_URL: undefined }), /IDENTITY_JWKS_URL is required/)
})

test('a placeholder secret is refused outright', () => {
  assert.throws(() => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: 'changeme' }), /known placeholder/)
  assert.throws(() => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: 'short' }), /at least 24 characters/)
})

test('THE SAFETY PROPERTY: an absent tolerance map means ZERO tolerance, not unlimited', () => {
  // `withinTolerance` in contracts-money fails closed on an asset it has no entry for, and this
  // parser must not undo that by inventing a default. An asset silently exempt from the only check
  // that guards it is worse than one that alerts too often.
  assert.deepEqual(loadEnv(BASE).assetTolerance, {})
})

test('tolerances are parsed as bigint, so an 18-decimal bound is not rounded', () => {
  const parsed = parseAssetTolerance('{"EMBER":"1000000000000000000000"}')
  assert.equal(parsed['EMBER'], 1_000_000_000_000_000_000_000n)
  // Beyond Number.MAX_SAFE_INTEGER by five orders of magnitude — a float here would round the
  // bound that decides whether withdrawals freeze.
  assert.ok(1_000_000_000_000_000_000_000n > BigInt(Number.MAX_SAFE_INTEGER))
})

test('a malformed or negative tolerance is refused rather than defaulted', () => {
  assert.throws(() => parseAssetTolerance('not json'), EnvError)
  assert.throws(() => parseAssetTolerance('[]'), EnvError)
  assert.throws(() => parseAssetTolerance('{"EMBER":"-1"}'), /must not be negative/)
  assert.throws(() => parseAssetTolerance('{"EMBER":"1.5"}'), /not an integer/)
})

test('the network must be stated, never inferred', () => {
  assert.throws(() => loadEnv({ ...BASE, LEDGER_RECONCILE_NETWORK: 'devnet' }), /mainnet or testnet/)
  assert.equal(loadEnv({ ...BASE, LEDGER_RECONCILE_NETWORK: 'mainnet' }).reconcileNetwork, 'mainnet')
})

test('the reconciled asset list must not be empty', () => {
  assert.throws(() => loadEnv({ ...BASE, LEDGER_RECONCILE_ASSETS: ' , ' }), /at least one asset/)
  assert.deepEqual(loadEnv({ ...BASE, LEDGER_RECONCILE_ASSETS: 'SHARD, EMBER' }).reconcileAssets, [
    'SHARD',
    'EMBER',
  ])
})

test('LOG_LEVEL is a closed set', () => {
  assert.throws(() => loadEnv({ ...BASE, LOG_LEVEL: 'verbose' }), /LOG_LEVEL must be one of/)
})
