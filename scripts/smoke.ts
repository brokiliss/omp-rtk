#!/usr/bin/env bun
/**
 * Standalone smoke test for the omp-rtk extension factory (src/index.ts).
 *
 * Drives the factory through a mock ExtensionAPI (structurally cast at the
 * boundary; no test framework, no test helpers) and then asserts the two
 * recorded `rtk rewrite` contract facts against the real binary.
 *
 * Usage: bun scripts/smoke.ts   (or: bun run smoke)
 * Exit code: 0 when every scenario passed or was skipped; 1 on any failure.
 * One PASS/FAIL line per scenario, a final count line; the real-rtk cases
 * print SKIP (not FAIL) when `rtk` is absent from PATH.
 *
 * State-file isolation: every factory-driving scenario points
 * PI_CODING_AGENT_DIR at a fresh temp dir that is removed afterwards, so the
 * developer's real ~/.omp/agent/omp-rtk.json is never read or written.
 */

import type {
  ExecOptions,
  ExecResult,
  ExtensionAPI,
  ExtensionCommandContext,
} from "@oh-my-pi/pi-coding-agent"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import factory from "../src/index"

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0
let skipped = 0

function check(cond: boolean, label: string): void {
  if (!cond) throw new Error(`assertion failed: ${label}`)
}

async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`PASS ${name}`)
  } catch (err) {
    failed++
    console.log(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Runs fn with PI_CODING_AGENT_DIR pointing at a fresh temp dir; always restores env and removes the dir. */
async function withTempAgentDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "omp-rtk-smoke-"))
  const prev = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = dir
  try {
    await fn(dir)
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prev
    await rm(dir, { recursive: true, force: true })
  }
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** Controllable pending promise, used to hold the availability probe in flight. */
class Deferred<T> {
  readonly promise: Promise<T>
  settled = false
  private readonly resolveInternal: (value: T) => void
  constructor() {
    const { promise, resolve } = Promise.withResolvers<T>()
    this.promise = promise
    this.resolveInternal = resolve
  }
  resolve(value: T): void {
    this.settled = true
    this.resolveInternal(value)
  }
}

type ExecScript = {
  command: string
  args: string[]
  response?: (options?: ExecOptions) => ExecResult
  error?: unknown | (() => unknown)
  pending?: Deferred<ExecResult>
}

