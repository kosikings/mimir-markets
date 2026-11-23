import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"

import {
  PolicyComparisonError,
  compareOraclePolicies,
  formatPolicyComparisonReport,
} from "../lib/oracle/policy-comparison"

const USAGE = `Usage: npm run oracle:compare -- --fixture <path> [--json] [--out <path>]

Replays one synthetic captured-evidence fixture under two oracle policies.
Read-only and credential-free: no signer, RPC, LLM, or paid evidence call.`

function stringOption(value: string | boolean | (string | boolean)[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined
}

function fail(code: string, message: string, json: boolean): never {
  const text = json
    ? JSON.stringify({ ok: false, error: { code, message } })
    : `${code}: ${message}`
  ;(json ? process.stdout : process.stderr).write(`${text}\n`)
  process.exit(2)
}

function main(): void {
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      options: {
        fixture: { type: "string", short: "f" },
        out: { type: "string", short: "o" },
        json: { type: "boolean", short: "j", default: false },
        submit: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    })
  } catch (error) {
    fail("INVALID_ARGUMENTS", error instanceof Error ? error.message : String(error), process.argv.includes("--json"))
  }

  const json = parsed.values.json === true
  if (parsed.values.help) {
    process.stdout.write(`${USAGE}\n`)
    return
  }
  if (parsed.values.submit) {
    fail("DRY_RUN_ONLY", "--submit is refused; this command never signs or submits", json)
  }
  const fixturePath = stringOption(parsed.values.fixture)
  if (!fixturePath) {
    fail("INVALID_FIXTURE", "--fixture <path> is required", json)
  }

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path.resolve(process.cwd(), fixturePath), "utf8")) as unknown
  } catch (error) {
    fail("INVALID_FIXTURE", error instanceof Error ? error.message : String(error), json)
  }

  let report: ReturnType<typeof compareOraclePolicies>
  try {
    report = compareOraclePolicies(raw)
  } catch (error) {
    const code = error instanceof PolicyComparisonError ? error.code : "INVALID_FIXTURE"
    fail(code, error instanceof Error ? error.message : String(error), json)
  }

  const payload = JSON.stringify(report, null, 2)
  const outPath = stringOption(parsed.values.out)
  if (outPath) {
    const target = path.resolve(process.cwd(), outPath)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, `${payload}\n`, "utf8")
  }
  process.stdout.write(`${json ? payload : formatPolicyComparisonReport(report)}\n`)
}

main()
