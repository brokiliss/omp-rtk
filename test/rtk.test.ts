import { describe, expect, test } from "bun:test"
import type { ExecOptions, ExecResult } from "@oh-my-pi/pi-coding-agent"
import {
  isSupportedVersion,
  parseGain,
  parseSemver,
  parseSubcommand,
  rewriteCommand,
  sanitizeGainArgs,
  shouldSkipCommand,
} from "../src/rtk"

type FakeExec = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>

function fakeExec(overrides: Partial<ExecResult>): { exec: FakeExec; calls: [string, string[], ExecOptions?][] } {
  const calls: [string, string[], ExecOptions?][] = []
  const exec: FakeExec = async (command, args, options) => {
    calls.push([command, args, options])
    return { stdout: "", stderr: "", code: 0, killed: false, ...overrides }
  }
  return { exec, calls }
}

describe("parseSemver", () => {
  test('parses "rtk 1.0.1"', () => {
    expect(parseSemver("rtk 1.0.1")).toEqual([1, 0, 1])
  })
  test('parses "1.0.1"', () => {
    expect(parseSemver("1.0.1")).toEqual([1, 0, 1])
  })
  test('parses "0.24.9"', () => {
    expect(parseSemver("0.24.9")).toEqual([0, 24, 9])
  })
  test('parses "0.25.0"', () => {
    expect(parseSemver("0.25.0")).toEqual([0, 25, 0])
  })
  test('parses "2.0.0"', () => {
    expect(parseSemver("2.0.0")).toEqual([2, 0, 0])
  })
  test('returns null for "garbage"', () => {
    expect(parseSemver("garbage")).toBeNull()
  })
})

describe("isSupportedVersion", () => {
  test("0.24.9 is unsupported", () => {
    expect(isSupportedVersion([0, 24, 9])).toBe(false)
  })
  test("0.25.0 is supported", () => {
    expect(isSupportedVersion([0, 25, 0])).toBe(true)
  })
  test("1.0.1 is supported", () => {
    expect(isSupportedVersion([1, 0, 1])).toBe(true)
  })
  test("null is unsupported", () => {
    expect(isSupportedVersion(null)).toBe(false)
  })
})

describe("rewriteCommand", () => {
  test("exit 0 with output rewrites", async () => {
    const { exec } = fakeExec({ code: 0, stdout: "rtk git status\n" })
    await expect(rewriteCommand(exec, "git status")).resolves.toBe("rtk git status")
  })
  test("exit 3 with output rewrites", async () => {
    const { exec } = fakeExec({ code: 3, stdout: "rtk htop" })
    await expect(rewriteCommand(exec, "htop")).resolves.toBe("rtk htop")
  })
  test("exit 1 passes through", async () => {
    const { exec } = fakeExec({ code: 1, stdout: "rtk x" })
    await expect(rewriteCommand(exec, "x")).resolves.toBeNull()
  })
  test("exit 2 passes through", async () => {
    const { exec } = fakeExec({ code: 2, stdout: "rtk x" })
    await expect(rewriteCommand(exec, "x")).resolves.toBeNull()
  })
  test("killed passes through", async () => {
    const { exec } = fakeExec({ code: -1, killed: true, stdout: "rtk x" })
    await expect(rewriteCommand(exec, "x")).resolves.toBeNull()
  })
  test("exit 0 with empty output passes through", async () => {
    const { exec } = fakeExec({ code: 0, stdout: "" })
    await expect(rewriteCommand(exec, "x")).resolves.toBeNull()
  })
  test("thrown exec passes through", async () => {
    const exec: FakeExec = async () => {
      throw new Error("spawn failed")
    }
    await expect(rewriteCommand(exec, "x")).resolves.toBeNull()
  })
  test("delegates to rtk rewrite with a timeout", async () => {
    const { exec, calls } = fakeExec({ code: 1 })
    await rewriteCommand(exec, "git status")
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe("rtk")
    expect(calls[0][1]).toEqual(["rewrite", "git status"])
    expect(calls[0][2]?.timeout).toBe(2000)
  })
})

