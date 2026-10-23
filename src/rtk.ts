import type { ExecOptions, ExecResult } from "@oh-my-pi/pi-coding-agent"

const REWRITE_TIMEOUT_MS = 2_000
const FORBIDDEN_GAIN_ARGS: Record<string, true> = {
  "--reset": true,
  "--yes": true,
  "-y": true,
  "--format": true,
  "-f": true,
}
const ENV_ASSIGNMENT_PREFIX =
  /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:[^\s"']+|"[^"]*"|'[^']*')\s+)+/

export function parseSemver(raw: string): [number, number, number] | null {
  const m = raw.trim().match(/(\d+)\.(\d+)\.(\d+)/)
  if (!m) return null
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)]
}

export function isSupportedVersion(parsed: [number, number, number] | null): boolean {
  if (parsed === null) return false
  const [major, minor] = parsed
  if (major >= 1) return true
  return minor >= 25
}

export async function rewriteCommand(
  exec: (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>,
  cmd: string
): Promise<string | null> {
  try {
    const result = await exec("rtk", ["rewrite", cmd], { timeout: REWRITE_TIMEOUT_MS })
    if (result.killed) return null
    if (result.code !== 0 && result.code !== 3) return null
    return result.stdout.trim() || null
  } catch {
    return null
  }
}

export type GainSummary = {
  total_saved: number
  total_input: number
}

export function parseGain(stdout: string): GainSummary | null {
  try {
    const data: unknown = JSON.parse(stdout)
    if (typeof data !== "object" || data === null) return null
    if (!("summary" in data)) return null
    const summary: unknown = data.summary
    if (typeof summary !== "object" || summary === null) return null
    if (!("total_saved" in summary) || !("total_input" in summary)) return null
    const total_saved: unknown = summary.total_saved
    const total_input: unknown = summary.total_input
    if (typeof total_saved !== "number" || typeof total_input !== "number") return null
    return { total_saved, total_input }
  } catch {
    return null
  }
}

export function sanitizeGainArgs(
  args: string[]
): { ok: true; args: string[] } | { ok: false; rejected: string[] } {
  const rejected = args.filter((arg) => {
    if (FORBIDDEN_GAIN_ARGS[arg] === true) return true
    // The plugin always appends its own `--format json`; any user-supplied
    // format flag (attached or separate value) would make clap reject the call.
    if (arg.startsWith("--format=")) return true
    if (arg.startsWith("-f") && arg.length > 2) return true
    return false
  })
  if (rejected.length > 0) return { ok: false, rejected }
  return { ok: true, args }
}

export function shouldSkipCommand(
  cmd: string,
  enabled: boolean,
  rtkDisabled: string | undefined
): boolean {
  if (!enabled) return true
  if (rtkDisabled === "1") return true
  if (cmd.trim() === "") return true
  const stripped = cmd.trim().replace(ENV_ASSIGNMENT_PREFIX, "")
  return stripped.startsWith("rtk ")
}

export function parseSubcommand(input: string): {
  sub: "toggle" | "status" | "gain" | "doctor" | "discover" | "help"
  rest: string[]
} {
  const tokens = input.trim().split(/\s+/).filter((t) => t !== "")
  if (tokens.length === 0) return { sub: "toggle", rest: [] }
  const [first, ...rest] = tokens
  switch (first) {
    case "toggle":
    case "status":
    case "gain":
    case "doctor":
    case "discover":
      return { sub: first, rest }
    default:
      return { sub: "help", rest }
  }
}
