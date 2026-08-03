/**
 * The producer half of the bus contract: what this service puts on the wire, and whether the estate
 * can read it.
 *
 * ## The defect this file exists to close
 *
 * Every consumer in the estate is pinned to `@cloudsforge/contracts-events`. `activity` declares its
 * classifier table `satisfies Readonly<Record<TopicName, _>>`; `notify` asserts it has a rule for
 * every registry topic. **The producer was pinned to nothing at all** — not to the topic names and,
 * worse, not to the shape of the envelope it wrote them into.
 *
 * This repository was wrong in the direction that is hardest to see, because nothing breaks and
 * nothing logs: **a registry topic this service owns that no emit site produced.**
 * `ledger.reconciliation.completed` has been registered with `producer: 'ledger'` since before the
 * service existed, `activity/src/classify.ts:335` classifies it, `analytics/src/catalogue.ts:312`
 * records it, and `reconcile.ts` finished a run, froze withdrawals and told nobody. Both consumers
 * were dead code for the life of the service. Nothing anywhere reported it, because a topic that is
 * never sent produces no error — it produces silence, and silence is what a working system also
 * produces.
 *
 * So this file pins the producer, in both directions and two ways:
 *
 *   1. **At compile time.** `EnvelopeCandidate` in `outbox.ts` types `version` as the contract's
 *      `EventVersion` and `actor`/`correlationId` as non-nullable, so the stored integer and the
 *      nullable columns are type errors rather than test failures — which is `pnpm typecheck`, which
 *      is the build.
 *   2. **At test time, against the source rather than against this list.** `topics.test.ts` reads
 *      every topic literal out of `src/` and reconciles that set with the registry IN BOTH
 *      DIRECTIONS, and it builds a real envelope through the relay's own `buildEnvelope` and hands
 *      it to the contract's own `classifyEnvelope`. A test that compared this list with the registry
 *      would agree with itself for ever while the emit sites drifted underneath it.
 *
 * ## Why the scan cannot look for `topic:`
 *
 * `ledger.entry.posted` is written by a **raw `insert into outbox (topic, …) values ('ledger.entry.
 * posted', …)`** at `entries.ts:427` — there is no `topic:` property anywhere near it, and there is
 * no emitter function to find either. A scan for the emit-site shape returns nothing here and passes
 * vacuously. `micro-org`'s estate checker had to be taught the same lesson. The scan is therefore for
 * every well-formed `ledger.*.*` STRING LITERAL, which finds both spellings and also finds a
 * constant no emit site uses.
 */

import {
  classifyEnvelope,
  isRegisteredTopic,
  isValidTopicName,
  topicsProducedBy,
  type TopicName,
  type TopicSpec,
} from '@cloudsforge/contracts-events'
import { ENTRY_POSTED } from './entries.ts'
import { RECONCILIATION_COMPLETED } from './reconcile.ts'

/** This service's own name, and the namespace it is the only permitted producer under. */
export const SERVICE = 'ledger'

/**
 * Every topic this service emits.
 *
 * The constants are imported from the modules that declare them rather than redeclared, so this list
 * cannot name a topic whose spelling has since changed under it. `topics.test.ts` additionally reads
 * the literals back out of `src/`, so it cannot name one that no emit site produces either.
 */
export const EMITTED_TOPICS = Object.freeze([ENTRY_POSTED, RECONCILIATION_COMPLETED] as const)

export interface ProposedTopic {
  /** Why the fact belongs on the bus at all. Read by a human reviewing the contracts change. */
  readonly reason: string
  /** The entry to add to `TOPICS` in `@cloudsforge/contracts-events`, verbatim. */
  readonly spec: TopicSpec
}

/**
 * Topics this service emits that the shared registry does not yet name.
 *
 * A quarantine, not an exemption, with three properties that keep it honest:
 *
 *   - An entry carries the exact `TopicSpec` it is asking for, so adopting it into
 *     `contracts/packages/events/src/index.ts` is a copy rather than a fresh design.
 *   - `topics.test.ts` asserts every entry is **genuinely absent** from the registry. The moment
 *     contracts registers one, this file fails until the entry is deleted — so the quarantine
 *     empties itself rather than rotting into a permanent allow-list.
 *   - An emit site whose topic is in neither the registry nor here fails the test.
 *
 * **It is empty, and that is the correct end state rather than a reason to delete the machinery.**
 * Both of this service's topics were registered before either was emitted, which is the unusual and
 * comfortable case — the registry led and the producer followed. The next topic this service invents
 * lands here before it lands in the registry.
 */
