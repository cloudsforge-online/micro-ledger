/**
 * Configuration, validated at import.
 *
 * Rule 9 of docs/ecosystem/03 §2 — "a repo declares the variables it needs; the deploy provides
 * exactly those" — is a property of this file. Every variable the service reads is named here and
 * nowhere else, so the deploy manifest can be derived from it and `env_file: .env` fan-out (which
 * hands every container the whole estate's secrets) has nothing to justify it.
 *
 * Two behaviours are copied deliberately from the estate's custody service, which is the only
 * place that gets this right today:
 *
 *   1. **A missing variable names itself.** `undefined` propagating into a connection string
 *      surfaces four layers later as an unreadable driver error.
 *   2. **A known placeholder is refused outright.** A default secret in source is not convenient,
 *      it is catastrophic.
 */

import { hostname } from 'node:os'
import {
  isTokenAsset,
  parseChainTokenAsset,
  type AssetTolerance,
  type LedgerAssetCode,
} from '@cloudsforge/contracts-money'
import { assertGeneratedSecret, assertServiceCredential } from '@cloudsforge/secrets'

/**
 * The service's own name. A constant rather than a variable: it is a property of the repository,
 * not of the deployment, and making it configurable is how two services end up sharing a
 * migration advisory lock.
 */
export const SERVICE = 'ledger'

/** Raised by `loadEnv`. Distinct so a caller can tell configuration from every other failure. */
export class EnvError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnvError'
  }
}

type Source = Readonly<Record<string, string | undefined>>

function required(source: Source, name: string): string {
  const value = source[name]?.trim()
  if (!value) throw new EnvError(`${name} is required — ${SERVICE} refuses to start without it`)
  return value
}

/**
 * ── THE CREDENTIAL GUARD LIVES IN `@cloudsforge/secrets`, NOT HERE ─────────────────────────────
 *
 * This file used to carry its own `assertServiceCredential`, and it was the copy the shared one was
 * promoted FROM (`runtime/packages/secrets/src/index.ts`). Keeping the local copy after the
 * promotion is the exact drift the package exists to prevent, and it was not free: the local copy
 * checked the JWT shape, the `cfsc_` prefix, the byte floor and the entropy floor — and NOT the
 * placeholder markers. So `cfsc_` + a long, high-entropy placeholder cleared every rule it had and
 * booted ledger with a credential that was never a credential. That hole is what micro-runtime
 * f01fe52 closed in the shared copy, and ledger did not inherit the fix because it was not calling
 * the shared copy.
 *
 * The hyphen asymmetry that makes this guard subtle — testnet's credential body carries a `-` and
 * mainnet's does not, so a "no hyphens" rule kills exactly one estate — is documented at length on
 * the shared function, along with the measured entropy floors. It is deliberately NOT restated
 * here: two copies of a rule is how the two networks ended up with two rules.
 *
 * `SecretError` rather than `EnvError` now escapes `loadEnv` for a bad credential. That is already
 * true of `requiredSigningSecret`, which has called the shared `assertGeneratedSecret` all along,
 * and `index.ts`'s `fatalConfig` handler reads `err.message` off `unknown`.
 */

/**
 * The estate's shared event-bus HMAC key, held to a shape rather than to a deny-list.
 *
 * A membership test cannot be the guard for this one. The `PLACEHOLDERS` set this file used to
 * carry refused a fixed list of exact strings and anything under 24 characters, and the value that
 * sat on 54 lines of a PUBLIC compose
 * file — `estate-only-outbox-secret-00000000000000` — was on no list and was 40 characters, so it
 * passed every service in the estate (micro-org #142). A check that could not fail read as the
 * absence of a problem.
 *
 * `assertGeneratedSecret` asserts what a placeholder cannot have: the base64 or hex alphabet (no
 * hyphens — every placeholder this estate wrote had one), 32 decoded BYTES rather than 24
 * keystrokes, and a measured Shannon entropy floor. It has no NODE_ENV exemption and no escape
 * hatch, so CI generates a real value per run rather than being let through.
 *
 * `required` rather than a length pre-check, deliberately: the weaker test is a strict subset of
 * the stronger one, and running it first would answer a 40-character placeholder with "must be at
 * least 24 characters" — a message that is true, useless, and points the operator at the wrong
 * property.
 */
