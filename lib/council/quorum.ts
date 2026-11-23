/**
 * Council quorum + fallback rules for settlement (agents / RFB council boundary).
 *
 * `gatherCouncilVerdict` buys persona votes and tallies them. This module is the
 * pure policy layer that decides whether that tally is allowed to settle a claim,
 * or whether the oracle must fall back to its own (solo) verdict — and what to do
 * when a vote is invalid, stale, duplicated, cancelled, or a dependency failure.
 *
 * Before outcome evaluation, callers can bind a versioned council ballot commitment
 * ({@link createBallotCommitment} / {@link verifyBallotCommitment}) covering
 * participant identities, claim revision, the eligible vote set, and the approved
 * voting boundary. Any ballot altered after the approved voting boundary is
 * rejected before quorum outcome evaluation.
 *
 * Chain remains source of truth: a cancelled or already-resolved claim never
 * produces a council settlement from this path. Below-quorum and dependency
 * failures degrade to solo oracle settlement rather than inventing a majority.
 *
 * Pure: no I/O. Callers classify each attempt, then ask {@link evaluateQuorum}.
 *
 * Policy revision: every evaluation carries `policyRevision`, a stable reference
 * identifying the rule set that produced the decision. It is derived from the
 * policy's *effective* parameters (quorum after normalization), not from the
 * default constants themselves, so changing a default in a future release does
 * not silently rewrite the reference recorded for historical ballots. Replaying
 * a captured ballot under a pinned revision yields the identical decision.
 */

import { createHash } from "node:crypto";
import { isVerdict, type Verdict } from "../verdict";
import {
  evaluateQuorumIndependence,
  type QuorumIndependenceEvaluation,
  type QuorumIndependenceConfig,
} from "./independence";

export {
  buildCouncilIndependenceReport,
  evaluateQuorumIndependence,
  formatCouncilIndependenceReport,
  INSTITUTIONAL_INDEPENDENCE_DISCLAIMER,
  type CouncilIndependenceReport,
  type CouncilIndependenceSummary,
  type IndependenceGroupings,
  type CorrelationCluster,
  type IndependenceAssumption,
  type PersonaIndependenceProfile,
  type QuorumIndependenceEvaluation,
  type QuorumIndependenceConfig,
} from "./independence";

/** Claim lifecycle states the quorum gate cares about. */
export type ClaimSettleState = "open" | "active" | "resolved" | "cancelled" | "paused" | "expired";

/**
 * What happened to one persona vote attempt before it may enter the ballot.
 *
 * - **valid** — well-formed verdict for the claim being settled; may be decisive
 *   or an explicit abstention (DRAW / UNRESOLVABLE).
 * - **invalid** — malformed slug/verdict/body, ineligible voter, or post-boundary alteration; never counts.
 * - **stale** — wrong claim id/revision, already-resolved claim, aged past maxAgeMs, or recorded after voting boundary.
 * - **duplicated** — same persona already accepted onto this ballot.
 * - **cancelled** — claim is cancelled; council must not settle it.
 * - **paused** — persona or claim is paused; council must not settle it.
 * - **dependency_failure** — network / timeout / 5xx; treated as abstention for
 *   tally purposes but recorded so fallback reasons stay auditable.
 * - **equivocation** — persona submitted contradictory/conflicting votes.
 * - **expired** — ballot or vote submission deadline has elapsed.
 */
export type VoteDisposition =
  | "valid"
  | "invalid"
  | "stale"
  | "duplicated"
  | "cancelled"
  | "paused"
  | "dependency_failure"
  /**
   * Persona did not vote before the council deliberation deadline. Counted as
   * abstention (never as a decisive or DRAW vote) so missing votes cannot be
   * mistaken for consensus.
   */
  | "deadline_abstention";

export type FallbackAction =
  /** Decisive votes met quorum — use the council tally. */
  | "use_council"
  /** Not enough decisive votes (or only dependency failures) — oracle settles solo. */
  | "fallback_solo"
  /** Claim cancelled on-chain — do not settle via council or invent a solo win. */
  | "abort_cancelled"
  /** Claim already resolved — a new council pass would be stale. */
  | "abort_resolved"
  /** Claim is paused — council must not settle it. */
  | "abort_paused"
  /** Ballot or settlement window has expired — council settlement aborted. */
  | "abort_expired"
  /** Quorum config is unusable after normalization refusal. */
  | "abort_invalid_config"
  /** Deadline passed with too few decisive votes — oracle settles solo, never by default consensus. */
  | "fallback_deadline";

