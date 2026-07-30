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
import type { AssetTolerance, LedgerAssetCode } from '@cloudsforge/contracts-money'

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

const PLACEHOLDERS = new Set([
  'changeme',
  'change-me',
  'placeholder',
  'secret',
  'dev-secret',
  'dev-outbox-signing-secret',
  'replace-with-a-real-secret',
  'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
])

type Source = Readonly<Record<string, string | undefined>>

function required(source: Source, name: string): string {
  const value = source[name]?.trim()
  if (!value) throw new EnvError(`${name} is required — ${SERVICE} refuses to start without it`)
  return value
}

function requiredSecret(source: Source, name: string, minLength = 24): string {
  const value = required(source, name)
  if (PLACEHOLDERS.has(value.toLowerCase())) {
    throw new EnvError(`${name} is set to a known placeholder — generate a real secret`)
  }
  // Length is a proxy for entropy and the only one available here. It is set above the point at
  // which a human-chosen string is plausible, so a memorable password fails this check too.
  if (value.length < minLength) {
    throw new EnvError(`${name} must be at least ${minLength} characters (got ${value.length})`)
  }
  return value
}

function optional(source: Source, name: string, fallback: string): string {
  const value = source[name]?.trim()
  return value && value.length > 0 ? value : fallback
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
   */
  readonly reconcileAssets: readonly LedgerAssetCode[]
  readonly reconcileNetwork: 'mainnet' | 'testnet'
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

  return {
    port: integer(source, 'PORT', 4000, 1, 65_535),
    env: optional(source, 'NODE_ENV', 'development'),
    version: optional(source, 'CLOUDSFORGE_TAG', 'dev'),
    logLevel: logLevel as Env['logLevel'],
    databaseUrl: required(source, 'LEDGER_DATABASE_URL'),
    databasePoolMax: integer(source, 'LEDGER_DATABASE_POOL_MAX', 10, 1, 500),
    identityJwksUrl: required(source, 'IDENTITY_JWKS_URL'),
    identityIssuer: required(source, 'IDENTITY_ISSUER'),
    outboxSigningSecret: requiredSecret(source, 'OUTBOX_SIGNING_SECRET'),
    instanceId: optional(source, 'INSTANCE_ID', host || 'unknown'),
    assetTolerance: parseAssetTolerance(optional(source, 'LEDGER_ASSET_TOLERANCE', '{}')),
    reconcileAssets: assets as readonly LedgerAssetCode[],
    reconcileNetwork: network,
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