function requiredSigningSecret(source: Source, name: string): string {
  const value = required(source, name)
  assertGeneratedSecret(name, value)
  return value
}

function optional(source: Source, name: string, fallback: string): string {
  const value = source[name]?.trim()
  return value && value.length > 0 ? value : fallback
}

/**
 * Absent is a supported mode; present-but-rubbish is not.
 *
 * `null` rather than `undefined` for absence, so the field it fills is a value a caller must
 * handle rather than a key that may or may not be there. `buildUpstreams` branches on it directly.
 *
 * The empty check stays ahead of the assertion because the compose block interpolates
 * `${LEDGER_IDENTITY_CREDENTIAL:-}` — an unset credential arrives as the empty string, and that is
 * the supported mode rather than a malformed one.
 */
function optionalCredential(source: Source, name: string): string | null {
  const value = source[name]?.trim()
  if (!value) return null
  assertServiceCredential(name, value)
  return value
}

/**
 * An absolute `http://` or `https://` origin, or nothing.
 *
 * Parsed rather than pattern-matched, so `INDEXER_URL=indexer:4000` — which `fetch` would treat as
 * a relative path and fail on at the fifteen-minute mark rather than at boot — names itself here.
 */
function optionalUrl(source: Source, name: string): string | undefined {
  const value = source[name]?.trim()
  if (!value) return undefined
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new EnvError(`${name} must be an absolute URL (got ${value})`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new EnvError(`${name} must be http or https (got ${parsed.protocol})`)
  }
  return value.replace(/\/+$/, '')
}

function integer(source: Source, name: string, fallback: number, min: number, max: number): number {
  const raw = source[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new EnvError(`${name} must be an integer between ${min} and ${max} (got ${raw})`)
  }
  return value
}

/**
 * Per-asset reconciliation tolerance, in smallest units.
 *
 * **An asset absent from the map gets zero tolerance, not infinity** — `withinTolerance` in
 * contracts-money fails closed on a missing entry, and this parser must not undo that by
 * inventing a default. The alternative is an asset silently exempt from the only check that
 * guards it.
 *
 * Parsed as strings and converted with `BigInt`, never `Number`: a tolerance for an 18-decimal
 * asset routinely exceeds `Number.MAX_SAFE_INTEGER`, and a float here would round the bound that
 * decides whether withdrawals freeze.
 *
 * ── WHY A TOLERANCE IS EVER NON-ZERO, AND WHY LTC'S IS ZERO ────────────────────────────────────
 *
 * A tolerance is not a comfort margin. It exists for one thing: the places where the chain's total
 * and the ledger's sum are computed at different scales and cannot be expected to agree to the
 * last unit. `.env.example` sets EMBER to 1000000000000000 — 0.001 EMBER of 18 decimals — for
 * exactly that reason, and it is the only entry there.
 *
 * **Litecoin's is zero, and that is a decision rather than an omission.** LTC is a UTXO chain of 8
 * decimals: the indexer's custody total is a sum of integer satoshi-denominated outputs, and this
 * ledger's position is a sum of integer postings. Neither side rounds, so there is no scale gap
 * for a tolerance to absorb, and any non-zero drift is a real discrepancy about real coin. BTC has
 * had no entry since this file was written, for the same reason and with the same effect.
 *
 * The consequence is worth stating plainly, because it is the point: a one-satoshi Litecoin drift
 * FREEZES LTC WITHDRAWALS. That is the correct response to a custodian that cannot account for a
 * unit of somebody's money, and the wrong instinct — "set it to something small so it stops
 * paging" — is how an asset ends up exempt from the only check that guards it while continuing to
 * look checked.
 *
 * Zero is what an absent entry already means, so stating it changes no behaviour. It is stated in
 * `.env.example` anyway, because an operator reading that file should see which assets were
 * considered and what was chosen for each. An absence cannot distinguish "decided" from
 * "forgotten", and this estate has been bitten by that distinction more than once.
 */