export interface QuorumConfig {
  /**
   * Minimum decisive (CREATOR_WINS | CHALLENGERS_WIN) votes required to trust
   * the council. Defaults to {@link DEFAULT_COUNCIL_QUORUM}.
   */
  quorum: number;
}

/** Default matches `COUNCIL_QUORUM` / oracle worker env. */
export const DEFAULT_COUNCIL_QUORUM = 3;

/** Hard ceiling so a typo cannot demand more jurors than exist. */
export const MAX_COUNCIL_QUORUM = 20;

/**
 * Stable identifier for the quorum rule set. Bump the leading version only when
 * the decision semantics change (not when defaults are tuned). The effective
 * quorum is appended so the reference pins the parameter actually applied.
 */
export const QUORUM_POLICY_ID = "council-quorum/v1";

/**
 * Build the policy revision reference for an effective (normalized) quorum.
 * Depends only on the effective parameter, so a default change that does not
 * alter the effective value keeps prior references valid.
 */
export function policyRevisionFor(effectiveQuorum: number): string {
  return `${QUORUM_POLICY_ID}:q=${effectiveQuorum}`;
}

/** Bumped whenever the canonical council ballot commitment byte layout changes. */
export const COUNCIL_BALLOT_COMMITMENT_VERSION = 1;

/** Alias for {@link COUNCIL_BALLOT_COMMITMENT_VERSION}. */
export const BALLOT_COMMITMENT_VERSION = COUNCIL_BALLOT_COMMITMENT_VERSION;

export interface BallotParticipantIdentity {
  /** Normalized lowercase persona slug. */
  slug: string;
  /** Optional case-sensitive participant account/wallet identifier (e.g. Stellar G… address). */
  address?: string;
  /** Optional council jury track. */
  track?: "classic" | "philosopher";
}

export type BallotParticipantInput = string | BallotParticipantIdentity;
export interface VoteAttemptInput {
  slug: string;
  /** Optional participant wallet/account address bound to this vote attempt. */
  participantAddress?: string;
  /** Claim id the response claims to be about (from body or request). */
  claimId: number;
  /** Claim id the oracle is currently settling. */
  expectedClaimId: number;
  /** Claim revision reported with the vote attempt, when revision binding is active. */
  claimRevision?: number | string;
  /** Claim revision expected at the settlement boundary, when revision binding is active. */
  expectedClaimRevision?: number | string;
  /** Optional set of eligible persona slugs allowed to vote on this claim. */
  eligibleVoteSet?: readonly string[];
  /** Epoch ms when the vote was originally recorded, when known. */
  recordedAtMs?: number;
  /** Epoch ms when the vote was altered/mutated, when known. */
  alteredAtMs?: number;
  /** Approved voting boundary timestamp (epoch ms); votes recorded or altered after this are rejected. */
  votingBoundaryMs?: number;
  claimState: ClaimSettleState;
  /** True when this persona is currently paused and must not vote. */
  personaPaused?: boolean;
  /**
   * Transport outcome before JSON validation.
   * - `ok` — HTTP 2xx with a body to inspect
   * - `http_error` — non-2xx (see httpStatus)
   * - `network_error` / `timeout` — dependency failure
   */
  status: "ok" | "http_error" | "network_error" | "timeout";
  httpStatus?: number;
  verdict?: unknown;
  confidence?: unknown;
  /** Age of the response when known (ms). */
  ageMs?: number;
  /** Responses older than this are stale (optional). */
  maxAgeMs?: number;
  /** Statement digest of the claim when reasoning/vote was generated. */
  statementDigest?: string;
  /** Expected statement digest; mismatch classifies attempt as stale. */
  expectedStatementDigest?: string;
}

