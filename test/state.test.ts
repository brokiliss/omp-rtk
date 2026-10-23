import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { loadState, resolveStatePath, saveState } from "../src/state"

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "omp-rtk-state-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("resolveStatePath", () => {
  test("honors PI_CODING_AGENT_DIR", () => {
    expect(resolveStatePath({ PI_CODING_AGENT_DIR: "/tmp/x" })).toBe("/tmp/x/omp-rtk.json")
  })
  test("falls back to the home dir default", () => {
    expect(resolveStatePath({})).toBe(join(homedir(), ".omp", "agent", "omp-rtk.json"))
  })
})

describe("loadState", () => {
  test("missing file loads enabled, not corrupted", async () => {
    await expect(loadState(join(dir, "omp-rtk.json"))).resolves.toEqual({ enabled: true, corrupted: false })
  })
  test('loads {"enabled":false} as disabled, not corrupted', async () => {
    const path = join(dir, "omp-rtk.json")
    await writeFile(path, '{"enabled":false}', "utf8")
    await expect(loadState(path)).resolves.toEqual({ enabled: false, corrupted: false })
  })
  test('treats {"enabled":"yes"} as corrupted', async () => {
    const path = join(dir, "omp-rtk.json")
    await writeFile(path, '{"enabled":"yes"}', "utf8")
    await expect(loadState(path)).resolves.toEqual({ enabled: true, corrupted: true })
  })
  test("treats garbage as corrupted", async () => {
    const path = join(dir, "omp-rtk.json")
    await writeFile(path, "garbage", "utf8")
    await expect(loadState(path)).resolves.toEqual({ enabled: true, corrupted: true })
  })
})

describe("saveState", () => {
  test("creates missing parent directories and writes exactly the expected content", async () => {
    const path = join(dir, "a", "b", "omp-rtk.json")
    await saveState(path, false)
    expect(await readFile(path, "utf8")).toBe('{"enabled":false}')
  })
  test("leaves no temp sibling behind", async () => {
    const path = join(dir, "omp-rtk.json")
    await saveState(path, false)
    const entries = await readdir(dir)
    expect(entries.filter((name) => name.includes(".tmp-"))).toEqual([])
  })
  test("roundtrips through loadState", async () => {
    const path = join(dir, "omp-rtk.json")
    await saveState(path, false)
    await expect(loadState(path)).resolves.toEqual({ enabled: false, corrupted: false })
    await saveState(path, true)
    await expect(loadState(path)).resolves.toEqual({ enabled: true, corrupted: false })
  })
})