class MockExtensionAPI {
  execCalls: { command: string; args: string[]; options?: ExecOptions }[] = []
  eventHandlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>()
  commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> | void }>()
  messageRenderers = new Map<string, unknown>()
  appendEntryCalls: { customType: string; data: unknown }[] = []
  sendMessageCalls: unknown[] = []
  logger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
  private scripts: ExecScript[] = []

  /** Script the next matching exec call with a result; entries are consumed once (queue semantics). */
  script(command: string, args: string[], response: ExecResult | ((options?: ExecOptions) => ExecResult)): void {
    this.scripts.push({
      command,
      args,
      response: typeof response === "function" ? response : () => response,
    })
  }

  /** Script the next matching exec call to throw. */
  scriptError(command: string, args: string[], error: unknown | (() => unknown)): void {
    this.scripts.push({ command, args, error })
  }

  /** Script the next matching exec call to return a controllable pending promise. */
  scriptPending(command: string, args: string[], pending: Deferred<ExecResult>): void {
    this.scripts.push({ command, args, pending })
  }

  // ExtensionAPI surface, structurally cast at the call boundary.
  exec = async (command: string, args: string[], options?: ExecOptions): Promise<ExecResult> => {
    this.execCalls.push({ command, args, options })
    const idx = this.scripts.findIndex(
      (s) => s.command === command && s.args.length === args.length && s.args.every((a, i) => a === args[i])
    )
    if (idx === -1) throw new Error(`unscripted exec: ${command} ${JSON.stringify(args)}`)
    const script = this.scripts[idx]
    this.scripts.splice(idx, 1)
    if (script.pending) return script.pending.promise
    if (script.error !== undefined) throw typeof script.error === "function" ? script.error() : script.error
    return script.response!(options)
  }

  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void {
    const list = this.eventHandlers.get(event) ?? []
    list.push(handler)
    this.eventHandlers.set(event, list)
  }

  registerCommand(
    name: string,
    options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> | void }
  ): void {
    this.commands.set(name, options)
  }

  registerMessageRenderer(customType: string, renderer: unknown): void {
    this.messageRenderers.set(customType, renderer)
  }

  appendEntry(customType: string, data?: unknown): void {
    this.appendEntryCalls.push({ customType, data })
  }

  sendMessage(): void {
    this.sendMessageCalls.push({})
  }

  async fireToolCall(input: Record<string, unknown>, toolName = "bash", ctx?: unknown): Promise<unknown> {
    const handlers = this.eventHandlers.get("tool_call")
    if (!handlers || handlers.length === 0) throw new Error("no tool_call handler registered")
    const event = { type: "tool_call", toolCallId: "smoke-tc-1", toolName, input }
    let result: unknown
    for (const handler of handlers) result = await handler(event, ctx)
    return result
  }

  async fireSessionStart(ctx: unknown): Promise<void> {
    const handlers = this.eventHandlers.get("session_start")
    if (!handlers || handlers.length === 0) throw new Error("no session_start handler registered")
    for (const handler of handlers) await handler({ type: "session_start" }, ctx)
  }

  async runRtkCommand(args: string, ctx: unknown): Promise<void> {
    const command = this.commands.get("rtk")
    if (!command) throw new Error("rtk command not registered")
    await command.handler(args, ctx)
  }

  rewriteExecCount(): number {
    return this.execCalls.filter((c) => c.command === "rtk" && c.args[0] === "rewrite").length
  }
}

const RES = (code: number, stdout: string, killed = false): ExecResult => ({ stdout, stderr: "", code, killed })
const gainJson = (total_saved: number, total_input: number): string =>
  JSON.stringify({ summary: { total_saved, total_input } })

function happyMock(): MockExtensionAPI {
  const mock = new MockExtensionAPI()
  mock.script("rtk", ["--version"], RES(0, "rtk 1.0.1\n"))
  return mock
}

type ContextFixture = {
  ctx: ExtensionCommandContext
  notify: { message: string; level?: string }[]
  status: { key: string; text: string | undefined }[]
}

function makeContext(cwd = "/tmp/smoke"): ContextFixture {
  const notify: { message: string; level?: string }[] = []
  const status: { key: string; text: string | undefined }[] = []
  const ctx = {
    cwd,
    ui: {
      notify: (message: string, level?: "info" | "warning" | "error") => {
        notify.push({ message, level })
      },
      setStatus: (key: string, text: string | undefined) => {
        status.push({ key, text })
      },
    },
  } as unknown as ExtensionCommandContext
  return { ctx, notify, status }
}

/** Narrow the tool_call handler's return value to the rewritten command string, if any. */
function rewrittenCommandOf(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined
  if (!("input" in result)) return undefined
  const input: unknown = result.input
  if (typeof input !== "object" || input === null) return undefined
  if (!("command" in input)) return undefined
  const command: unknown = input.command
  return typeof command === "string" ? command : undefined
}

