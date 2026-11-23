import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { isSportsEventFinal, sportsGraceSecs } from "../../agents/oracle/sports-finality";
import {
  ORACLE_POLICY_COMPARISON_SCHEMA_VERSION,
  compareOraclePolicies,
} from "../../lib/oracle/policy-comparison";

const REPO_ROOT = process.cwd();
const FIXTURE_PATH = path.join(REPO_ROOT, "tests/fixtures/oracle-policy-compare/valid.json");
const NPM_BIN = process.platform === "win32" ? "npm.cmd" : "npm";

function readFixture(): unknown {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as unknown;
}

function credentialFreeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/SECRET|API_KEY|DATABASE_URL|CREDENTIAL/i.test(key)) delete env[key];
  }
  return env;
}

function runCompare(args: string[]) {
  return spawnSync(
    NPM_BIN,
    ["run", "--silent", "oracle:compare", "--", ...args],
    { cwd: REPO_ROOT, encoding: "utf8", env: credentialFreeEnv() },
  );
}

test("replays identical captured evidence under two policies with deterministic differences", () => {
  const fixture = readFixture();
  const pristine = structuredClone(fixture);
  const report = compareOraclePolicies(fixture);

  assert.deepEqual(fixture, pristine);
  assert.equal(report.schemaVersion, ORACLE_POLICY_COMPARISON_SCHEMA_VERSION);
  assert.equal(report.dryRun, true);
  assert.equal(report.signingPerformed, false);
  assert.equal(report.externalCalls, 0);
  assert.equal(report.changedCount, 3);
  assert.deepEqual(report.rows.map((row) => row.name), [
    "sports-live-at-grace-boundary",
    "sports-live-after-candidate-grace",
    "crypto-high-confidence-threshold",
    "crypto-non-api-trust-cap",
    "invalid-confidence-refund",
  ]);
  assert.deepEqual(report.rows.map((row) => row.changed), [false, true, true, true, false]);
  assert.deepEqual(report.rows.map((row) => row.baseline.policy), Array(5).fill("current"));
  assert.deepEqual(report.rows.map((row) => row.candidate.policy), Array(5).fill("stricter"));
  assert.equal(new Set(report.rows.map((row) => row.evidenceDigest)).size, report.rows.length);

  assert.equal(report.rows[1].baseline.action, "defer");
  assert.equal(report.rows[1].candidate.action, "settle");
  assert.deepEqual(report.rows[1].changedFields, ["action", "outcome", "reason", "verdict", "confidence", "explanation"]);

  assert.equal(report.rows[2].baseline.outcome, "firm");
  assert.equal(report.rows[2].candidate.outcome, "contested");
  assert.equal(report.rows[3].baseline.action, "settle");
  assert.equal(report.rows[3].candidate.action, "refund");
  assert.equal(report.rows[3].candidate.reason, "low-confidence");
  assert.equal(report.rows[4].baseline.reason, "invalid-confidence");
  assert.equal(report.rows[4].candidate.reason, "invalid-confidence");

  assert.deepEqual(compareOraclePolicies(fixture), report);
});

test("sports grace boundary is strict and policy-specific", () => {
  const deadline = 1_800_000_000;
  const live = "Live: match still in progress.";

  assert.equal(sportsGraceSecs(1), 3600);
  assert.equal(isSportsEventFinal({ deadline }, live, deadline + 3600, 3600), false);
  assert.equal(isSportsEventFinal({ deadline }, live, deadline + 3601, 3600), true);

  const report = compareOraclePolicies(readFixture());
  const boundary = report.rows[0];
  assert.equal(boundary.baseline.action, "defer");
  assert.equal(boundary.candidate.action, "defer");
  assert.equal(report.rows[1].candidate.action, "settle");
});

test("comparison never uses a network transport", () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("unexpected external call");
  }) as typeof fetch;
  try {
    const report = compareOraclePolicies(readFixture());
    assert.equal(report.externalCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CLI emits byte-identical JSON and writes only to the requested temp directory", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mimir-oracle-policy-compare-"));
  try {
    const out = path.join(dir, "nested", "report.json");
    const args = ["--fixture", FIXTURE_PATH, "--json", "--out", out];
    const first = runCompare(args);
    const second = runCompare(args);

    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.equal(first.stdout, second.stdout);

    const expected = compareOraclePolicies(readFixture());
    assert.deepEqual(JSON.parse(first.stdout), expected);
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI refuses signing and fails closed on malformed input without writing output", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mimir-oracle-policy-compare-fail-"));
  try {
    const out = path.join(dir, "report.json");
    const submit = runCompare(["--fixture", FIXTURE_PATH, "--submit", "--out", out]);
    assert.equal(submit.status, 2);
    assert.match(submit.stderr, /DRY_RUN_ONLY/);
    assert.equal(existsSync(out), false);

    const malformed = path.join(dir, "malformed.json");
    writeFileSync(malformed, "{not json", "utf8");
    const badJson = runCompare(["--fixture", malformed, "--json", "--out", out]);
    assert.equal(badJson.status, 2);
    assert.equal(JSON.parse(badJson.stdout).error.code, "INVALID_FIXTURE");
    assert.equal(existsSync(out), false);

    const invalidPolicy = structuredClone(readFixture()) as {
      candidate: { highMin: number; mediumMin: number };
    };
    invalidPolicy.candidate.highMin = invalidPolicy.candidate.mediumMin;
    const invalidPath = path.join(dir, "invalid-policy.json");
    writeFileSync(invalidPath, JSON.stringify(invalidPolicy), "utf8");
    const badPolicy = runCompare(["--fixture", invalidPath, "--json", "--out", out]);
    assert.equal(badPolicy.status, 2);
    assert.equal(JSON.parse(badPolicy.stdout).error.code, "INVALID_POLICY");
    assert.equal(existsSync(out), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