export const AWAITING_REGISTRATION: Readonly<Record<string, ProposedTopic>> = Object.freeze({})

/**
 * The ordering partition each emitted topic uses.
 *
 * **`key` IS THE ORDERING PARTITION, SO IT IS CONTRACT AND NOT A PRODUCER'S PREFERENCE.** Events
 * sharing a `(topic, key)` are delivered in the order they were written and no other pair has any
 * ordering relationship whatsoever, so a producer that picks its own key silently reorders every
 * consumer's view of the topic and nothing anywhere reports it.
 *
 * `topics.test.ts` asserts this table agrees with `topicSpec(topic).keyedBy` character for
 * character, and `reconcile.test.ts` asserts the value the REAL emitter puts on the row.
 */
export const KEYED_BY: Readonly<Record<string, string>> = Object.freeze({
  [ENTRY_POSTED]: 'account_id of the first posting',
  [RECONCILIATION_COMPLETED]: 'chain:network',
})

/* ------------------------------------------------------------------ reconciliation */

/** Topics this service emits that no registry names and no proposal explains — always a defect. */
export function undeclaredTopics(emitted: readonly string[]): readonly string[] {
  return emitted
    .filter((topic) => !isRegisteredTopic(topic) && !Object.hasOwn(AWAITING_REGISTRATION, topic))
    .sort()
}

/**
 * Registry topics this service owns and never emits — a feature that can never fire.
 *
 * **THE DIRECTION THIS REPOSITORY WAS WRONG IN.** The registry has said `ledger` produces
 * `ledger.reconciliation.completed` since before this service existed; nothing here emitted it, so
 * activity's classifier and analytics' event mapping were both dead code and a reconciliation that
 * froze withdrawals announced it to nobody. Nothing breaks and nothing logs when a topic is missing
 * — the consumer simply never hears from it.
 */
export function unemittedOwnedTopics(emitted: readonly string[]): readonly TopicName[] {
  const seen = new Set(emitted)
  return topicsProducedBy(SERVICE).filter((topic) => !seen.has(topic))
}

/** Proposals the registry has since adopted. Non-empty means delete the entry from the quarantine. */
export function adoptedProposals(): readonly string[] {
  return Object.keys(AWAITING_REGISTRATION).filter(isRegisteredTopic).sort()
}

/** A proposal that could not be pasted into the registry as it stands. */
export function malformedProposals(): readonly string[] {
  return Object.entries(AWAITING_REGISTRATION)
    .filter(([topic, proposal]) => {
      if (!isValidTopicName(topic) || !topic.startsWith(`${SERVICE}.`)) return true
      if (proposal.spec.producer !== SERVICE) return true
      if (proposal.spec.keyedBy.trim() === '') return true
      if (proposal.reason.trim().length < 20) return true
      return false
    })
    .map(([topic]) => topic)
    .sort()
}

/* ------------------------------------------------------------------ the envelope */

/**
 * Every reason a contract-following consumer would refuse this envelope.
 *
 * The check itself is `classifyEnvelope`, and it is the contract's — the exact check `activity`'s
 * ingest and `notify` run on a delivered body. Running it here, on an envelope this service's relay
 * actually built, is the only way a producer finds out it is unreadable without waiting for two
 * services to be composed. Composing two services is how the integer-version defect was found, and
 * it was found months late.
 *
 * `classifyEnvelope` rather than the contract's own `envelopeDefects(value, awaiting)` wrapper, for
 * the reason `settlement/src/topics.ts` records: `unregisteredTopic` is a FIELD on the verdict, not
 * a sentence in a list, so there is nothing here for a future flattening to drop. Five repositories
 * previously matched the contract's error SENTENCE byte for byte and would all have stopped excusing
 * anything the day it was reworded.
 */
export function envelopeDefects(envelope: unknown): readonly string[] {
  const verdict = classifyEnvelope(envelope)
  // Reported FIRST, where `validateEnvelope` has always put it, so a reader of a failure sees the
  // registry question before the envelope's own faults.
  const unexplained =
    verdict.unregisteredTopic !== null &&
    !Object.hasOwn(AWAITING_REGISTRATION, verdict.unregisteredTopic)
      ? [
          `topic: "${verdict.unregisteredTopic}" is not in the registry, and AWAITING_REGISTRATION does not propose it`,
        ]
      : []
  return [...unexplained, ...verdict.defects]
}
