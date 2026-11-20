# CodePass

CodePass 是一个基于 Strix 和 Pi 的本地授权代码安全审计与修复工作流，现已由 Go CLI 实现：

1. `scan` 将目标项目复制到隔离、清理后的工作区并执行 Strix 扫描。
2. `fix` 读取明确指定的 Strix 结果，使用 Pi 分诊发现并修复确认的问题。
3. `run` 编排有限轮次的“扫描 → 修复 → 再扫描”流程。

程序不会自动提交、推送或部署代码。

## 前置条件

- Go 1.22 或更高版本。
- macOS 或 Linux。
- Docker Engine 或 Docker Desktop，且 daemon 正在运行。
- Strix CLI 1.4.1 或更高版本，命令名为 `strix`，或设置 `STRIX_BIN`。
- Pi CLI，命令名为 `pi`，或设置 `PI_BIN`。
- Git；`run` 流程和 Pi 变更追踪需要 Git 工作树。

构建：

```bash
go build -o codepass .
```

## 使用

```bash
./codepass scan --auto /path/to/project quick
./codepass fix --auto /path/to/project /path/to/scan-result
./codepass run --auto /path/to/project quick
```

`scan` 默认进入交互模式，`fix` 默认进入交互模式，`run` 默认自动运行。可以显式使用 `--interactive` 或 `--auto`。

`fix` 接受结果目录、`.sarif` 文件或 `.md` 报告。目录须包含 `findings.sarif` 和 `penetration_test_report.md`。传入单个文件时，另一份文件须以标准名称放在同目录。
可写修复需要确认，使用 `--auto` 时同样如此。
Pi 正常退出后，项目验证仍为待验证。请审查变更并运行项目检查。

`run` 默认最多执行 3 轮。当扫描失败或不完整、没有发现问题、Pi 没有改动、同一 finding 指纹再次出现或达到轮数上限时停止。

只读修复分析：

```bash
PI_FIX_DRY_RUN=true ./codepass fix --auto /path/to/project /path/to/scan-result
```

## 使用本机安装的报告修复版

`PATH` 上的 `codepass` 提供单次报告修复。结果目录需要包含
`findings.sarif` 和 `penetration_test_report.md`。

```bash
# 只读分析
PI_FIX_DRY_RUN=true codepass fix --auto /path/to/project /path/to/results

# 确认可写修复
codepass fix /path/to/project /path/to/results

# 修复后检查 Go 项目
cd /path/to/project
git diff
go vet ./...
go test ./...
```

本机安装的报告修复版没有扫描、自动循环或轮数设置。

## 环境变量

扫描变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `STRIX_BIN` | `strix` 或 `~/.strix/bin/strix` | Strix 可执行文件 |
| `STRIX_OUTPUT_DIR` | `~/strix_runs` | 扫描输出根目录，必须位于目标项目之外 |
| `STRIX_RUN_ID` | 自动生成 | 运行 ID，只允许 ASCII 字母、数字、`.`、`_`、`-`，最多 48 个字符 |
| `STRIX_RUN_UI_MODE` | `interactive` | `interactive` 或 `auto` |
| `STRIX_SCAN_MODE` | `quick` | `quick`、`standard` 或 `deep` |
| `STRIX_MAX_BUDGET` | `50` | Strix 总预算 |
| `STRIX_TIMEOUT` | `9h30m` | 扫描总超时 |
| `STRIX_MAX_TURNS` | 按模式决定 | 每个 agent 的最大轮数 |
| `STRIX_NETWORK_RETRIES` | `1` | 自动模式下的传输重试次数，范围 `0` 到 `2` |
| `STRIX_KEEP_WORKSPACE` | `false` | 保留临时工作区 |
| `STRIX_FRONTEND_STATIC` | `false` | 强制执行纯静态分析 |

Pi 变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PI_BIN` | `pi` | Pi 可执行文件 |
| `PI_OUTPUT_DIR` | `~/pi_runs` | Pi 输出根目录，必须位于目标项目和扫描结果之外 |
| `PI_FIX_DRY_RUN` | `false` | 使用 Pi 只读工具，不修改文件 |
| `PI_FIX_ALLOW_BREAKING` | `true` | 允许必要的破坏性修复 |
| `PI_TIMEOUT` | 未设置 | 可选 Pi 超时 |

循环变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CODE_PASS_OUTPUT_DIR` | `~/code_pass_runs` | 循环输出根目录 |
| `CODE_PASS_MAX_ROUNDS` | `3` | 最大扫描/修复轮次 |
| `CODE_PASS_MAX_TOTAL_BUDGET` | `STRIX_MAX_BUDGET` 或 `50` | 在各轮之间分配的 Strix 总预算 |
| `CODE_PASS_RUN_UI_MODE` | `auto` | `interactive` 或 `auto` |

## 安全与输出

- 只审计你获授权的项目。
- `scan` 使用清理后的副本，不修改原始项目。
- `fix` 在非只读模式下可能修改指定项目。
- 输出目录必须位于被扫描项目之外。
- 扫描和 Pi 输出可能包含源码路径、漏洞证据和修复细节，请按敏感数据处理。
- 程序不会自动提交、推送、部署或连接生产系统。

常见扫描产物包括 `findings.sarif`、`penetration_test_report.md`、`vulnerabilities.json`、`coverage.json`、`vulnerabilities/`、`run.json`、`strix.log`、`scan-status.txt` 和 attempt 日志。Pi 产物包括 `prompt.md`、`pi-summary.md`、`changes.diff`、`git-status-before.txt`、`git-status-after.txt` 和 `metadata.txt`。

## 开发检查

```bash
go test ./...
go test -race ./...
go vet ./...
go run . self-test
```

退出码：`0` 表示成功，`1` 表示运行失败，`2` 表示参数错误，`3` 表示循环因仍有发现或没有进展而停止。