export interface ClassifiedVote {
  slug: string;
  disposition: VoteDisposition;
  reason: string;
  verdict?: Verdict;
  confidence?: number;
  /** True when disposition is valid and verdict is CREATOR_WINS or CHALLENGERS_WIN. */
  decisive: boolean;
  /** Arrival/delivery identity of this vote attempt, when supplied. */
  arrivalId?: string;
  /**
   * For `duplicated` votes, the arrival identity of the original accepted
   * vote for the same persona slug, when known.
   */
  originalArrivalId?: string;
  /**
   * For `duplicated` votes, true when the duplicate disagreed with the
   * original accepted vote's verdict or confidence.
   */
  conflict?: boolean;
}

export interface DuplicateVoteConflict {
  slug: string;
  originalArrivalId?: string;
  duplicateArrivalId?: string;
  originalVerdict?: Verdict;
  duplicateVerdict?: Verdict;
  originalConfidence?: number;
  duplicateConfidence?: number;
  reason: string;
}

export interface QuorumEvaluation {
  action: FallbackAction;
  quorum: number;
  /** Stable reference to the rule set (and effective quorum) that produced this decision. */
  policyRevision: string;
  decisiveCount: number;
  acceptedCount: number;
  dispositions: Record<VoteDisposition, number>;
  reason: string;
  acceptedSlugs: string[];
  /** Valid votes in ballot order (duplicates / rejects excluded). */
  ballot: ClassifiedVote[];
  /** Optional operator independence assessment of the decisive ballot. */
  independence?: QuorumIndependenceEvaluation;
}

const EMPTY_DISPOSITIONS = (): Record<VoteDisposition, number> => ({
  valid: 0,
  invalid: 0,
  stale: 0,
  duplicated: 0,
  cancelled: 0,
  paused: 0,
  dependency_failure: 0,
  deadline_abstention: 0,
});

/**
 * Classify a persona that produced no response before the deliberation deadline.
 * This is an explicit abstention, distinct from a substantive DRAW / UNRESOLVABLE
 * verdict and from a dependency failure.
 */
export function classifyDeadlineAbstention(slug: string): ClassifiedVote {
  return {
    slug: (slug ?? "").trim().toLowerCase(),
    disposition: "deadline_abstention",
    reason: "no vote before council deliberation deadline",
    decisive: false,
  };
}

/**
 * Compare quorum/confidence policy outcomes across identical fixtures without
 * contacting model providers. Each fixture is a list of raw vote attempts plus
 * a quorum config; the result reports the evaluation under a baseline policy and
 * a candidate policy, and flags any decisions that changed.
 */
export interface PolicyFixture {
  name: string;
  attempts: ClassifiedVote[];
  quorum: unknown;
  claimState?: ClaimSettleState;
}

export interface PolicyComparisonRow {
  name: string;
  baseline: FallbackAction;
  candidate: FallbackAction;
  changed: boolean;
  baselineReason: string;
  candidateReason: string;
}

export interface PolicyComparisonReport {
  rows: PolicyComparisonRow[];
  changedCount: number;
}

/**
 * Run two quorum policies over the same fixtures and report changed decisions.
 * Pure: no network, no provider calls, no persisted state.
 */
export function comparePolicies(
  fixtures: PolicyFixture[],
  baselineOpts: { quorum?: unknown; strictConfig?: boolean } = {},
  candidateOpts: { quorum?: unknown; strictConfig?: boolean } = {},
): PolicyComparisonReport {
  const rows: PolicyComparisonRow[] = fixtures.map((fx) => {
    const base = evaluateQuorum(fx.attempts, baselineOpts.quorum ?? fx.quorum, {
      claimState: fx.claimState,
      strictConfig: baselineOpts.strictConfig,
    });
    const cand = evaluateQuorum(fx.attempts, candidateOpts.quorum ?? fx.quorum, {
      claimState: fx.claimState,
      strictConfig: candidateOpts.strictConfig,
    });
    return {
      name: fx.name,
      baseline: base.action,
      candidate: cand.action,
      changed: base.action !== cand.action,
      baselineReason: base.reason,
      candidateReason: cand.reason,
    };
  });
  return { rows, changedCount: rows.filter((r) => r.changed).length };
}