/** Narrow an appendEntry call to its report payload (title + lines). */
function reportOf(entry: unknown): { title: string; lines: string[] } | undefined {
  if (typeof entry !== "object" || entry === null) return undefined
  if (!("data" in entry)) return undefined
  const data: unknown = entry.data
  if (typeof data !== "object" || data === null) return undefined
  if (!("title" in data) || !("lines" in data)) return undefined
  const title: unknown = data.title
  const lines: unknown = data.lines
  if (typeof title !== "string" || !Array.isArray(lines)) return undefined
  return { title, lines: lines.map((line) => String(line)) }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const originalRtkDisabled = process.env.RTK_DISABLED
  delete process.env.RTK_DISABLED // scenarios control it explicitly; restored below

  await scenario("exit 0 rewrite replaces the bash command", () =>
    withTempAgentDir(async () => {
      const mock = happyMock()
      mock.script("rtk", ["rewrite", "git status"], RES(0, "rtk git status\n"))
      const { ctx } = makeContext()
      await factory(mock as unknown as ExtensionAPI)
      const input = { command: "git status", timeout: 5000 }
      const result = await mock.fireToolCall(input, "bash", ctx)
      check(result !== undefined, "handler returned a replacement input")
      check(rewrittenCommandOf(result) === "rtk git status", `command rewritten (got ${JSON.stringify(result)})`)
      check(input.command === "git status", "original event.input was not mutated")
    })
  )

  await scenario("exit 3 rewrite replaces the bash command", () =>
    withTempAgentDir(async () => {
      const mock = happyMock()
      mock.script("rtk", ["rewrite", "git status"], RES(3, "rtk git status\n"))
      const { ctx } = makeContext()
      await factory(mock as unknown as ExtensionAPI)
      const result = await mock.fireToolCall({ command: "git status" }, "bash", ctx)
      check(rewrittenCommandOf(result) === "rtk git status", `command rewritten on exit 3 (got ${JSON.stringify(result)})`)
    })
  )

  await scenario("exit 1 passes the original command through", () =>
    withTempAgentDir(async () => {
      const mock = happyMock()
      mock.script("rtk", ["rewrite", "git status"], RES(1, ""))
      const { ctx } = makeContext()
      await factory(mock as unknown as ExtensionAPI)
      const result = await mock.fireToolCall({ command: "git status" }, "bash", ctx)
      check(result === undefined, "exit 1 returns undefined (pass through)")
      check(mock.rewriteExecCount() === 1, "rewrite was still attempted")
    })
  )

  await scenario("exit 2 passes the original command through", () =>
    withTempAgentDir(async () => {
      const mock = happyMock()
      mock.script("rtk", ["rewrite", "git status"], RES(2, ""))
      const { ctx } = makeContext()
      await factory(mock as unknown as ExtensionAPI)
      const result = await mock.fireToolCall({ command: "git status" }, "bash", ctx)
      check(result === undefined, "exit 2 returns undefined (pass through)")
      check(mock.rewriteExecCount() === 1, "rewrite was still attempted")
    })
  )

  await scenario("killed timeout passes the original command through", () =>
    withTempAgentDir(async () => {
      const mock = happyMock()
      mock.script("rtk", ["rewrite", "git status"], RES(-1, "", true))
      const { ctx } = makeContext()
      await factory(mock as unknown as ExtensionAPI)
      const result = await mock.fireToolCall({ command: "git status" }, "bash", ctx)
      check(result === undefined, "killed result returns undefined (pass through)")
    })
  )

  await scenario("empty stdout passes the original command through", () =>
    withTempAgentDir(async () => {
      const mock = happyMock()
      mock.script("rtk", ["rewrite", "git status"], RES(0, "   \n"))
      const { ctx } = makeContext()
      await factory(mock as unknown as ExtensionAPI)
      const result = await mock.fireToolCall({ command: "git status" }, "bash", ctx)
      check(result === undefined, "empty stdout returns undefined (pass through)")
    })
  )

  await scenario("throwing exec fails open without an uncaught error", () =>
    withTempAgentDir(async () => {
      const mock = happyMock()
      mock.scriptError("rtk", ["rewrite", "git status"], new Error("spawn exploded"))
      const { ctx } = makeContext()
      await factory(mock as unknown as ExtensionAPI)
      const result = await mock.fireToolCall({ command: "git status" }, "bash", ctx)
      check(result === undefined, "throwing exec returns undefined (pass through)")
    })
  )

  await scenario("non-bash events are untouched", () =>
    withTempAgentDir(async () => {
      const mock = happyMock()
      mock.script("rtk", ["rewrite", "git status"], RES(0, "rtk git status\n"))
      const { ctx } = makeContext()
      await factory(mock as unknown as ExtensionAPI)
      const result = await mock.fireToolCall({ command: "git status" }, "read", ctx)
      check(result === undefined, "read tool call returns undefined")
      check(mock.rewriteExecCount() === 0, "no rtk rewrite exec for a non-bash tool")
    })
  )

  await scenario("RTK_DISABLED=1 skips rewriting entirely", () =>
    withTempAgentDir(async () => {
      const mock = happyMock()
      mock.script("rtk", ["rewrite", "git status"], RES(0, "rtk git status\n"))
      const { ctx } = makeContext()
      await factory(mock as unknown as ExtensionAPI)
      process.env.RTK_DISABLED = "1"
      try {
        const result = await mock.fireToolCall({ command: "git status" }, "bash", ctx)
        check(result === undefined, "rewrite disabled while RTK_DISABLED=1")
        check(mock.rewriteExecCount() === 0, "no rtk rewrite exec while disabled")
      } finally {
        delete process.env.RTK_DISABLED
      }
    })
  )

  await scenario("toggle off/on persists to the state file", () =>
    withTempAgentDir(async (dir) => {
      const mock = happyMock()
      mock.script("rtk", ["gain", "--format", "json"], RES(0, gainJson(100, 200)))
      mock.script("rtk", ["rewrite", "git status"], RES(0, "rtk git status\n"))
      mock.script("rtk", ["rewrite", "git status"], RES(0, "rtk git status\n"))
      const { ctx, notify, status } = makeContext()
      const statePath = join(dir, "omp-rtk.json")
      await factory(mock as unknown as ExtensionAPI)
      await mock.fireSessionStart(ctx)
      check(
        rewrittenCommandOf(await mock.fireToolCall({ command: "git status" }, "bash", ctx)) === "rtk git status",
        "rewrites while enabled by default"
      )
      await mock.runRtkCommand("", ctx)
      check((await readFile(statePath, "utf8")) === '{"enabled":false}', "state file records enabled=false after toggle off")
      check(status.length === 0, `no status bar writes (got ${JSON.stringify(status)})`)
      check(notify.some((n) => n.message === "RTK off"), "toggle off notified")
      check((await mock.fireToolCall({ command: "git status" }, "bash", ctx)) === undefined, "no rewrite while off")
      check(mock.rewriteExecCount() === 1, `no rewrite exec while off (got ${mock.rewriteExecCount()})`)
      await mock.runRtkCommand("", ctx)
      check((await readFile(statePath, "utf8")) === '{"enabled":true}', "state file records enabled=true after toggle on")
      check(notify.some((n) => n.message === "RTK on"), "toggle on notified")
      check(
        rewrittenCommandOf(await mock.fireToolCall({ command: "git status" }, "bash", ctx)) === "rtk git status",
        "rewrites again after re-enable"
      )
      check(notify.some((n) => n.message === "RTK off") && notify.some((n) => n.message === "RTK on"), "toggle notifications sent")
    })
  )

  await scenario("corrupted state file falls back to enabled with one warning", () =>
    withTempAgentDir(async (dir) => {
      await writeFile(join(dir, "omp-rtk.json"), '{"enabled":"yes"}', "utf8")
      const mock = happyMock()
      mock.script("rtk", ["gain", "--format", "json"], RES(0, gainJson(100, 200)))
      mock.script("rtk", ["gain", "--format", "json"], RES(0, gainJson(100, 200)))
      mock.script("rtk", ["rewrite", "git status"], RES(0, "rtk git status\n"))
      const { ctx, notify } = makeContext()
      await factory(mock as unknown as ExtensionAPI)
      await mock.fireSessionStart(ctx)
      await mock.fireSessionStart(ctx)
      const warnings = notify.filter((n) => n.level === "warning" && n.message.includes("corrupted"))
      check(warnings.length === 1, `corruption warned exactly once across the session (got ${warnings.length})`)
      check(
        rewrittenCommandOf(await mock.fireToolCall({ command: "git status" }, "bash", ctx)) === "rtk git status",
        "corrupted state falls back to enabled rewriting"
      )
    })
  )

  await scenario("missing rtk (ENOENT) fails open with an install hint", () =>
    withTempAgentDir(async () => {
      const mock = new MockExtensionAPI()
      mock.scriptError("rtk", ["--version"], Object.assign(new Error("spawn rtk ENOENT"), { code: "ENOENT" }))
      const { ctx, notify, status } = makeContext()
      await factory(mock as unknown as ExtensionAPI)
      await mock.fireSessionStart(ctx)
      const warn = notify.find((n) => n.level === "warning")
      check(warn !== undefined && warn.message.includes("not found in PATH"), `install hint notified (got ${JSON.stringify(warn)})`)
      check(status.length === 0, `no status bar writes (got ${JSON.stringify(status)})`)
      check((await mock.fireToolCall({ command: "git status" }, "bash", ctx)) === undefined, "tool call passes through when rtk is unavailable")
      check(mock.rewriteExecCount() === 0, "no rewrite exec when rtk is unavailable")
    })
  )

  await scenario("non-executable rtk (EACCES) warns with a chmod hint", () =>
    withTempAgentDir(async () => {
      const mock = new MockExtensionAPI()
      mock.scriptError("rtk", ["--version"], Object.assign(new Error("spawn rtk EACCES"), { code: "EACCES" }))
      const { ctx, notify } = makeContext()
      await factory(mock as unknown as ExtensionAPI)
      await mock.fireSessionStart(ctx)
      const warn = notify.find((n) => n.level === "warning")
      check(warn !== undefined && warn.message.includes("chmod +x"), `chmod hint notified (got ${JSON.stringify(warn)})`)
    })
  )

  await scenario("handlers register before the probe resolves", () =>
    withTempAgentDir(async () => {
      const mock = new MockExtensionAPI()
      const probe = new Deferred<ExecResult>()
      mock.scriptPending("rtk", ["--version"], probe)
      mock.script("rtk", ["gain", "--format", "json"], RES(0, gainJson(100, 200)))
      const { ctx, status } = makeContext()
      const p = factory(mock as unknown as ExtensionAPI)
      await waitFor(() => mock.execCalls.some((c) => c.command === "rtk" && c.args[0] === "--version"), "probe exec to be issued")
      check(!probe.settled, "probe promise is still pending while registrations are inspected")
      check(
        mock.eventHandlers.has("session_start") && mock.eventHandlers.has("tool_call"),
        "session_start and tool_call handlers registered before the probe resolves"
      )
      check(mock.commands.has("rtk"), "rtk command registered before the probe resolves")
      check(mock.messageRenderers.size === 0, "no message renderers registered (rtk-report removed)")
      await mock.fireSessionStart(ctx)
      check(status.length === 0, `no status bar writes (got ${JSON.stringify(status)})`)
      probe.resolve(RES(0, "rtk 1.0.1\n"))
      await p
      check(status.length === 0, `still no status bar writes after the probe resolves (got ${JSON.stringify(status)})`)
      check(mock.rewriteExecCount() === 0, "no rewrite issued merely by resolving the probe")
    })
  )

  await scenario("gain falls back to plain text when JSON is unparseable", () =>
    withTempAgentDir(async () => {
      const mock = happyMock()
      mock.script("rtk", ["gain", "--format", "json"], RES(0, "definitely not json"))
      mock.script("rtk", ["gain"], RES(0, "line one\nline two\n"))
      const { ctx, notify } = makeContext()
      await factory(mock as unknown as ExtensionAPI)
      await mock.runRtkCommand("gain", ctx)
      const report = mock.appendEntryCalls.find((c) => c.customType === "rtk-report")
      check(report !== undefined, "report appended as a custom session entry")
      const data = reportOf(report)
      check(
        data !== undefined && data.title === "rtk gain" && data.lines.join("\n") === "line one\nline two",
        `plain text carried untruncated (got ${JSON.stringify(data)})`
      )
      check(notify.some((n) => n.message.includes("line one") && n.message.includes("line two")), "full report text notified")
      check(mock.sendMessageCalls.length === 0, "no sendMessage for the report")
    })
  )

  await scenario("/rtk status states RTK_DISABLED=1 suppression", () =>
    withTempAgentDir(async () => {
      const mock = happyMock()
      mock.script("rtk", ["gain", "--format", "json"], RES(0, gainJson(100, 200)))
      const { ctx, notify } = makeContext()
      await factory(mock as unknown as ExtensionAPI)
      process.env.RTK_DISABLED = "1"
      try {
        await mock.runRtkCommand("status", ctx)
        const msg = notify.find((n) => n.message.includes("rtk 1.0.1"))
        check(msg !== undefined, `status notified (got ${JSON.stringify(notify.map((n) => n.message))})`)
        check(
          msg!.message.includes("RTK_DISABLED=1: rewriting suppressed in this session"),
          `status states the suppression (got ${JSON.stringify(msg!.message)})`
        )
      } finally {
        delete process.env.RTK_DISABLED
      }
    })
  )

  await scenario("reports never reach the model context", () =>
    withTempAgentDir(async () => {
      const mock = happyMock()
      mock.script("rtk", ["--version"], RES(0, "rtk 1.0.1\n")) // doctor re-probes
      mock.script("rtk", ["gain", "--format", "json"], RES(0, gainJson(272, 396)))
      mock.script("rtk", ["gain", "--format", "json"], RES(0, gainJson(272, 396)))
      mock.script("rtk", ["rewrite", "git status"], RES(3, "rtk git status\n"))
      mock.script("rtk", ["rewrite", "htop"], RES(1, ""))
      const { ctx, notify } = makeContext()
      await factory(mock as unknown as ExtensionAPI)
      await mock.runRtkCommand("gain", ctx)
      await mock.runRtkCommand("doctor", ctx)
      check(mock.appendEntryCalls.length === 2, `both reports appended as custom entries (got ${mock.appendEntryCalls.length})`)
      check(mock.sendMessageCalls.length === 0, `sendMessage never called (got ${mock.sendMessageCalls.length})`)
      const gain = reportOf(mock.appendEntryCalls[0])
      check(gain !== undefined, "gain report payload recorded")
      check(gain!.lines.some((l) => l.includes("272")), `gain report carries the numbers (got ${JSON.stringify(gain!.lines)})`)
      check(notify.some((n) => n.message.includes("rtk doctor")), "doctor report notified with full text")
    })
  )

  await scenario("gain report carries totals without touching a status line", () =>
    withTempAgentDir(async () => {
      const mock = happyMock()
      mock.script("rtk", ["gain", "--format", "json"], RES(0, gainJson(100, 200)))
      mock.script("rtk", ["gain", "--format", "json"], RES(0, gainJson(272, 396)))
      const { ctx, status, notify } = makeContext()
      await factory(mock as unknown as ExtensionAPI)
      await mock.fireSessionStart(ctx)
      await mock.runRtkCommand("gain", ctx)
      check(status.length === 0, `no status bar writes (got ${JSON.stringify(status)})`)
      const report = reportOf(mock.appendEntryCalls.at(-1))
      check(report !== undefined && report.title === "rtk gain", "gain report appended")
      check(
        report!.lines.some((l) => l.includes("272")) && report!.lines.some((l) => l.includes("396")),
        `gain report carries totals (got ${JSON.stringify(report!.lines)})`
      )
      check(notify.some((n) => n.message.includes("total saved")), "gain report notified")
    })
  )

  await scenario("unmatched commands surface in discover and reset per session", () =>
    withTempAgentDir(async () => {
      const mock = happyMock()
      mock.script("rtk", ["rewrite", "htop"], RES(1, ""))
      mock.script("rtk", ["rewrite", "htop"], RES(1, ""))
      mock.script("rtk", ["rewrite", "man man"], RES(2, ""))
      mock.script("rtk", ["discover", "--all"], RES(0, "found 2 sessions\n"))
      mock.script("rtk", ["discover", "--all"], RES(0, "found 2 sessions\n"))
      mock.script("rtk", ["gain", "--format", "json"], RES(0, gainJson(100, 200)))
      const { ctx } = makeContext()
      await factory(mock as unknown as ExtensionAPI)
      await mock.fireToolCall({ command: "htop" }, "bash", ctx)
      await mock.fireToolCall({ command: "htop" }, "bash", ctx)
      await mock.fireToolCall({ command: "man man" }, "bash", ctx)
      await mock.runRtkCommand("discover", ctx)
      const first = reportOf(mock.appendEntryCalls.at(-1))
      check(first !== undefined, "discover report recorded")
      check(first!.title === "rtk 未匹配命令（本次会话）", `discover report title (got ${first!.title})`)
      check(
        first!.lines[0] === "2× htop" && first!.lines[1] === "1× man man",
        `deduplicated counts lead the report (got ${JSON.stringify(first!.lines.slice(0, 2))})`
      )
      check(
        first!.lines.includes("rtk 的 Claude Code 会话扫描") && first!.lines.includes("found 2 sessions"),
        "rtk discover --all appended under the secondary heading"
      )
      await mock.fireSessionStart(ctx)
      await mock.runRtkCommand("discover", ctx)
      const second = reportOf(mock.appendEntryCalls.at(-1))
      check(second !== undefined, "second discover report recorded")
      check(second!.lines[0] === "—", `unmatched map resets on session_start (got ${JSON.stringify(second!.lines[0])})`)
    })
  )

  // -------------------------------------------------------------------------
  // Real-rtk section: the two recorded contract facts. SKIP (not FAIL) when
  // the binary is absent; FAIL when present but different.
  // -------------------------------------------------------------------------
  const rtkPath = Bun.which("rtk")
  if (rtkPath === null) {
    skipped += 2
    console.log(`SKIP real rtk: rewrite "git status" — rtk not found on PATH`)
    console.log(`SKIP real rtk: rewrite "htop" — rtk not found on PATH`)
  } else {
    const git = Bun.spawnSync(["rtk", "rewrite", "git status"], { stdout: "pipe", stderr: "pipe" })
    const gitOut = new TextDecoder().decode(git.stdout)
    const gitOk = (git.exitCode === 0 || git.exitCode === 3) && gitOut.trim() !== ""
    if (gitOk) {
      passed++
      console.log(`PASS real rtk: rewrite "git status" → ${JSON.stringify(gitOut.trim())} (exit ${git.exitCode})`)
    } else {
      failed++
      console.log(`FAIL real rtk: rewrite "git status" exit ${git.exitCode}, stdout ${JSON.stringify(gitOut)}`)
    }
    const htop = Bun.spawnSync(["rtk", "rewrite", "htop"], { stdout: "pipe", stderr: "pipe" })
    const htopOut = new TextDecoder().decode(htop.stdout)
    const htopOk = htop.exitCode === 1 && htopOut.trim() === ""
    if (htopOk) {
      passed++
      console.log(`PASS real rtk: rewrite "htop" has no equivalent (exit 1, empty stdout)`)
    } else {
      failed++
      console.log(`FAIL real rtk: rewrite "htop" exit ${htop.exitCode}, stdout ${JSON.stringify(htopOut)}`)
    }
  }

  if (originalRtkDisabled !== undefined) process.env.RTK_DISABLED = originalRtkDisabled

  console.log(`smoke summary: ${passed} passed, ${failed} failed, ${skipped} skipped`)
  process.exitCode = failed > 0 ? 1 : 0
}

await main()
