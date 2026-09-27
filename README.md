# CodePass

`/strix-fix-loop` for Pi — a local, authorized Strix scan → Pi fix → rescan loop
that runs inside the current Pi session.

[中文说明](README.zh-CN.md)

## What it does

One command, no scan artifacts to pass around:

1. Copies the project into a sanitized temporary workspace.
2. Runs a headless Strix scan in a per-round Docker network.
3. Hands that round's `findings.sarif` and report to the current Pi agent for
   triage and repair.
4. Rescans and repeats until the loop stops.

The extension never commits, pushes, or deploys code.

| Stop condition | Result |
| --- | --- |
| Scan failed or incomplete | `scan_failed` |
| No findings remain | `pass` |
| Same finding fingerprint after a fix | `stalled` |
| Pi made no repository change | `stalled` |
| Round limit reached | `round_limit` |

## Quick start

```bash
pi -e /path/to/codepass
```

```text
/strix-fix-loop ~/src/my-app
```

No scan result directory is required: each round's results are located
automatically and handed to the agent as soon as Strix finishes.

## Requirements

- macOS or Linux.
- Docker Engine or Docker Desktop, daemon running.
- Strix CLI 1.5.2+ — `strix` on `PATH`, `~/.strix/bin/strix`, or `STRIX_BIN`.
- A Git worktree for the target project (change tracking).
- Pi.

## Install

| Method | Command |
| --- | --- |
| Try it for one run | `pi -e /path/to/codepass` |
| Install as a Pi package | `pi install /path/to/codepass` |
| Global extension copy | `cp extensions/strix-fix-loop.ts extensions/strix-core.ts ~/.pi/agent/extensions/` |

## Usage

```text
/strix-fix-loop [project-dir] [quick|standard|deep] [flags]
```

```text
/strix-fix-loop                                      # current dir, quick, 3 rounds
/strix-fix-loop ~/src/my-app standard
/strix-fix-loop ~/src/my-app deep --max-rounds 2 --max-budget 20
/strix-fix-loop ~/src/my-app --instruction "Focus on authentication"
PI_FIX_DRY_RUN=true /strix-fix-loop ~/src/my-app     # read-only triage
```

If Pi or Strix stops mid-run, continue the same Pi session with `pi --continue`, then resume by run directory name:

```text
/strix-resume my-app-20260924-162025-81334
```

The `run-id` is the last component of the output directory and appears in the `/strix-fix-loop` transcript entry. Add `--output-dir PATH` when using a custom output root that cannot be found from the session transcript.

| Flag | Default | Purpose |
| --- | --- | --- |
| `-t`, `--target PATH` | current directory | Project directory |
| `-m`, `--scan-mode MODE` | `quick` | `quick`, `standard`, or `deep` |
| `--scope-mode MODE` | `full` | `auto`, `diff`, or `full` |
| `--max-budget USD` | `50` | Total Strix budget, split across rounds |
| `--max-turns N` | mode default | Maximum turns per Strix agent |
| `--instruction TEXT` | unset | Extra Strix instruction |
| `--instruction-file PATH` | unset | Instruction from a file (64 KiB limit) |
| `--max-rounds N` | `3` | Maximum scan/fix rounds |
| `--output-dir PATH` | `~/strix_runs` | Run output root, outside the project |
| `--dry-run` | `false` | Read-only fix pass, no file edits |
| `--keep-workspace` | `false` | Keep the sanitized scan workspace |
| `-n`, `--non-interactive` | — | Accepted for compatibility; scans are headless |
| `-h`, `--help` | — | Show help in the transcript |

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `STRIX_BIN` | `strix` / `~/.strix/bin/strix` | Strix executable |
| `STRIX_OUTPUT_DIR` | `~/strix_runs` | Run output root, outside the project |
| `STRIX_SCAN_MODE` | `quick` | `quick`, `standard`, or `deep` |
| `STRIX_SCOPE_MODE` | `full` | `auto`, `diff`, or `full` |
| `STRIX_MAX_BUDGET` / `STRIX_MAX_BUDGET_USD` | `50` | Total Strix budget |
| `STRIX_MAX_TURNS` | mode default | Maximum turns per Strix agent |
| `STRIX_TIMEOUT` | `9h30m` | Per-round scan timeout |
| `STRIX_FIX_LOOP_MAX_ROUNDS` | `3` | Maximum scan/fix rounds |
| `STRIX_KEEP_WORKSPACE` | `false` | Keep the temporary workspace |
| `STRIX_FRONTEND_STATIC` | `false` | Force static-only analysis |
| `STRIX_COORDINATION_OPTIMIZED` | `false` | Add coordination guidance to the scan instruction |
| `STRIX_TOKEN_OPTIMIZED` | `false` | Add token-efficiency guidance to the scan instruction |
| `STRIX_FAIL_ON_CONTEXT_ERROR` | `true` | Treat context-window errors as scan failure |
| `STRIX_SANDBOX_CPUS` | `2` | Docker sandbox CPU limit |
| `STRIX_SANDBOX_MEM_LIMIT` | `3g` | Docker sandbox memory limit |
| `STRIX_SANDBOX_PIDS_LIMIT` | `1024` | Docker sandbox PID limit |
| `STRIX_SANDBOX_SHM_SIZE` | `1g` | Docker sandbox shared-memory size |
| `PI_FIX_DRY_RUN` | `false` | Read-only fix pass, no file edits |
| `PI_FIX_ALLOW_BREAKING` | `true` | Allow necessary breaking fixes |

