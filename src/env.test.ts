import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

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
  // GENERATED, not written. `assertGeneratedSecret` refuses a typed value, and a fixture
  // exempt from the rule it is meant to exercise is how the placeholder in micro-org #142
  // survived every test in the estate.
  OUTBOX_SIGNING_SECRET: randomBytes(48).toString('base64'),
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
  assert.throws(() => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: 'short' }), /3 bytes of key material/)
})

test('THE VALUE THAT SAT IN A PUBLIC REPOSITORY IS REFUSED, and every near miss with it', () => {
  // micro-org #142. Each of these cleared the old guard — a deny-list of exact strings plus a
  // 24-character floor — and each is a real string that was deployed or set in CI, not an invented
  // one. If a future edit weakens the floor, it fails against evidence rather than against taste.
  for (const value of [
    'estate-only-outbox-secret-00000000000000', // 54 lines of a PUBLIC compose file, 40 chars
    'ci-only-not-a-real-secret-000000000000', // 23 CI workflows
    'K2sN4vQ8xR1wB6tY9zL3mF7hC5jD0pA4', // this file's own former fixture: 32 chars, 24 bytes
    '0'.repeat(64), // right alphabet, right length, no entropy
  ]) {
    assert.throws(
      () => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: value }),
      (err: unknown) => {
        // The refusal must not echo the value: the reason this guard exists is that the value was
        // readable, and a message carrying it moves the secret to the log collector.
        const message = (err as Error).message
        assert.ok(!message.includes(value), 'the refusal echoed the value')
        assert.match(message, /OUTBOX_SIGNING_SECRET/)
        assert.match(message, /openssl rand -base64 48/)
        return true
      },
    )
  }
})

test('what the estate is actually running is accepted', () => {
  // Measured on both networks 2026-08-05: 64 characters, base64, 48 bytes, 5.27 bits per character.
  assert.doesNotThrow(() => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: randomBytes(48).toString('base64') }))
  assert.doesNotThrow(() => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: randomBytes(32).toString('hex') }))
})

test('THE SAFETY PROPERTY: an absent tolerance map means ZERO tolerance, not unlimited', () => {
  // `withinTolerance` in contracts-money fails closed on an asset it has no entry for, and this
  // parser must not undo that by inventing a default. An asset silently exempt from the only check
  // that guards it is worse than one that alerts too often.
  assert.deepEqual(loadEnv(BASE).assetTolerance, {})
})

test('LTC IS AT ZERO TOLERANCE, stated rather than omitted — a satoshi of drift freezes it', () => {
  // Zero and absent are the same BEHAVIOUR, which is exactly why this needs a test: nothing else
  // in the suite could tell a deliberate zero apart from a forgotten entry, and the two are very
  // different facts about whether anybody thought about Litecoin.
  //
  // The argument for zero is that there is no scale gap to absorb. LTC is a UTXO chain of 8
  // decimals: the indexer sums integer outputs, the ledger sums integer postings, neither rounds.
  // EMBER's non-zero bound exists because 18 decimals and fees in flight genuinely do not agree to
  // the last unit; copying that reasoning across to an 8-decimal UTXO chain would be the "reuse
  // the number with the code" mistake contracts-chain raises about Litecoin's confirmation depth.
  const parsed = parseAssetTolerance('{"EMBER":"1000000000000000","LTC":"0"}')
  assert.equal(parsed['LTC'], 0n)
  assert.equal(parsed['EMBER'], 1_000_000_000_000_000n)

  // `BigInt('') === 0n`, so an empty string would parse as a zero tolerance that nobody typed.
  // It reads identically in a deploy manifest and it must not be accepted as one.
  assert.throws(() => parseAssetTolerance('{"LTC":""}'), /not an integer/)

  // And the freeze this buys: one smallest unit of drift is already outside the bound.
  const bound = parsed['LTC'] ?? 0n
  assert.ok(1n > bound, 'a one-satoshi Litecoin drift must not be within tolerance')
})

