# CodePass

CodePass is a local, authorized source-code security workflow built around
Strix and Pi. The Go CLI provides three commands:

1. `scan` copies a target project into an isolated, sanitized workspace and
   runs a Strix scan.
2. `fix` reads one explicitly selected Strix result, triages the findings with
   Pi, and can fix confirmed issues.
3. `run` orchestrates a bounded scan -> fix -> rescan loop.

The CLI never commits, pushes, or deploys code automatically.

## Requirements

- Go 1.22 or newer.
- macOS or Linux.
- Docker Engine or Docker Desktop with a running daemon.
- Strix CLI 1.4.1 or newer, available as `strix`, or configured with
  `STRIX_BIN`.
- Pi CLI, available as `pi`, or configured with `PI_BIN`.
- Git for the `run` workflow and Pi change tracking.

Build the binary:

```bash
go build -o codepass .
```

## Usage

```bash
./codepass scan --auto /path/to/project quick
./codepass fix --auto /path/to/project /path/to/scan-result
./codepass run --auto /path/to/project quick
```

`scan` is interactive by default. `fix` is interactive by default. `run` is
automatic by default. Use `--interactive` or `--auto` to select explicitly.

Pass a result directory containing `findings.sarif` and
`penetration_test_report.md`, a `.sarif` file with the standard Markdown file
beside it, or a `.md` file with the standard SARIF file beside it.
Writable fixes ask for confirmation, including with `--auto`.
A successful Pi exit leaves project verification pending. Review the diff and
run your project checks before treating the findings as fixed.

The default `run` loop has three rounds. It stops when a scan fails or is
incomplete, no findings remain, Pi makes no change, the same finding
fingerprint returns, or the round limit is reached.

Read-only remediation:

```bash
PI_FIX_DRY_RUN=true ./codepass fix --auto /path/to/project /path/to/scan-result
```

## Environment

Scan variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `STRIX_BIN` | `strix` or `~/.strix/bin/strix` | Strix executable |
| `STRIX_OUTPUT_DIR` | `~/strix_runs` | Scan output root, outside the target |
| `STRIX_RUN_ID` | generated | Run identifier, ASCII letters/digits/`.`/`_`/`-`, max 48 chars |
| `STRIX_RUN_UI_MODE` | `interactive` | `interactive` or `auto` |
| `STRIX_SCAN_MODE` | `quick` | `quick`, `standard`, or `deep` |
| `STRIX_MAX_BUDGET` | `50` | Total Strix budget |
| `STRIX_TIMEOUT` | `9h30m` | Total scan timeout |
| `STRIX_MAX_TURNS` | mode-dependent | Maximum turns per agent |
| `STRIX_NETWORK_RETRIES` | `1` | Automatic-mode transport retries, `0` to `2` |
| `STRIX_KEEP_WORKSPACE` | `false` | Keep the temporary workspace |
| `STRIX_FRONTEND_STATIC` | `false` | Force static-only analysis |

Pi variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_BIN` | `pi` | Pi executable |
| `PI_OUTPUT_DIR` | `~/pi_runs` | Pi output root, outside the target and scan result |
| `PI_FIX_DRY_RUN` | `false` | Use Pi read-only tools and do not modify files |
| `PI_FIX_ALLOW_BREAKING` | `true` | Allow necessary breaking fixes |
| `PI_TIMEOUT` | unset | Optional Pi timeout |

Loop variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODE_PASS_OUTPUT_DIR` | `~/code_pass_runs` | Loop output root |
| `CODE_PASS_MAX_ROUNDS` | `3` | Maximum scan/fix rounds |
| `CODE_PASS_MAX_TOTAL_BUDGET` | `STRIX_MAX_BUDGET` or `50` | Total Strix budget split across rounds |
| `CODE_PASS_RUN_UI_MODE` | `auto` | `interactive` or `auto` |

## Safety and output

- Only scan projects you are authorized to inspect.
- `scan` works on a sanitized copy and does not modify the original project.
- `fix` may modify the selected project unless it is read-only.
- Output directories must be outside the project being scanned.
- Scan and Pi artifacts may contain source paths, vulnerability evidence, and
  remediation details; keep them private.
- No command automatically commits, pushes, deploys, or connects to a
  production system.

Common scan artifacts include `findings.sarif`,
`penetration_test_report.md`, `vulnerabilities.json`, `coverage.json`,
`vulnerabilities/`, `run.json`, `strix.log`, `scan-status.txt`, and attempt
logs. Pi artifacts include `prompt.md`, `pi-summary.md`, `changes.diff`,
`git-status-before.txt`, `git-status-after.txt`, and `metadata.txt`.

## Development

```bash
go test ./...
go test -race ./...
go vet ./...
go run . self-test
```

Exit codes are `0` for success, `1` for operational failure, `2` for invalid
arguments, and `3` when the bounded loop stops with findings or without
progress.