describe("shouldSkipCommand", () => {
  test('skips ""', () => {
    expect(shouldSkipCommand("", true, undefined)).toBe(true)
  })
  test('skips "   "', () => {
    expect(shouldSkipCommand("   ", true, undefined)).toBe(true)
  })
  test('skips "rtk git status"', () => {
    expect(shouldSkipCommand("rtk git status", true, undefined)).toBe(true)
  })
  test('skips "FOO=1 rtk git status"', () => {
    expect(shouldSkipCommand("FOO=1 rtk git status", true, undefined)).toBe(true)
  })
  test('skips "A=1 B=2 rtk x"', () => {
    expect(shouldSkipCommand("A=1 B=2 rtk x", true, undefined)).toBe(true)
  })
  test('keeps "git status" when enabled without env', () => {
    expect(shouldSkipCommand("git status", true, undefined)).toBe(false)
  })
  test("skips everything when disabled", () => {
    expect(shouldSkipCommand("git status", false, undefined)).toBe(true)
  })
  test('skips everything when rtkDisabled is "1"', () => {
    expect(shouldSkipCommand("git status", true, "1")).toBe(true)
  })
})

describe("sanitizeGainArgs", () => {
  test('rejects ["--reset"]', () => {
    expect(sanitizeGainArgs(["--reset"])).toEqual({ ok: false, rejected: ["--reset"] })
  })
  test('rejects ["-y"]', () => {
    expect(sanitizeGainArgs(["-y"])).toEqual({ ok: false, rejected: ["-y"] })
  })
  test('rejects ["--yes"]', () => {
    expect(sanitizeGainArgs(["--yes"])).toEqual({ ok: false, rejected: ["--yes"] })
  })
  test('keeps ["--all"]', () => {
    expect(sanitizeGainArgs(["--all"])).toEqual({ ok: true, args: ["--all"] })
  })
  test("keeps []", () => {
    expect(sanitizeGainArgs([])).toEqual({ ok: true, args: [] })
  })
})

describe("parseGain", () => {
  test("parses the real rtk gain JSON sample", () => {
    const sample =
      '{"summary":{"total_commands":8,"total_input":396,"total_output":124,"total_saved":272,"avg_savings_pct":68.68,"total_time_ms":54,"avg_time_ms":6,"oversized_excluded":0}}'
    expect(parseGain(sample)).toEqual({ total_saved: 272, total_input: 396 })
  })
  test('returns null for "{invalid"', () => {
    expect(parseGain("{invalid")).toBeNull()
  })
  test("returns null for {}", () => {
    expect(parseGain("{}")).toBeNull()
  })
  test("returns null when total_saved is a string", () => {
    const sample = '{"summary":{"total_saved":"272","total_input":396}}'
    expect(parseGain(sample)).toBeNull()
  })
})

describe("parseSubcommand", () => {
  test('"" toggles', () => {
    expect(parseSubcommand("")).toEqual({ sub: "toggle", rest: [] })
  })
  test('"status" shows status', () => {
    expect(parseSubcommand("status")).toEqual({ sub: "status", rest: [] })
  })
  test('"gain --all" gains with rest', () => {
    expect(parseSubcommand("gain --all")).toEqual({ sub: "gain", rest: ["--all"] })
  })
  test('"doctor" runs doctor', () => {
    expect(parseSubcommand("doctor")).toEqual({ sub: "doctor", rest: [] })
  })
  test('"discover" runs discover', () => {
    expect(parseSubcommand("discover")).toEqual({ sub: "discover", rest: [] })
  })
  test('"bogus" falls back to help', () => {
    expect(parseSubcommand("bogus")).toEqual({ sub: "help", rest: [] })
  })
})