test('the shipped example config parses, and says something about every asset it names', () => {
  // `.env.example` is the file an operator copies. A tolerance map that does not parse there is a
  // service that will not boot, discovered by the operator rather than by this suite.
  const shipped = readFileSync(new URL('../.env.example', import.meta.url), 'utf8')
  const line = /^LEDGER_ASSET_TOLERANCE=(.+)$/m.exec(shipped)?.[1]
  assert.ok(line, '.env.example no longer sets LEDGER_ASSET_TOLERANCE')
  const parsed = parseAssetTolerance(line)
  assert.equal(parsed['LTC'], 0n, '.env.example stopped stating LTC, which is how a zero becomes a shrug')
  assert.ok((parsed['EMBER'] ?? 0n) > 0n)
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
  // A hyphen IN THE BODY, because both live estates mint base64url and testnet's really does carry
  // one. A guard written against custody's "no hyphens" rule passes this test's mainnet-shaped
  // sibling and kills testnet at boot, which is why the fixture is the awkward one.
  const good = 'cfsc_5ntCPqB0ZQ3xk1r-8LHYyU2eWvJfA6oMdT4siGXn9Kc'
  assert.equal(loadEnv({ ...BASE, LEDGER_IDENTITY_CREDENTIAL: good }).identityCredential, good)

  const alnum = 'cfsc_5ntCPqB0ZQ3xk1r8LHYyU2eWvJfA6oMdT4siGXn9KcQ'
  assert.equal(loadEnv({ ...BASE, LEDGER_IDENTITY_CREDENTIAL: alnum }).identityCredential, alnum)

  // Absent stays absent. The compose block interpolates `${LEDGER_IDENTITY_CREDENTIAL:-}`, so an
  // unconfigured deployment hands this the empty string and must still boot `ledger-migrate`.
  assert.equal(loadEnv({ ...BASE, LEDGER_IDENTITY_CREDENTIAL: '' }).identityCredential, null)
  assert.equal(loadEnv({ ...BASE, LEDGER_IDENTITY_CREDENTIAL: '   ' }).identityCredential, null)

  assert.throws(() => loadEnv({ ...BASE, LEDGER_IDENTITY_CREDENTIAL: 'changeme' }), /service credential/)

  // THE UNIT IS BYTES OF KEY MATERIAL. `cfsc_short` used to be refused for being under 24
  // CHARACTERS, which is the wrong property measured with the wrong unit — the old message was
  // true and pointed the operator nowhere.
  assert.throws(() => loadEnv({ ...BASE, LEDGER_IDENTITY_CREDENTIAL: 'cfsc_short' }), /bytes of key material/)

  // THE CASE THE DELETED `PLACEHOLDERS` SET COULD NOT CATCH, and the whole of micro-org#142: 40
  // characters, on no list, waved through by every service in the estate.
  assert.throws(
    () => loadEnv({ ...BASE, LEDGER_IDENTITY_CREDENTIAL: 'estate-only-outbox-secret-00000000000000' }),
    /service credential/,
  )

  // Long enough and correctly prefixed, but it is a repeated pattern rather than a key. A length
  // gate alone accepts this; that is what a length gate is worth.
  assert.throws(
    () => loadEnv({ ...BASE, LEDGER_IDENTITY_CREDENTIAL: `cfsc_${'a'.repeat(48)}` }),
    /entropy/,
  )

  // A TOKEN where a credential belongs — the ten-minute cliff wearing the fix's clothes, and the
  // exact confusion that made settlement the estate's only unhealthy container (micro-org#197).
  assert.throws(
    () => loadEnv({ ...BASE, LEDGER_IDENTITY_CREDENTIAL: 'eyJhbGciOiJSUzI1NiIsImtpZCI6IjdiNjY1YyJ9.x.y' }),
    /carries a TOKEN, not a credential/,
  )

  // THE PREFIX IS NOT THE CREDENTIAL, and this is the case ledger's own deleted copy let through
  // (micro-org#229). It is correctly prefixed, it is 43 body characters, it clears the 32-byte
  // floor and it measures well above the 4.0 entropy floor — so the JWT check, the prefix check,
  // the byte check and the entropy check ALL pass it. Only the placeholder markers refuse it, and
  // the local copy was the one assertion in the estate that never ran them. A CI workflow here was
  // written against exactly this hole.
  assert.throws(
    () => loadEnv({ ...BASE, LEDGER_IDENTITY_CREDENTIAL: 'cfsc_ci-only-NOT-a-real-credential-9xKq2mZ7vB' }),
    /reads as a placeholder/,
  )
})

test('no refusal message ever contains the credential', () => {
  // `EnvError.message` is written to stderr verbatim and the collector ships it, so an echoed
  // secret moves from one place it should not be to another.
  const secrets = [
    'cfsc_short',
    `cfsc_${'a'.repeat(48)}`,
    'estate-only-outbox-secret-00000000000000',
    'eyJhbGciOiJSUzI1NiIsImtpZCI6IjdiNjY1YyJ9.x.y',
  ]
  for (const secret of secrets) {
    assert.throws(
      () => loadEnv({ ...BASE, LEDGER_IDENTITY_CREDENTIAL: secret }),
      (err: unknown) => {
        const message = (err as Error).message
        assert.equal(message.includes(secret), false, `the value reached the message: ${message}`)
        assert.ok(message.includes('LEDGER_IDENTITY_CREDENTIAL'), 'the message must name the variable')
        return true
      },
    )
  }
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
