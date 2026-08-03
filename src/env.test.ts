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

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * THE CREDENTIAL. It replaced a 600-second token read once at import, inside a job that runs every
 * 900 seconds.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

test('the identity credential is OPTIONAL, because `ledger-migrate` shares this env module', () => {
  // `src/migrator.ts` imports `./env.ts`, and the one-shot container every other ledger container
  // waits on is given LEDGER_DATABASE_URL and OUTBOX_SIGNING_SECRET and nothing else. Making this
  // `requiredSecret` would exit 1 and take the estate's schema with it — the same argument that
  // keeps INDEXER_URL optional. The absence is not silent: it is a boot line, a gauge, and
  // `unobserved_reason = 'no_credential'` on the run that freezes the asset.
  assert.equal(loadEnv(BASE).identityCredential, null)
  assert.doesNotThrow(() => loadEnv(BASE))
})

test('absent is a supported mode; present-but-rubbish is not', () => {
  const good = 'cfsc_5ntCPqB0ZQ3xk1r-8LHYyU2eWvJfA6oMdT4siGXn9Kc'
  assert.equal(loadEnv({ ...BASE, LEDGER_IDENTITY_CREDENTIAL: good }).identityCredential, good)
  assert.throws(() => loadEnv({ ...BASE, LEDGER_IDENTITY_CREDENTIAL: 'changeme' }), /known placeholder/)
  assert.throws(() => loadEnv({ ...BASE, LEDGER_IDENTITY_CREDENTIAL: 'cfsc_short' }), /at least 24 characters/)
})

test('the exchange is dialled at IDENTITY_ISSUER unless IDENTITY_URL says otherwise', () => {
  // Derived rather than demanded as a fourth identity variable: the issuer of a token is by
  // definition where the token came from, and a deployment that exchanged against one identity
  // while trusting the JWKS of another would fail with a signature error nobody reads as a
  // configuration mistake.
  assert.equal(loadEnv(BASE).identityUrl, VALID['IDENTITY_ISSUER'])
  assert.equal(
    loadEnv({ ...BASE, IDENTITY_URL: 'http://identity:4000' }).identityUrl,
    'http://identity:4000',
  )
})

test('the retired LEDGER_SERVICE_TOKEN is DETECTED and never used', () => {
  // Read for exactly one purpose: `index.ts` logs an ERROR saying it is set and is IGNORED. An
  // operator who redeploys with the old variable and not the new one would otherwise get a service
  // that looks configured and is not — a quieter version of the defect the credential replaced.
  const withLegacy = loadEnv({ ...BASE, LEDGER_SERVICE_TOKEN: 'eyJhbGciOiJSUzI1NiIsImtpZCI6IjdiNjY1YyJ9.x.y' })
  assert.equal(withLegacy.legacyServiceTokenPresent, true)
  // And it does NOT become the credential. Presenting a token where a credential belongs is the
  // ten-minute cliff wearing the fix's clothes.
  assert.equal(withLegacy.identityCredential, null)
  assert.equal(loadEnv(BASE).legacyServiceTokenPresent, false)
  // A legacy token that is also rubbish must not stop the service booting: it is ignored, so it
  // cannot be a reason to refuse a configuration that is otherwise complete.
  assert.doesNotThrow(() => loadEnv({ ...BASE, LEDGER_SERVICE_TOKEN: 'changeme' }))
})
