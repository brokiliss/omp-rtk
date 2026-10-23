import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export function resolveStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.PI_CODING_AGENT_DIR
  if (dir && dir !== "") return join(dir, "omp-rtk.json")
  return join(homedir(), ".omp", "agent", "omp-rtk.json")
}

export async function loadState(
  path: string
): Promise<{ enabled: boolean; corrupted: boolean }> {
  try {
    const raw = await readFile(path, "utf8")
    const data: unknown = JSON.parse(raw)
    if (typeof data !== "object" || data === null) {
      return { enabled: true, corrupted: true }
    }
    if (!("enabled" in data)) return { enabled: true, corrupted: true }
    const enabled: unknown = data.enabled
    if (typeof enabled !== "boolean") return { enabled: true, corrupted: true }
    return { enabled, corrupted: false }
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return { enabled: true, corrupted: false }
    }
    return { enabled: true, corrupted: true }
  }
}

export async function saveState(path: string, enabled: boolean): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(tmp, JSON.stringify({ enabled }), "utf8")
    await rename(tmp, path)
  } catch (err) {
    await unlink(tmp).catch(() => {})
    throw err
  }
}