export function parseAssetTolerance(raw: string): AssetTolerance {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new EnvError('LEDGER_ASSET_TOLERANCE must be a JSON object of asset code to smallest-unit string')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new EnvError('LEDGER_ASSET_TOLERANCE must be a JSON object')
  }
  const out: Record<string, bigint> = {}
  for (const [asset, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new EnvError(`LEDGER_ASSET_TOLERANCE.${asset} must be a decimal string`)
    }
    // **`BigInt('') === 0n`, and so does `BigInt('   ')`.** Without this line an empty string is
    // accepted as a tolerance of zero — a bound nobody typed, indistinguishable afterwards from a
    // considered one. It fails CLOSED, so it is not a money leak; it is worse in a subtler way,
    // because the estate is now deliberately writing `"LTC":"0"` to mean "we thought about this
    // and chose zero", and a silent empty string would forge exactly that signal. An operator who
    // half-filled a deploy manifest must be told, not quietly agreed with.
    if (typeof value === 'string' && !/^-?\d+$/.test(value.trim())) {
      throw new EnvError(`LEDGER_ASSET_TOLERANCE.${asset} is not an integer: ${String(value)}`)
    }
    let amount: bigint
    try {
      amount = BigInt(value)
    } catch {
      throw new EnvError(`LEDGER_ASSET_TOLERANCE.${asset} is not an integer: ${String(value)}`)
    }
    if (amount < 0n) throw new EnvError(`LEDGER_ASSET_TOLERANCE.${asset} must not be negative`)
    out[asset] = amount
  }
  return out as AssetTolerance
}

