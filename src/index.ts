import type {
  ExecOptions,
  ExecResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionStartEvent,
  ToolCallEvent,
} from "@oh-my-pi/pi-coding-agent"
import {
  isSupportedVersion,
  parseGain,
  parseSemver,
  parseSubcommand,
  rewriteCommand,
  sanitizeGainArgs,
  shouldSkipCommand,
  type GainSummary,
} from "./rtk"
import { loadState, resolveStatePath, saveState } from "./state"
import { composeStatus, computeSessionSaved, formatShort } from "./status"

const PROBE_TIMEOUT_MS = 2_000
const GAIN_TIMEOUT_MS = 2_000
const DISCOVER_TIMEOUT_MS = 10_000
const UNMATCHED_MAX = 100

type Availability = { ok: boolean; reason: string; version: string | null }
type ReportData = { title: string; lines: string[] }

function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined
  const code = "code" in err ? err.code : undefined
  return typeof code === "string" ? code : undefined
}

async function probeRtk(pi: ExtensionAPI): Promise<Availability> {
  try {
    const result = await pi.exec("rtk", ["--version"], { timeout: PROBE_TIMEOUT_MS })
    if (result.code !== 0) {
      return { ok: false, version: null, reason: `rtk --version failed (exit ${result.code})` }
    }
    const parsed = parseSemver(result.stdout)
    if (parsed === null) {
      return { ok: false, version: null, reason: "unrecognized rtk version output" }
    }
    if (!isSupportedVersion(parsed)) {
      return { ok: false, version: parsed.join("."), reason: `rtk ${parsed.join(".")} is too old (need >= 0.25.0)` }
    }
    return { ok: true, version: parsed.join("."), reason: "" }
  } catch (err) {
    const code = errorCode(err)
    if (code === "ENOENT") {
      return {
        ok: false,
        version: null,
        reason: "rtk binary not found in PATH (install: https://github.com/rtk-ai/rtk#installation)",
      }
    }
    if (code === "EACCES") {
      return { ok: false, version: null, reason: "rtk binary is not executable (fix: chmod +x $(command -v rtk))" }
    }
    return { ok: false, version: null, reason: "rtk unavailable" }
  }
}

async function fetchGain(pi: ExtensionAPI): Promise<GainSummary | null> {
  try {
    const result = await pi.exec("rtk", ["gain", "--format", "json"], { timeout: GAIN_TIMEOUT_MS })
    if (result.code !== 0) return null
    return parseGain(result.stdout)
  } catch {
    return null
  }
}

async function tryExec(
  pi: ExtensionAPI,
  args: string[],
  timeout: number
): Promise<{ ok: true; result: ExecResult } | { ok: false; error: unknown }> {
  try {
    const result = await pi.exec("rtk", args, { timeout })
    return { ok: true, result }
  } catch (err) {
    return { ok: false, error: err }
  }
}

async function plainGainText(pi: ExtensionAPI, args: string[]): Promise<string[]> {
  try {
    const result = await pi.exec("rtk", ["gain", ...args], { timeout: GAIN_TIMEOUT_MS })
    if (result.code !== 0) return [`rtk gain failed (exit ${result.code})`]
    const text = result.stdout.trim()
    return text === "" ? ["rtk gain returned no output"] : text.split("\n")
  } catch (err) {
    return [`rtk gain failed: ${err instanceof Error ? err.message : String(err)}`]
  }
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  try {
    ctx.ui.notify(message, level)
  } catch {
    // Headless modes may have no UI surface; reports never reach the model.
  }
}

function emitReport(pi: ExtensionAPI, ctx: ExtensionCommandContext, title: string, lines: string[]): void {
  try {
    pi.appendEntry("rtk-report", { title, lines })
  } catch {
    // Persistence is secondary; the notify below still carries the full text.
  }
  notify(ctx, `${title}\n${lines.join("\n")}`)
}

