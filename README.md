# omp-rtk

Bash command rewriting via [rtk](https://github.com/rtk-ai/rtk) plus an `/rtk` management command, for [omp](https://github.com/oh-my-pi/omp) (oh-my-pi).

## What it does

- **Bash rewrite** — every bash tool call is offered to `rtk rewrite` before execution. When rtk exits 0 or 3 with output, the command is replaced (for example `git status` executes as `rtk git status`). Exit 1/2, timeouts, empty output and exec failures always pass the original command through, so a missing or broken rtk can never block the agent.
- **`/rtk` command set** — toggle the integration, show status, view gain totals, run diagnostics and see missed rewrites without leaving the session. Command output never enters the model context: long reports render as session entries plus a full-text notification.
- **No visible chrome** — the plugin writes nothing to the status bar or footer; it only acts on commands and on what you ask for.
- **Persisted toggle** — the on/off state survives restarts; writes are atomic and a corrupted file falls back to enabled with one warning per session.

Setting `RTK_DISABLED=1` disables rewriting without unloading the plugin.

## Install

```sh
git clone https://github.com/brokiliss/omp-rtk
omp plugin install ./omp-rtk   # user scope (the default)
```

## Commands

| Command | Action |
| --- | --- |
| `/rtk` | Toggle rewriting on/off — persisted and effective immediately |
| `/rtk status` | rtk version, on/off state, session savings, state file path |
| `/rtk gain [args]` | rtk gain totals (read-only; `--reset`/`--yes`/`-y` are rejected, and so are `--format`/`-f` because the plugin always asks rtk for JSON itself) |
| `/rtk doctor` | Binary, version, rewrite contract, gain JSON, state file, conflicting env vars |
| `/rtk discover` | First this session's commands that `rtk rewrite` could not rewrite — deduplicated with counts — then the `rtk discover --all` Claude Code scan under a secondary heading |
| `/rtk help` (or any unknown argument) | Usage help |

## Config / state file

- Default path: `~/.omp/agent/omp-rtk.json` (content: `{"enabled": true}` / `{"enabled": false}`).
- `PI_CODING_AGENT_DIR` overrides the directory: `$PI_CODING_AGENT_DIR/omp-rtk.json`.
- Writes are atomic (temp file + rename), safe for concurrent sessions.
- A missing file means enabled; a corrupted or unreadable file falls back to enabled and warns once per session.

## Requirements

- rtk ≥ 0.25.0 (`rtk rewrite` first shipped in 0.25.0 per the rtk CHANGELOG; older versions pass commands through unchanged).
- omp ≥ 18.12.4 (extension API: `tool_call` input replacement, `appendEntry`, `registerCommand`).

## V2 scope

Not in this release:

- Output compression in `tool_result` — ANSI stripping, test-failure summaries, build filtering, git compression, linter grouping, grep per-file grouping, long-line truncation and total character caps — while protecting `read` line anchors and later `edit` calls.