const CONTROL_OR_SEP = /[\u0000-\u001f\u007f|,]/;

export function isDecisiveVerdict(verdict: Verdict): boolean {
  return verdict === "CREATOR_WINS" || verdict === "CHALLENGERS_WIN" || (verdict as string) === "CHALLENGERS_WINS";
}

/**
 * Normalize a raw quorum (env Number, caller override, …).
 *
 * Invalid values (NaN, non-finite, < 1) become the default so a typo cannot
 * silently disable the gate (`quorum: 0` would otherwise accept an empty jury).
 * Values above {@link MAX_COUNCIL_QUORUM} clamp rather than reject — demanding
 * more jurors than the roster has is a config smell, not a settle-time abort.
 */
export function normalizeQuorum(raw: unknown, fallback = DEFAULT_COUNCIL_QUORUM): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), MAX_COUNCIL_QUORUM);
}

/**
 * Tell whether a raw quorum value is clearly broken, so strict mode can abort
 * before settling.
 */
export function isInvalidQuorumConfig(raw: unknown): boolean {
  if (raw == null || raw === undefined || raw === "") return false;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  return !Number.isFinite(n) || n < 1;
}

/**
 * Classify a raw persona response into a disposition for the ballot.
 *
 * Precedence:
 *   1. Persona paused → paused (must not vote)
 *   2. Claim cancelled → cancelled (must not settle)
 *   3. Claim already resolved → stale (must not replay)
 *   4. Mismatched claimId → stale (cross-claim leakage)
 *   5. Mismatched statementDigest → stale (claim wording or source commitment changed)
 *   6. Response aged past maxAgeMs → stale (cached verdict too old)
 *   7. Transport failure (network / timeout / 5xx) → dependency_failure
 *   8. Missing slug or unknown verdict → invalid
 *   9. Otherwise → valid (decisive iff CREATOR_WINS | CHALLENGERS_WIN)
 */
