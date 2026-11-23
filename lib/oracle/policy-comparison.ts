import type { VerdictPayload } from "../verdict"
import { isVerdict } from "../verdict"
import type { EvidenceFetcherKind } from "../server/evidence-fetcher"
import {
  CONFIDENCE_HIGH_MIN,
  CONFIDENCE_MED_MIN,
  MAX_CONFIDENCE_NON_API,
  applyFetcherTrustWithCap,
  tierVerdictWithThresholds,
} from "./confidence-tiers"
import { applySettlementPolicy } from "./unresolvable-policy"
import { classifyEvidenceFinality, digestEvidence, isSportsEventFinal, sportsGraceSecs } from "../../agents/oracle/sports-finality"

export const ORACLE_POLICY_COMPARISON_SCHEMA_VERSION = 1
export const MAX_CAPTURED_EVIDENCE_CHARS = 65_536

export type PolicyComparisonErrorCode =
  | "INVALID_FIXTURE"
  | "UNSUPPORTED_FIXTURE_VERSION"
  | "INVALID_POLICY"
  | "DUPLICATE_POLICY_NAME"
  | "INVALID_CASE"

export class PolicyComparisonError extends Error {
  readonly code: PolicyComparisonErrorCode

  constructor(code: PolicyComparisonErrorCode, message: string) {
    super(message)
    this.name = "PolicyComparisonError"
    this.code = code
  }
}

export interface OraclePolicyConfig {
  name: string
  highMin?: number
  mediumMin?: number
  nonApiCap?: number
  sportsGraceHours?: number
}

export interface ResolvedOraclePolicy {
  name: string
  highMin: number
  mediumMin: number
  nonApiCap: number
  sportsGraceHours: number
  sportsGraceSecs: number
}

export interface CapturedEvidence {
  text: string
  fetcher: EvidenceFetcherKind | "none"
  sourceUrl?: string
  capturedAt?: number
}

export interface CapturedOracleCase {
  name: string
  claim: {
    id: number
    category: string
    deadline: number
  }
  evidence: CapturedEvidence
  verdict: VerdictPayload
  now: number
}

export interface OraclePolicyComparisonFixtureInput {
  schemaVersion: number
  cases: CapturedOracleCase[]
  baseline?: OraclePolicyConfig
  candidate?: OraclePolicyConfig
}

export interface OraclePolicyComparisonFixture {
  schemaVersion: number
  cases: CapturedOracleCase[]
  baseline: ResolvedOraclePolicy
  candidate: ResolvedOraclePolicy
}

export type ComparedAction = "settle" | "defer" | "refund" | "draw"

export interface PolicyDecision {
  policy: string
  action: ComparedAction
  outcome: string
  reason: string
  verdict: VerdictPayload["verdict"] | null
  confidence: number | null
  explanation: string | null
  finality: "final" | "not_final" | "unknown"
}

export interface PolicyComparisonRow {
  name: string
  claimId: number
  evidenceDigest: string
  baseline: PolicyDecision
  candidate: PolicyDecision
  changed: boolean
  changedFields: string[]
}

export interface OraclePolicyComparisonReport {
  schemaVersion: number
  dryRun: true
  signingPerformed: false
  externalCalls: 0
  baseline: ResolvedOraclePolicy
  candidate: ResolvedOraclePolicy
  rows: PolicyComparisonRow[]
  changedCount: number
}