export interface Env {
  readonly port: number
  readonly env: string
  readonly version: string
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error'
  /**
   * Rule 1: one database, named by this service's own variable. The CI check greps for any other
   * connection-string variable, so adding a second one here fails the build rather than review.
   */
  readonly databaseUrl: string
  readonly databasePoolMax: number
  readonly identityJwksUrl: string
  readonly identityIssuer: string
  /**
   * Where identity is, for `POST /service-tokens/exchange`.
   *
   * Defaults to `IDENTITY_ISSUER`, which is already required and is identity's own base URL — the
   * issuer of a token is by definition where the token came from. `IDENTITY_URL` overrides it for a
   * deployment where the two genuinely differ (an issuer behind a public name, dialled internally).
   * Deriving rather than demanding a fourth identity variable keeps the two in step: a deployment
   * that exchanged against one identity and trusted the JWKS of another would fail with a signature
   * error nobody would read as a configuration mistake. Copied from wallet, which is the reference
   * adoption of `ServiceTokenProvider`.
   */
  readonly identityUrl: string
  /** HMAC key for outbound event signatures, so a subscriber can prove an event came from us. */
  readonly outboxSigningSecret: string
  readonly instanceId: string
  readonly assetTolerance: AssetTolerance
  /**
   * Which assets the reconciliation job sweeps, and on which network.
   *
   * Explicit rather than derived from the accounts table: an asset that has no accounts yet still
   * needs a run that proves it is at zero, and an operator must be able to see the list that is
   * actually being checked without inferring it from data.
   *
   * ════════════════════════════════════════════════════════════════════════════════════════════
   * **THE DEFAULT INCLUDES EMBER, AND EMBER WILL FAIL EVERY RUN UNTIL AN INDEXER FEED EXISTS.**
   *
   * That is the intended behaviour, not an oversight, and it will freeze EMBER withdrawals on the
   * first sweep after deploy. Whoever reads this because a page fired should read the argument
   * before reaching for the workaround.
   *
   * `ON_CHAIN_ASSETS` (contracts/packages/chain/src/index.ts) lists EMBER, so `reconcileAsset`
   * demands an observation for it and records `unavailable` / `failed` without one. Hearth's
   * mainnet has not launched, so today there is nothing feeding it. The question is whether EMBER
   * should therefore be exempted, and the answer is no, for four reasons:
   *
   *   1. **The estate already decided.** EMBER is in `ON_CHAIN_ASSETS`. Treating it as off-chain
   *      here would create a second, contradicting list, which is the exact skew contracts-money
   *      warns against when it refuses to re-declare asset codes.
   *   2. **A pre-launch chain asset is not a special case, it is the worst case.** If Hearth has
   *      not launched then no EMBER is backed by anything, and custodial EMBER existing under those
   *      conditions IS `00-current-state.md` — "Custodial EMBER can be minted with no chain
   *      movement" — rather than a temporary inconvenience on the way to fixing it.
   *   3. **The failure is proportionate to what is actually at risk.** If EMBER custody is zero,
   *      the freeze costs nothing: there is nothing to withdraw. If it is NOT zero, then the
   *      platform is holding a liability it cannot prove backing for, and freezing withdrawals is
   *      the correct response rather than the regrettable one. There is no third case where the
   *      freeze is both costly and wrong.
   *   4. **The alternative rebuilds the defect under a new name.** An `if (asset === 'EMBER')
   *      return 'liability_sum'` is a check that cannot fail, on the one asset this entire release
   *      is about.
   *
   * **The escape hatch is this variable, deliberately, and it is the only one.** An operator who
   * accepts the risk removes EMBER from `LEDGER_RECONCILE_ASSETS`. That is a visible decision in a
   * deploy manifest, attributable and reviewable, which a code exemption is not — and it makes the
   * asset stop being *checked* rather than making it *look checked*. The freeze it leaves in place
   * stays until an exactly-clean observed run lifts it, so the decision cannot be quietly forgotten.
   * ════════════════════════════════════════════════════════════════════════════════════════════
   */
  readonly reconcileAssets: readonly LedgerAssetCode[]
  readonly reconcileNetwork: 'mainnet' | 'testnet'
  /**
   * Where the chain half of the solvency invariant is read from —
   * `GET /v1/custody/:chain/:network/total` on `micro-indexer`.
   *
   * ════════════════════════════════════════════════════════════════════════════════════════════
   * **OPTIONAL, AND THAT IS A DECISION WITH A REASON THAT IS NOT "IT SEEMED SAFER".**
   *
   * The obvious design is to demand it whenever `reconcileAssets` names an `ON_CHAIN_ASSETS`
   * member — the configuration is incoherent without it, and "a missing variable names itself" is
   * this file's first principle. **It would kill the estate.** `src/migrator.ts` imports this
   * module, so `ledger-migrate` — the one-shot container every other ledger container waits on
   * (`docker-compose.estate.yml`) — validates this environment too, and it is given
   * `LEDGER_DATABASE_URL` and `OUTBOX_SIGNING_SECRET` and nothing else. It does not
   * set `LEDGER_RECONCILE_ASSETS` either, so it would inherit the `SHARD,EMBER` default, demand an
   * indexer it has no business calling, exit 1, and take the estate's schema with it. That is the
   * same class of failure as the literal cross-repo import that broke `indexer-migrate`: found by
   * running the thing, not by reading it.
   *
   * Absence is safe in the only direction that counts. No URL means no client, which means no
   * observation, which for a chain asset is `unavailable` / `failed` — the asset freezes and stays
   * frozen. A misconfigured deploy stops withdrawals rather than quietly reporting a number, and
   * `index.ts` logs the condition at boot so it is a line an operator sees rather than a silence.
   * ════════════════════════════════════════════════════════════════════════════════════════════
   */
  readonly indexerUrl: string | undefined
  /**
   * Absolute wall-clock ceiling on the custody-total call, across connect and body.
   *
   * It is a ceiling on a JOB'S LEASE as much as on a request. The reconciliation job holds its
   * lease for the whole handler, so a provider holding the socket open holds the lease with it,
   * and the asset's next run cannot be claimed until it drops. Five seconds is the deploy's value
   * and the default here; the ceiling is 60s because anything beyond that is a stuck job wearing a
   * timeout's clothes.
   */
  readonly indexerDeadlineMs: number
  /**
   * **The long-lived credential this service exchanges for the short-lived tokens it presents to
   * the indexer.** Optional, and unset is a supported mode.
   *
   * ════════════════════════════════════════════════════════════════════════════════════════════
   * **IT REPLACES `LEDGER_SERVICE_TOKEN`, AND THE REPLACEMENT IS THE WHOLE POINT.**
   *
   * That variable held a **600-second** token (`identity/src/tokens.ts`), read once at import,
   * and the reconciliation job runs every **900 seconds** (`jobs.ts:recurringJobs`). So the chain
   * half of the solvency invariant authenticated exactly once per bootstrap and never again: from
   * minute ten onwards every sweep got a 401, every 401 mapped to `undefined`, every `undefined`
   * recorded `unavailable` / `failed`, and EMBER froze — while producing **byte-identical output**
   * to the honest "no chain could be observed" freeze this service is designed to produce.
   *
   * That is worse than a broken check. It is a check whose failure mode is indistinguishable from
   * its correct pessimistic answer, so the freeze could not be read, and an operator following the
   * `unavailable` line would go looking at a chain that was fine.
   *
   * A credential is not a token. It confers nothing by itself, it is revocable, it survives a
   * restart, and `@cloudsforge/auth`'s `ServiceTokenProvider` exchanges it at
   * `POST /service-tokens/exchange` for an ordinary ten-minute token, re-minting at ~80% of its
   * life. **The ten minutes is deliberately unchanged** — rotation IS expiry.
   *
   * ── WHY IT IS STILL OPTIONAL, AND WHY THAT IS NOT THE SAME MISTAKE ────────────────────────────
   *
   * `src/migrator.ts` imports this module, so `ledger-migrate` validates this environment too and
   * is given `LEDGER_DATABASE_URL` and `OUTBOX_SIGNING_SECRET` and nothing else. Making this
   * required here would exit 1 and take the estate's schema with it — the same argument that keeps
   * `indexerUrl` optional, and the same one wallet makes for its CI `/livez` smoke test.
   *
   * Absence fails closed and fails *legibly*, which is the difference from before: no credential
   * means the token supplier rejects with `ServiceTokenUnavailableError`, the call is never sent
   * unauthenticated, and the run records `unavailable` with `unobserved_reason = 'no_credential'`
   * — a different row from a chain that could not be observed. `index.ts` also says so at boot.
   * ════════════════════════════════════════════════════════════════════════════════════════════
   */
  readonly identityCredential: string | null
  /**
   * Whether the retired `LEDGER_SERVICE_TOKEN` is still set.
   *
   * Read for exactly one purpose: to say so at boot. An operator who redeploys with the old
   * variable and not the new one would otherwise get a service that looks configured and is not —
   * which is a slower, quieter version of the very defect the credential was introduced to fix.
   * wallet, worlds, mint, nda, billing and hub-api each carry the same field for the same reason.
   */
  readonly legacyServiceTokenPresent: boolean
  /**
   * How long an idempotency key is honoured. Expiring one EARLY means the next replay of it does
   * the work a second time, so the TTL must outlive every caller's retry horizon rather than be
   * as short as the table would like.
   */
  readonly idempotencyTtlDays: number
}