export function classifyVoteAttempt(input: VoteAttemptInput): ClassifiedVote {
  const slug = (input.slug ?? "").trim().toLowerCase();
  const arrivalId =
    typeof input.arrivalId === "string" ? input.arrivalId.trim() || undefined : undefined;
  const arrivalMeta = arrivalId ? { arrivalId } : {};

  if (!slug) {
    return {
      slug: "",
      disposition: "invalid",
      reason: "missing or empty persona slug",
      decisive: false,
      ...arrivalMeta,
    };
  }

  if (input.personaPaused) {
    return {
      slug,
      disposition: "paused",
      reason: "persona is currently paused",
      decisive: false,
      ...arrivalMeta,
    };
  }

  if (input.claimState === "expired" || input.expired) {
    return {
      slug,
      disposition: "expired",
      reason: "ballot or vote submission has expired",
      decisive: false,
    };
  }

  if (
    input.ballotDeadlineMs != null &&
    input.submittedAtMs != null &&
    input.submittedAtMs > input.ballotDeadlineMs
  ) {
    return {
      slug,
      disposition: "expired",
      reason: `vote submitted at ${input.submittedAtMs}ms exceeds deadline ${input.ballotDeadlineMs}ms`,
      decisive: false,
    };
  }

  if (input.equivocated) {
    return {
      slug,
      disposition: "equivocation",
      reason: "conflicting vote attempt detected (equivocation)",
      decisive: false,
    };
  }

  if (input.claimState === "cancelled") {
    return {
      slug,
      disposition: "cancelled",
      reason: "claim is cancelled on-chain",
      decisive: false,
      ...arrivalMeta,
    };
  }

  if (input.claimState === "resolved") {
    return {
      slug,
      disposition: "stale",
      reason: "claim is already resolved",
      decisive: false,
      ...arrivalMeta,
    };
  }

  if (
    !Number.isInteger(input.expectedClaimId) ||
    input.expectedClaimId < 1 ||
    !Number.isInteger(input.claimId) ||
    input.claimId !== input.expectedClaimId
  ) {
    return {
      slug,
      disposition: "stale",
      reason: `vote claimId ${input.claimId} does not match settling claim ${input.expectedClaimId}`,
      decisive: false,
      ...arrivalMeta,
    };
  }

  if (
    input.expectedStatementDigest &&
    input.statementDigest &&
    input.statementDigest !== input.expectedStatementDigest
  ) {
    return {
      slug,
      disposition: "stale",
      reason: "claim statement digest mismatch (statement wording or source commitment changed)",
      decisive: false,
    };
  }

  if (
    input.maxAgeMs != null &&
    Number.isFinite(input.maxAgeMs) &&
    input.maxAgeMs >= 0 &&
    input.ageMs != null &&
    Number.isFinite(input.ageMs) &&
    input.ageMs > input.maxAgeMs
  ) {
    return {
      slug,
      disposition: "stale",
      reason: `vote age ${input.ageMs}ms exceeds maxAgeMs ${input.maxAgeMs}`,
      decisive: false,
      ...arrivalMeta,
    };
  }

  if (input.status === "network_error" || input.status === "timeout") {
    return {
      slug,
      disposition: "dependency_failure",
      reason: input.status === "timeout" ? "vote request timed out" : "vote request network failure",
      decisive: false,
      ...arrivalMeta,
    };
  }

  if (input.status === "http_error") {
    const code = input.httpStatus ?? 0;
    // 5xx / 502-style upstream failures are dependency problems; 4xx are invalid
    // requests or persona/policy refusals — not something retrying the roster fixes.
    if (code >= 500 || code === 0) {
      return {
        slug,
        disposition: "dependency_failure",
        reason: `vote endpoint HTTP ${code}`,
        decisive: false,
        ...arrivalMeta,
      };
    }
    if (code === 404) {
      return {
        slug,
        disposition: "stale",
        reason: "vote endpoint 404 — claim not found",
        decisive: false,
        ...arrivalMeta,
      };
    }
    return {
      slug,
      disposition: "invalid",
      reason: `vote endpoint rejected request (HTTP ${code})`,
      decisive: false,
      ...arrivalMeta,
    };
  }

  if (!isVerdict(input.verdict)) {
    return {
      slug,
      disposition: "invalid",
      reason: `verdict '${String(input.verdict)}' is not one of CREATOR_WINS | CHALLENGERS_WIN | DRAW | UNRESOLVABLE`,
      decisive: false,
      ...arrivalMeta,
    };
  }

  const confidenceRaw =
    typeof input.confidence === "number"
      ? input.confidence
      : typeof input.confidence === "string"
        ? Number(input.confidence)
        : 0;
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(100, Math.round(confidenceRaw)))
    : 0;

  return {
    slug,
    disposition: "valid",
    reason: "well-formed vote",
    verdict: input.verdict,
    confidence,
    decisive: isDecisiveVerdict(input.verdict),
    ...arrivalMeta,
  };
}

export interface BuildBallotOptions {
  /**
   * When true, detecting conflicting verdicts for the same persona treats
   * them as equivocation rather than benign duplicates.
   */
  rejectEquivocation?: boolean;
  /**
   * Strategy when a persona submits conflicting votes:
   * - "disqualify_all": remove prior vote from ballot and reject both attempts
   *   with disposition "equivocation" (conservative default when rejectEquivocation is true).
   * - "reject_subsequent": keep prior vote, reject subsequent conflicting vote as "equivocation".
   * - "drop_duplicate": legacy behavior (keep prior vote, mark subsequent as "duplicated").
   */
  equivocationPolicy?: "disqualify_all" | "reject_subsequent" | "drop_duplicate";
}

/**
 * Fold classified attempts into a ballot: first valid vote per slug wins;
 * later attempts for the same slug become `duplicated`. Non-valid attempts
 * pass through to `rejected` unchanged.
 */
export function buildBallot(attempts: readonly ClassifiedVote[]): {
  ballot: ClassifiedVote[];
  rejected: ClassifiedVote[];
  conflicts: DuplicateVoteConflict[];
} {
  const ballot: ClassifiedVote[] = [];
  const rejected: ClassifiedVote[] = [];
  const seenSlugs = new Set<string>();

  for (const attempt of attempts) {
    if (attempt.disposition !== "valid") {
      rejected.push(attempt);
      continue;
    }
    if (seenSlugs.has(attempt.slug)) {
      rejected.push({
        ...attempt,
        disposition: "duplicated",
        reason: `persona '${attempt.slug}' already submitted a vote on this ballot`,
        decisive: false,
      });
      continue;
    }
    seenSlugs.add(attempt.slug);
    ballot.push(attempt);
  }

  return { ballot, rejected, conflicts };
}