const FETCHERS: readonly (EvidenceFetcherKind | "none")[] = [
  "coingecko-api",
  "direct",
  "jina",
  "bot-paid",
  "none",
]

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PolicyComparisonError("INVALID_FIXTURE", `${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function optionalNumber(value: unknown, label: string, code: PolicyComparisonErrorCode): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PolicyComparisonError(code, `${label} must be a finite number`)
  }
  return value
}

function requiredNumber(value: unknown, label: string, code: PolicyComparisonErrorCode): number {
  const parsed = optionalNumber(value, label, code)
  if (parsed === undefined) throw new PolicyComparisonError(code, `${label} is required`)
  return parsed
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string") {
    throw new PolicyComparisonError("INVALID_FIXTURE", `${label} must be a string`)
  }
  return value
}

function parsePolicy(value: unknown, fallbackName: string): ResolvedOraclePolicy {
  const raw = value === undefined ? {} : record(value, fallbackName)
  const name = optionalString(raw["name"], `${fallbackName}.name`)?.trim() || fallbackName
  const highMin = optionalNumber(raw["highMin"], `${name}.highMin`, "INVALID_POLICY") ?? CONFIDENCE_HIGH_MIN
  const mediumMin = optionalNumber(raw["mediumMin"], `${name}.mediumMin`, "INVALID_POLICY") ?? CONFIDENCE_MED_MIN
  const nonApiCap = optionalNumber(raw["nonApiCap"], `${name}.nonApiCap`, "INVALID_POLICY") ?? MAX_CONFIDENCE_NON_API
  const graceHours = optionalNumber(raw["sportsGraceHours"], `${name}.sportsGraceHours`, "INVALID_POLICY") ?? 12

  if (highMin <= mediumMin || highMin < 0 || highMin > 100 || mediumMin < 0 || mediumMin > 100) {
    throw new PolicyComparisonError(
      "INVALID_POLICY",
      `${name}: require 0 <= mediumMin < highMin <= 100`,
    )
  }
  if (nonApiCap < 0 || nonApiCap > 100) {
    throw new PolicyComparisonError("INVALID_POLICY", `${name}: nonApiCap must be between 0 and 100`)
  }
  if (graceHours <= 0) {
    throw new PolicyComparisonError("INVALID_POLICY", `${name}: sportsGraceHours must be positive`)
  }

  return {
    name,
    highMin,
    mediumMin,
    nonApiCap,
    sportsGraceHours: graceHours,
    sportsGraceSecs: sportsGraceSecs(graceHours),
  }
}

function parseCase(value: unknown, index: number): CapturedOracleCase {
  const label = `cases[${index}]`
  const raw = record(value, label)
  const name = optionalString(raw["name"], `${label}.name`)?.trim() || `case-${index + 1}`

  const rawClaim = record(raw["claim"], `${label}.claim`)
  const id = requiredNumber(rawClaim["id"], `${label}.claim.id`, "INVALID_CASE")
  const deadline = requiredNumber(rawClaim["deadline"], `${label}.claim.deadline`, "INVALID_CASE")
  const category = optionalString(rawClaim["category"], `${label}.claim.category`)?.trim() || "custom"
  if (!Number.isInteger(id) || id < 0) {
    throw new PolicyComparisonError("INVALID_CASE", `${label}.claim.id must be a non-negative integer`)
  }

  const rawEvidence = record(raw["evidence"], `${label}.evidence`)
  const text = optionalString(rawEvidence["text"], `${label}.evidence.text`) ?? ""
  if (text.length > MAX_CAPTURED_EVIDENCE_CHARS) {
    throw new PolicyComparisonError("INVALID_CASE", `${label}.evidence.text exceeds ${MAX_CAPTURED_EVIDENCE_CHARS} chars`)
  }
  const fetcher = rawEvidence["fetcher"] as EvidenceFetcherKind | "none" | undefined
  if (fetcher === undefined || !FETCHERS.includes(fetcher)) {
    throw new PolicyComparisonError("INVALID_CASE", `${label}.evidence.fetcher is not supported`)
  }
  const sourceUrl = optionalString(rawEvidence["sourceUrl"], `${label}.evidence.sourceUrl`)
  const capturedAt = optionalNumber(rawEvidence["capturedAt"], `${label}.evidence.capturedAt`, "INVALID_CASE")

  const rawVerdict = record(raw["verdict"], `${label}.verdict`)
  if (!isVerdict(rawVerdict["verdict"])) {
    throw new PolicyComparisonError("INVALID_CASE", `${label}.verdict.verdict is not supported`)
  }
  const confidence = requiredNumber(rawVerdict["confidence"], `${label}.verdict.confidence`, "INVALID_CASE")
  const explanation = optionalString(rawVerdict["explanation"], `${label}.verdict.explanation`) ?? ""
  const now = requiredNumber(raw["now"], `${label}.now`, "INVALID_CASE")

  const evidence: CapturedEvidence = { text, fetcher }
  if (sourceUrl !== undefined) evidence.sourceUrl = sourceUrl
  if (capturedAt !== undefined) evidence.capturedAt = capturedAt

  return {
    name,
    claim: { id, category, deadline },
    evidence,
    verdict: { verdict: rawVerdict["verdict"], confidence, explanation },
    now,
  }
}

export function parseOraclePolicyComparisonFixture(value: unknown): OraclePolicyComparisonFixture {
  const raw = record(value, "fixture")
  if (raw["schemaVersion"] !== ORACLE_POLICY_COMPARISON_SCHEMA_VERSION) {
    throw new PolicyComparisonError(
      "UNSUPPORTED_FIXTURE_VERSION",
      `expected schemaVersion ${ORACLE_POLICY_COMPARISON_SCHEMA_VERSION}`,
    )
  }
  if (!Array.isArray(raw["cases"]) || raw["cases"].length === 0) {
    throw new PolicyComparisonError("INVALID_FIXTURE", "cases must be a non-empty array")
  }

  const baseline = parsePolicy(raw["baseline"], "baseline")
  const candidate = parsePolicy(raw["candidate"], "candidate")
  if (baseline.name === candidate.name) {
    throw new PolicyComparisonError("DUPLICATE_POLICY_NAME", "baseline and candidate must have distinct names")
  }

  return {
    schemaVersion: ORACLE_POLICY_COMPARISON_SCHEMA_VERSION,
    cases: raw["cases"].map(parseCase),
    baseline,
    candidate,
  }
}

export function capturedEvidenceDigest(captured: CapturedOracleCase): string {
  return digestEvidence({
    claim: captured.claim,
    evidence: captured.evidence,
    verdict: captured.verdict,
    now: captured.now,
  })
}

function decideCase(captured: CapturedOracleCase, policy: ResolvedOraclePolicy): PolicyDecision {
  const isSports = captured.claim.category.toLowerCase() === "sports"
  const finality = isSports
    ? classifyEvidenceFinality(captured.evidence.text)
    : "final"
  const final = isSports
    ? isSportsEventFinal(captured.claim, captured.evidence.text, captured.now, policy.sportsGraceSecs)
    : true

  if (!final) {
    return {
      policy: policy.name,
      action: "defer",
      outcome: "deferred",
      reason: "finality-delayed",
      verdict: null,
      confidence: null,
      explanation: null,
      finality,
    }
  }

  const trusted = applyFetcherTrustWithCap(captured.verdict, captured.evidence.fetcher, policy.nonApiCap)
  const decision = applySettlementPolicy(trusted, (verdict) =>
    tierVerdictWithThresholds(verdict, { highMin: policy.highMin, mediumMin: policy.mediumMin }),
  )

  if (decision.outcome === "refund") {
    return {
      policy: policy.name,
      action: "refund",
      outcome: "refund",
      reason: decision.reason,
      verdict: decision.verdict.verdict,
      confidence: decision.verdict.confidence,
      explanation: decision.verdict.explanation,
      finality,
    }
  }

  return {
    policy: policy.name,
    action: decision.outcome === "draw" ? "draw" : "settle",
    outcome: decision.outcome,
    reason: decision.outcome,
    verdict: decision.verdict.verdict,
    confidence: decision.verdict.confidence,
    explanation: decision.verdict.explanation,
    finality,
  }
}

const COMPARED_FIELDS = ["action", "outcome", "reason", "verdict", "confidence", "explanation", "finality"] as const

function diffDecisions(baseline: PolicyDecision, candidate: PolicyDecision): string[] {
  return COMPARED_FIELDS.filter((field) => baseline[field] !== candidate[field])
}

export function compareOraclePolicies(value: unknown): OraclePolicyComparisonReport {
  const fixture = parseOraclePolicyComparisonFixture(value)
  const rows = fixture.cases.map((captured) => {
    const baseline = decideCase(captured, fixture.baseline)
    const candidate = decideCase(captured, fixture.candidate)
    const changedFields = diffDecisions(baseline, candidate)
    return {
      name: captured.name,
      claimId: captured.claim.id,
      evidenceDigest: capturedEvidenceDigest(captured),
      baseline,
      candidate,
      changed: changedFields.length > 0,
      changedFields,
    }
  })

  return {
    schemaVersion: ORACLE_POLICY_COMPARISON_SCHEMA_VERSION,
    dryRun: true,
    signingPerformed: false,
    externalCalls: 0,
    baseline: fixture.baseline,
    candidate: fixture.candidate,
    rows,
    changedCount: rows.filter((row) => row.changed).length,
  }
}

export function formatPolicyComparisonReport(report: OraclePolicyComparisonReport): string {
  const lines = [
    `Oracle policy comparison: ${report.baseline.name} → ${report.candidate.name}`,
    `${report.changedCount}/${report.rows.length} captured cases changed (dry run; no signing, no external calls)`,
  ]
  for (const row of report.rows) {
    lines.push("")
    lines.push(`${row.changed ? "CHANGED" : "SAME   "} ${row.name} (claim ${row.claimId}) ${row.evidenceDigest.slice(0, 12)}`)
    lines.push(`  baseline : ${row.baseline.action}/${row.baseline.outcome}${row.baseline.verdict ? ` ${row.baseline.verdict}` : ""}`)
    lines.push(`  candidate: ${row.candidate.action}/${row.candidate.outcome}${row.candidate.verdict ? ` ${row.candidate.verdict}` : ""}`)
    if (row.changed) lines.push(`  fields   : ${row.changedFields.join(", ")}`)
  }
  return lines.join("\n")
}