const LEVELS = new Set(['debug', 'info', 'warn', 'error'])

/**
 * Pure over its source so the failure paths are testable without mutating the process. The eager
 * export below is what makes the service fail fast.
 */
export function loadEnv(source: Source = process.env, host = ''): Env {
  const logLevel = optional(source, 'LOG_LEVEL', 'info')
  if (!LEVELS.has(logLevel)) {
    throw new EnvError(`LOG_LEVEL must be one of debug, info, warn, error (got ${logLevel})`)
  }

  const network = optional(source, 'LEDGER_RECONCILE_NETWORK', 'testnet')
  if (network !== 'mainnet' && network !== 'testnet') {
    throw new EnvError(`LEDGER_RECONCILE_NETWORK must be mainnet or testnet (got ${network})`)
  }

  const assets = optional(source, 'LEDGER_RECONCILE_ASSETS', 'SHARD,EMBER')
    .split(',')
    .map((a) => a.trim())
    .filter((a) => a.length > 0)
  if (assets.length === 0) {
    throw new EnvError('LEDGER_RECONCILE_ASSETS must name at least one asset')
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // A USER-MINTED `TOKEN:` ASSET MAY NOT BE SWEPT, AND NAMING ONE HERE IS A ONE-WAY MISTAKE.
  //
  // micro-org#407 §1. A tessera object is `TOKEN:cf:tessera:object:<hex>` — no chain, no contract,
  // nothing that observes it. It is also not in `ON_CHAIN_ASSETS`, so the INVARIANT 6 trigger
  // (migration 11) permits `observed_source = 'liability_sum'`: a sweep would compare the custody
  // total (zero — an issued object has no custody, by construction) against the author's liability
  // (one) and record drift. Drift beyond tolerance writes an `asset_freezes` row, and only an
  // exactly-clean OBSERVED run lifts one. An unobservable asset cannot produce one, so removing
  // the name afterwards leaves the freeze standing — the same trap migration 15 spells out for
  // DOGE and ETC, except that here it is reached by an asset the estate MINTS rather than one an
  // operator adds.
  //
  // A CHAIN token — `TOKEN:<chain>:<network>:<0x contract>` — is deliberately still allowed. That
  // one is observable in principle (an ERC-20 balance is a thing the indexer can read), so the
  // refusal is narrow: it is about assets with no possible observer, not about the `TOKEN:` prefix.
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  const unobservable = assets.filter(
    (a) => isTokenAsset(a as LedgerAssetCode) && parseChainTokenAsset(a as LedgerAssetCode) === null,
  )
  if (unobservable.length > 0) {
    throw new EnvError(
      `LEDGER_RECONCILE_ASSETS names ${unobservable.join(', ')}, which nothing can observe. A ` +
        'user-minted TOKEN: asset (a tessera object) has no custody and no chain, so a sweep ' +
        'would read drift against its own liability and freeze it permanently — only an ' +
        'exactly-clean observed run lifts a freeze, and there can never be one. Remove it. A ' +
        'chain token, TOKEN:<chain>:<network>:<0x contract>, is accepted.',
    )
  }

  return {
    port: integer(source, 'PORT', 4000, 1, 65_535),
    env: optional(source, 'NODE_ENV', 'development'),
    version: optional(source, 'CLOUDSFORGE_TAG', 'dev'),
    logLevel: logLevel as Env['logLevel'],
    databaseUrl: required(source, 'LEDGER_DATABASE_URL'),
    databasePoolMax: integer(source, 'LEDGER_DATABASE_POOL_MAX', 10, 1, 500),
    identityJwksUrl: required(source, 'IDENTITY_JWKS_URL'),
    identityIssuer: required(source, 'IDENTITY_ISSUER'),
    identityUrl: optional(source, 'IDENTITY_URL', required(source, 'IDENTITY_ISSUER')),
    outboxSigningSecret: requiredSigningSecret(source, 'OUTBOX_SIGNING_SECRET'),
    instanceId: optional(source, 'INSTANCE_ID', host || 'unknown'),
    assetTolerance: parseAssetTolerance(optional(source, 'LEDGER_ASSET_TOLERANCE', '{}')),
    reconcileAssets: assets as readonly LedgerAssetCode[],
    reconcileNetwork: network,
    indexerUrl: optionalUrl(source, 'INDEXER_URL'),
    indexerDeadlineMs: integer(source, 'LEDGER_INDEXER_DEADLINE_MS', 5_000, 100, 60_000),
    // Optional, not required: see the field comment. The absence is caught by a reconciliation run
    // that names it, which is a check that can fail, rather than by a boot `ledger-migrate` cannot
    // perform.
    identityCredential: optionalCredential(source, 'LEDGER_IDENTITY_CREDENTIAL'),
    legacyServiceTokenPresent: (source['LEDGER_SERVICE_TOKEN']?.trim() ?? '').length > 0,
    idempotencyTtlDays: integer(source, 'LEDGER_IDEMPOTENCY_TTL_DAYS', 30, 1, 3_650),
  }
}

/**
 * The checks above run at import, before the logger exists, so an uncaught throw reaches the
 * container as a bare V8 stack: not JSON, no level, no service name. The collector drops it and
 * the only symptom an operator gets is a container that exits instantly.
 *
 * So emit one structured fatal line by hand. It is built from a literal rather than routed through
 * the telemetry package: nothing that can itself fail may sit between a configuration error and
 * the report of it. The message is the one `loadEnv` produced, which by construction never
 * contains a value.
 */
function fatalConfig(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(
    `${JSON.stringify({
      time: new Date().toISOString(),
      level: 'fatal',
      service: SERVICE,
      step: 'env',
      msg: `startup failed at: env — ${message}`,
    })}\n`,
  )
  process.exit(1)
}

export const env: Env = (() => {
  try {
    return loadEnv(process.env, hostname())
  } catch (err) {
    fatalConfig(err)
  }
})()