function countDispositions(votes: readonly ClassifiedVote[]): Record<VoteDisposition, number> {
  const counts = EMPTY_DISPOSITIONS();
  for (const v of votes) {
    counts[v.disposition] = (counts[v.disposition] ?? 0) + 1;
  }
  return counts;
}

export interface QuorumEvaluationOptions {
  /**
   * On-chain claim state. Checked before counting votes so a cancelled or
   * already-resolved claim aborts even if every attempt looks valid.
   */
  claimState?: ClaimSettleState;
  /**
   * Reject unparseable quorum config with `abort_invalid_config` instead of
   * falling back to the default.
   */
  strictConfig?: boolean;
}

/**
 * Pure policy gate: evaluates whether a set of vote attempts meets quorum.
 *
 * Every returned evaluation carries `policyRevision`, derived from the effective
 * quorum, so a recorded decision can be replayed deterministically under the
 * same revision.
 *
 * When a ballot commitment or voting-boundary binding is supplied in `opts`,
 * it is verified BEFORE outcome evaluation. Any ballot altered after the
 * approved voting boundary (or mismatching participant identities, claim
 * revision, or eligible vote set) is rejected with `abort_invalid_commitment`.
 *
 * @param strictConfig — when set and {@link isInvalidQuorumConfig} is true,
 *   returns `abort_invalid_config` instead of normalizing.
 */