export default async function (pi: ExtensionAPI): Promise<void> {
  const statePath = resolveStatePath()
  const loaded = await loadState(statePath)

  let enabled = loaded.enabled
  let corruptedState = loaded.corrupted
  let availability: Availability | null = null
  let baseline: GainSummary | null = null
  let sessionSaved: number | null = null
  const unmatched = new Map<string, number>()
  let warnedUnavailable = false
  let pendingSessionCtx: ExtensionContext | undefined

  function refreshStatus(ctx: ExtensionContext): void {
    if (availability === null) return
    try {
      ctx.ui.setStatus(
        "rtk",
        composeStatus({
          available: availability.ok,
          enabled,
          sessionSaved,
          reason: availability.reason,
        })
      )
    } catch {
      // Status reporting must never affect fail-open behavior.
    }
  }

  function warnUnavailableOnce(ctx: ExtensionContext): void {
    if (warnedUnavailable || availability === null || availability.ok) return
    warnedUnavailable = true
    notify(ctx, `rtk unavailable: ${availability.reason}`, "warning")
  }

  // Records rewrite misses (exit 1/2) in the bounded session map; wraps pi.exec only.
  const trackedExec = async (command: string, args: string[], options?: ExecOptions): Promise<ExecResult> => {
    const result = await pi.exec(command, args, options)
    if (command === "rtk" && args[0] === "rewrite" && (result.code === 1 || result.code === 2)) {
      const cmd = args[1]
      if (typeof cmd === "string" && cmd !== "") {
        const prev = unmatched.get(cmd)
        if (prev !== undefined || unmatched.size < UNMATCHED_MAX) {
          unmatched.set(cmd, (prev ?? 0) + 1)
        }
      }
    }
    return result
  }

  pi.registerMessageRenderer<ReportData>("rtk-report", (message) => {
    const raw: unknown = message.details ?? ("data" in message ? message.data : undefined)
    const data: Partial<ReportData> = typeof raw === "object" && raw !== null ? (raw as Partial<ReportData>) : {}
    const title = typeof data.title === "string" ? data.title : "rtk report"
    const lines = Array.isArray(data.lines) ? data.lines.map((line) => String(line)) : []
    return {
      render: (width: number): readonly string[] => {
        const cap = width > 0 ? width : 120
        return [title, ...lines].map((row) => (row.length <= cap ? row : row.slice(0, cap)))
      },
    }
  })

  // All registrations run before the probe await so a host never misses a handler mid-probe.
  pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    pendingSessionCtx = ctx
    unmatched.clear()
    warnedUnavailable = false
    if (corruptedState) {
      corruptedState = false
      notify(ctx, "omp-rtk: state file is corrupted; rewriting stays enabled by default", "warning")
    }
    baseline = await fetchGain(pi)
    sessionSaved = baseline !== null ? 0 : null
    refreshStatus(ctx)
    warnUnavailableOnce(ctx)
  })

  pi.on("tool_call", async (event: ToolCallEvent) => {
    try {
      if (event.toolName !== "bash" || availability === null || !availability.ok) return
      const cmd = event.input.command
      if (typeof cmd !== "string") return
      if (shouldSkipCommand(cmd, enabled, process.env.RTK_DISABLED)) return
      const rewritten = await rewriteCommand(trackedExec, cmd)
      if (rewritten !== null && rewritten !== cmd) {
        return { input: { ...event.input, command: rewritten } }
      }
      return undefined
    } catch {
      return undefined
    }
  })

  pi.registerCommand("rtk", {
    description: "rtk integration: toggle, status, gain, doctor, discover",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parsed = parseSubcommand(args)
      switch (parsed.sub) {
        case "toggle": {
          enabled = !enabled
          try {
            await saveState(statePath, enabled)
          } catch (err) {
            notify(ctx, `omp-rtk: failed to save state: ${err instanceof Error ? err.message : String(err)}`, "warning")
          }
          refreshStatus(ctx)
          notify(ctx, enabled ? "RTK on" : "RTK off")
          break
        }
        case "status": {
          const current = availability !== null && availability.ok ? await fetchGain(pi) : null
          const saved = current !== null && baseline !== null ? computeSessionSaved(current, baseline) : null
          notify(
            ctx,
            [
              `rtk ${availability !== null && availability.ok ? availability.version ?? "unknown" : "unavailable"} · rewriting ${enabled ? "on" : "off"}`,
              `session saved: ${saved !== null ? formatShort(saved) : "unavailable"}`,
              `state file: ${statePath}`,
            ].join("\n")
          )
          break
        }
        case "gain": {
          const sanitized = sanitizeGainArgs(parsed.rest)
          if (!sanitized.ok) {
            notify(ctx, `refused ${sanitized.rejected.join(", ")}: /rtk gain is read-only`, "warning")
            break
          }
          const lines: string[] = []
          let summary: GainSummary | null = null
          try {
            const result = await pi.exec("rtk", ["gain", ...sanitized.args, "--format", "json"], {
              timeout: GAIN_TIMEOUT_MS,
            })
            if (result.code === 0) summary = parseGain(result.stdout)
          } catch {
            summary = null
          }
          if (summary !== null) {
            const input = summary.total_input
            const pct = input > 0 ? Math.round((summary.total_saved / input) * 1000) / 10 : 0
            lines.push(
              `total input: ${Math.round(summary.total_input)} tokens`,
              `total saved: ${Math.round(summary.total_saved)} tokens`,
              `savings rate: ${pct}%`
            )
            sessionSaved = baseline !== null ? computeSessionSaved(summary, baseline) : null
            refreshStatus(ctx)
          } else {
            lines.push(...(await plainGainText(pi, sanitized.args)))
          }
          emitReport(pi, ctx, "rtk gain", lines)
          break
        }
        case "doctor": {
          const lines: string[] = []
          const probe = await tryExec(pi, ["--version"], PROBE_TIMEOUT_MS)
          if (!probe.ok) {
            const code = errorCode(probe.error)
            lines.push(
              code === "ENOENT"
                ? "[FAIL] binary: rtk not found in PATH (install: https://github.com/rtk-ai/rtk#installation)"
                : code === "EACCES"
                  ? "[FAIL] binary: rtk not executable (fix: chmod +x $(command -v rtk))"
                  : `[FAIL] binary: ${probe.error instanceof Error ? probe.error.message : String(probe.error)}`
            )
          } else if (probe.result.code !== 0) {
            lines.push(`[FAIL] binary: rtk --version exited ${probe.result.code}`)
          } else {
            lines.push(`[OK] binary: ${probe.result.stdout.trim()}`)
          }
          const versionParsed = probe.ok && probe.result.code === 0 ? parseSemver(probe.result.stdout) : null
          if (versionParsed === null) {
            lines.push("[FAIL] version: could not parse rtk --version output")
          } else if (!isSupportedVersion(versionParsed)) {
            lines.push(`[FAIL] version: ${versionParsed.join(".")} < 0.25.0 (upgrade rtk)`)
          } else {
            lines.push(`[OK] version: ${versionParsed.join(".")} >= 0.25.0`)
          }
          const gitProbe = await tryExec(pi, ["rewrite", "git status"], PROBE_TIMEOUT_MS)
          if (!gitProbe.ok) {
            lines.push(`[FAIL] rewrite: ${gitProbe.error instanceof Error ? gitProbe.error.message : String(gitProbe.error)}`)
          } else {
            const out = gitProbe.result.stdout.trim()
            lines.push(
              (gitProbe.result.code === 0 || gitProbe.result.code === 3) && out !== ""
                ? `[OK] rewrite: rtk rewrite "git status" → ${out}`
                : `[FAIL] rewrite: exit ${gitProbe.result.code}${out !== "" ? `, output: ${out}` : ", no output"}`
            )
          }
          const htopProbe = await tryExec(pi, ["rewrite", "htop"], PROBE_TIMEOUT_MS)
          if (!htopProbe.ok) {
            lines.push(`[FAIL] rewrite: ${htopProbe.error instanceof Error ? htopProbe.error.message : String(htopProbe.error)}`)
          } else if (htopProbe.result.code === 1 || htopProbe.result.code === 2) {
            lines.push(`[OK] rewrite: "htop" has no rtk equivalent (exit ${htopProbe.result.code})`)
          } else if (htopProbe.result.code === 0 || htopProbe.result.code === 3) {
            const out = htopProbe.result.stdout.trim()
            lines.push(
              out !== "" ? `[OK] rewrite: "htop" → ${out}` : `[FAIL] rewrite: "htop" exit ${htopProbe.result.code} with no output`
            )
          } else {
            lines.push(`[FAIL] rewrite: "htop" exit ${htopProbe.result.code}`)
          }
          const gainSummary = await fetchGain(pi)
          lines.push(
            gainSummary !== null
              ? `[OK] gain: total_saved=${gainSummary.total_saved}, total_input=${gainSummary.total_input}`
              : "[FAIL] gain: rtk gain --format json is not parseable"
          )
          const stateNow = await loadState(statePath)
          lines.push(
            stateNow.corrupted
              ? `[FAIL] state: ${statePath} is corrupted or unreadable`
              : `[OK] state: ${statePath} (enabled=${stateNow.enabled})`
          )
          for (const name of ["PI_SHELL_PREFIX", "CLAUDE_CODE_SHELL_PREFIX", "RTK_DISABLED"] as const) {
            const value = process.env[name]
            lines.push(
              value ? `[FAIL] env: ${name}=${value} conflicts with omp-rtk rewriting` : `[OK] env: ${name} not set`
            )
          }
          emitReport(pi, ctx, "rtk doctor", lines)
          break
        }
        case "discover": {
          const lines: string[] = []
          if (unmatched.size === 0) {
            lines.push("—")
          } else {
            const sorted = [...unmatched.entries()].sort((a, b) => b[1] - a[1])
            for (const [cmd, count] of sorted) lines.push(`${count}× ${cmd}`)
          }
          if (availability !== null && availability.ok) {
            lines.push("", "rtk 的 Claude Code 会话扫描")
            const result = await tryExec(pi, ["discover", "--all"], DISCOVER_TIMEOUT_MS)
            if (!result.ok) {
              lines.push(`rtk discover --all failed: ${result.error instanceof Error ? result.error.message : String(result.error)}`)
            } else if (result.result.code !== 0) {
              lines.push(`rtk discover --all exited ${result.result.code}`)
            } else {
              const out = result.result.stdout.trim()
              lines.push(...(out === "" ? ["(no missed-command history found)"] : out.split("\n")))
            }
          }
          emitReport(pi, ctx, "rtk 未匹配命令（本次会话）", lines)
          break
        }
        case "help": {
          notify(
            ctx,
            [
              "/rtk — toggle rtk rewriting on/off (persisted)",
              "/rtk status — rtk version, on/off, session savings, state file path",
              "/rtk gain [args] — rtk gain totals (read-only; --reset/--yes/-y rejected)",
              "/rtk doctor — binary, version, rewrite contract, gain JSON, state file, conflicting env vars",
              "/rtk discover — this session's unmatched commands, then rtk discover --all",
            ].join("\n")
          )
          break
        }
      }
    },
  })

  availability = await probeRtk(pi)
  // A session that started while the probe was in flight applies availability state now.
  if (pendingSessionCtx !== undefined) {
    refreshStatus(pendingSessionCtx)
    warnUnavailableOnce(pendingSessionCtx)
  }
}