## How a round works

**Scan**

- The project is copied to `strix/round-N/workspace/target` under the run
  directory; `.git`, dot-files and dot-directories,
  dependency and build directories, archives, media, and binaries are pruned so
  Strix only sees source, scripts, configuration, dependency manifests,
  database scripts, and text templates. The copy is removed after a successful
  scan unless requested otherwise, and is kept after interruption for resume.
- Each round gets its own Docker network (`strix-managed=true`), removed
  afterwards; the sandbox is capped by the `STRIX_SANDBOX_*` limits.
- Strix runs headless with `--scope-mode` and a defensive, local, read-only
  instruction.
- A scan counts as successful only when `run.json` proves completion, exactly
  one `findings.sarif` and one `penetration_test_report.md` exist in the same
  run, the SARIF parses, and no context-window, runtime, or content-filter
  markers appear in the logs.

**Fix**

- The fix prompt goes to the current Pi session (`pi.sendUserMessage`) and the
  loop waits for the turn to settle.
- Changes are captured with a temporary Git index, so `changes.diff` also
  includes untracked files.
- `--dry-run` (or `PI_FIX_ALLOW_BREAKING=false`) keeps only read-only tools
  active for that turn.

**Resume**

- `loop-state.json` stores the current phase, round, Pi session file, and Strix run name.
- `/strix-resume <run-id>` resumes an interrupted Strix scan or continues an unfinished Pi fix in the restored Pi session, then proceeds to the next round.
- A run can only resume in its original Pi session; continue the session that started it with `pi --continue`.

## Output

Each run is written to `<output>/<project>-<timestamp>-<pid>/`:

```text
~/strix_runs/my-app-20260921-162025-81334/
├── loop-state.json             # Pi/Strix phase checkpoint
├── summary.md                  # round-by-round log
├── findings-round-N.txt        # stable finding fingerprints per round
├── strix/round-N/
│   ├── findings.sarif
│   ├── penetration_test_report.md
│   ├── run.json
│   ├── instruction.md
│   ├── scan-status.txt
│   ├── strix.log
│   ├── strix-console.log
│   └── workspace/target/       # Kept during a scan and after interruption
└── pi/round-N/
    ├── prompt.md
    ├── git-status-before.txt
    ├── git-status-after.txt
    └── changes.diff
```

## Safety

- Only scan projects you are authorized to inspect.
- The scan works on a sanitized copy; only the fix phase touches the original
  project.
- No command commits, pushes, deploys, or connects to a production system.
- Scan and Pi artifacts can contain source paths, vulnerability evidence, and
  remediation details — keep them private.

## Development

```bash
npm run check   # node scripts/self-check.ts
```

The self-check covers argument parsing, duration and budget handling, SARIF
fingerprinting, pruning rules, `run.json` validation, and prompt construction.