export function evaluateQuorum(
  attempts: readonly ClassifiedVote[],
  quorumRaw: unknown = DEFAULT_COUNCIL_QUORUM,
  opts?: QuorumEvaluationOptions,
): QuorumEvaluation {
  const claimState = opts?.claimState;
  const quorum = normalizeQuorum(quorumRaw);
  const policyRevision = policyRevisionFor(quorum);

  if (claimState === "cancelled") {
    return {
      action: "abort_cancelled",
      quorum,
      policyRevision,
      decisiveCount: 0,
      acceptedCount: 0,
      dispositions: countDispositions(attempts),
      reason: "claim is cancelled on-chain — council settlement aborted",
      acceptedSlugs: [],
      ballot: [],
      conflicts: [],
    };
  }

  if (opts?.claimState === "resolved") {
    return {
      action: "abort_resolved",
      quorum,
      policyRevision,
      decisiveCount: 0,
      acceptedCount: 0,
      dispositions: countDispositions(attempts),
      reason: "claim is already resolved — council settlement aborted",
      acceptedSlugs: [],
      ballot: [],
      conflicts: [],
    };
  }

  if (opts?.claimState === "paused") {
    return {
      action: "abort_paused",
      quorum,
      policyRevision,
      decisiveCount: 0,
      acceptedCount: 0,
      dispositions: countDispositions(attempts),
      reason: "claim is paused — council settlement aborted",
      acceptedSlugs: [],
      ballot: [],
      conflicts: [],
    };
  }

  const isExpired =
    claimState === "expired" ||
    opts?.ballotExpired === true ||
    (opts?.maxBallotAgeMs != null &&
      opts?.ballotAgeMs != null &&
      opts.ballotAgeMs > opts.maxBallotAgeMs) ||
    (opts?.ballotDeadlineMs != null &&
      (opts.nowMs ?? Date.now()) > opts.ballotDeadlineMs);

  if (isExpired) {
    return {
      action: "abort_expired",
      quorum: normalizeQuorum(quorumRaw),
      decisiveCount: 0,
      acceptedCount: 0,
      dispositions: countDispositions(attempts),
      reason: "ballot expired — council settlement aborted",
      acceptedSlugs: [],
      ballot: [],
    };
  }

  if (opts?.strictConfig && isInvalidQuorumConfig(quorumRaw)) {
    return {
      action: "abort_invalid_config",
      quorum: 0,
      policyRevision: policyRevisionFor(0),
      decisiveCount: 0,
      acceptedCount: 0,
      dispositions: countDispositions(attempts),
      reason: `invalid COUNCIL_QUORUM value: ${String(quorumRaw)}`,
      acceptedSlugs: [],
      ballot: [],
      conflicts: [],
    };
  }

  const quorum = normalizeQuorum(quorumRaw);
  const { ballot, rejected, conflicts } = buildBallot(attempts);
  const all = [...ballot, ...rejected];
  const dispositions = countDispositions(all);
  const decisive = ballot.filter((v) => v.decisive);
  const decisiveCount = decisive.length;
  const acceptedSlugs = ballot.map((v) => v.slug);
  const commitmentProps =
    verifiedCommitment !== undefined
      ? { commitment: verifiedCommitment, commitmentValid: true }
      : {};

  if (decisiveCount >= quorum) {
    return {
      action: "use_council",
      quorum,
      policyRevision,
      decisiveCount,
      acceptedCount: ballot.length,
      dispositions,
      reason: `quorum met: ${decisiveCount}/${quorum} decisive votes`,
      acceptedSlugs,
      ballot,
      conflicts,
    };
  }

  const dep = dispositions.dependency_failure;
  const paused = dispositions.paused;
  const reasonParts = [
    `below quorum: ${decisiveCount}/${quorum} decisive votes — solo fallback`,
    dispositions.invalid ? `${dispositions.invalid} invalid` : null,
    dispositions.stale ? `${dispositions.stale} stale` : null,
    dispositions.duplicated ? `${dispositions.duplicated} duplicated` : null,
    dispositions.cancelled ? `${dispositions.cancelled} cancelled` : null,
    paused ? `${paused} paused` : null,
    dep ? `${dep} dependency_failure` : null,
  ].filter(Boolean);

  const dep = dispositions.dependency_failure;
  const paused = dispositions.paused;
  const equiv = dispositions.equivocation;
  const expired = dispositions.expired;
  const reasonParts = [
    `below quorum: ${decisiveCount} decisive < ${quorum}`,
    dispositions.invalid ? `${dispositions.invalid} invalid` : null,
    dispositions.stale ? `${dispositions.stale} stale` : null,
    dispositions.duplicated ? `${dispositions.duplicated} duplicated` : null,
    dispositions.cancelled ? `${dispositions.cancelled} cancelled` : null,
    paused ? `${paused} paused` : null,
    dep ? `${dep} dependency_failure` : null,
    equiv ? `${equiv} equivocation` : null,
    expired ? `${expired} expired` : null,
  ].filter(Boolean);

  const dep = dispositions.dependency_failure;
  const paused = dispositions.paused;
  const reasonParts = [
    `below quorum: ${decisiveCount} decisive < ${quorum}`,
    dispositions.invalid ? `${dispositions.invalid} invalid` : null,
    dispositions.stale ? `${dispositions.stale} stale` : null,
    dispositions.duplicated ? `${dispositions.duplicated} duplicated` : null,
    dispositions.cancelled ? `${dispositions.cancelled} cancelled` : null,
    paused ? `${paused} paused` : null,
    dep ? `${dep} dependency_failure` : null,
  ].filter(Boolean);

  const dep = dispositions.dependency_failure;
  const paused = dispositions.paused;
  const reasonParts = [
    `below quorum: ${decisiveCount} decisive < ${quorum}`,
    dispositions.invalid ? `${dispositions.invalid} invalid` : null,
    dispositions.stale ? `${dispositions.stale} stale` : null,
    dispositions.duplicated ? `${dispositions.duplicated} duplicated` : null,
    dispositions.cancelled ? `${dispositions.cancelled} cancelled` : null,
    paused ? `${paused} paused` : null,
    dep ? `${dep} dependency_failure` : null,
  ].filter(Boolean);

  return {
    action: "fallback_solo",
    quorum,
    policyRevision,
    decisiveCount,
    acceptedCount: ballot.length,
    dispositions,
    reason: reasonParts.join("; "),
    acceptedSlugs,
    ballot,
    ...(independence ? { independence } : {}),
  };
}
