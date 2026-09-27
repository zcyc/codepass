# CodePass

Pi 扩展 `/strix-fix-loop`：在当前 Pi 会话内执行本地授权的 Strix 扫描 → Pi 修复 → 再扫描循环。

[English](README.md)

## 它做什么

一条命令，无需手动传入扫描产物：

1. 将项目复制到清理后的临时工作区；
2. 在每轮独立的 Docker 网络中执行无界面 Strix 扫描；
3. 将该轮的 `findings.sarif` 和报告交给当前 Pi agent 分诊与修复；
4. 再次扫描并循环，直到满足停止条件。

扩展不会自动提交、推送或部署代码。

| 停止条件 | 结果 |
| --- | --- |
| 扫描失败或不完整 | `scan_failed` |
| 没有发现问题 | `pass` |
| 修复后同一 finding 指纹再次出现 | `stalled` |
| Pi 没有改动仓库 | `stalled` |
| 达到轮数上限 | `round_limit` |

## 快速开始

```bash
pi -e /path/to/codepass
```

```text
/strix-fix-loop ~/src/my-app
```

不需要传入扫描结果目录：每轮 Strix 结束后会自动定位本轮结果并交给 agent 修复。

## 前置条件

- macOS 或 Linux。
- Docker Engine 或 Docker Desktop，且 daemon 正在运行。
- Strix CLI 1.5.2+：`strix` 在 `PATH`、`~/.strix/bin/strix`，或通过 `STRIX_BIN` 指定。
- 目标项目是 Git 工作树（用于变更追踪）。
- Pi。

## 安装

| 方式 | 命令 |
| --- | --- |
| 临时运行一次 | `pi -e /path/to/codepass` |
| 作为 Pi 包安装 | `pi install /path/to/codepass` |
| 复制为全局扩展 | `cp extensions/strix-fix-loop.ts extensions/strix-core.ts ~/.pi/agent/extensions/` |

## 使用

```text
/strix-fix-loop [项目目录] [quick|standard|deep] [选项]
```

```text
/strix-fix-loop                                      # 当前目录，quick，3 轮
/strix-fix-loop ~/src/my-app standard
/strix-fix-loop ~/src/my-app deep --max-rounds 2 --max-budget 20
/strix-fix-loop ~/src/my-app --instruction "重点检查认证"
PI_FIX_DRY_RUN=true /strix-fix-loop ~/src/my-app     # 只读分诊
```

如果 Pi 或 Strix 中途退出，在同一 Pi 会话中执行 `pi --continue`，再用运行目录名恢复：

```text
/strix-resume my-app-20260924-162025-81334
```

`run-id` 是输出目录的最后一段，也会显示在 `/strix-fix-loop` 的会话记录标题中。自定义输出目录且会话记录不可用时，可追加 `--output-dir PATH`。

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `-t`, `--target PATH` | 当前目录 | 项目目录 |
| `-m`, `--scan-mode MODE` | `quick` | `quick`、`standard` 或 `deep` |
| `--scope-mode MODE` | `full` | `auto`、`diff` 或 `full` |
| `--max-budget USD` | `50` | Strix 总预算，按轮次拆分 |
| `--max-turns N` | 按模式决定 | 每个 Strix agent 的最大轮数 |
| `--instruction TEXT` | 未设置 | 额外的 Strix 指令 |
| `--instruction-file PATH` | 未设置 | 从文件读取指令（上限 64 KiB） |
| `--max-rounds N` | `3` | 最大扫描/修复轮次 |
| `--output-dir PATH` | `~/strix_runs` | 运行输出根目录，必须位于项目之外 |
| `--dry-run` | `false` | 只读修复分析，不修改文件 |
| `--keep-workspace` | `false` | 保留清理后的扫描工作区 |
| `-n`, `--non-interactive` | — | 兼容参数；扫描始终无界面运行 |
| `-h`, `--help` | — | 在会话记录中显示帮助 |

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `STRIX_BIN` | `strix` / `~/.strix/bin/strix` | Strix 可执行文件 |
| `STRIX_OUTPUT_DIR` | `~/strix_runs` | 运行输出根目录，必须位于项目之外 |
| `STRIX_SCAN_MODE` | `quick` | `quick`、`standard` 或 `deep` |
| `STRIX_SCOPE_MODE` | `full` | `auto`、`diff` 或 `full` |
| `STRIX_MAX_BUDGET` / `STRIX_MAX_BUDGET_USD` | `50` | Strix 总预算 |
| `STRIX_MAX_TURNS` | 按模式决定 | 每个 Strix agent 的最大轮数 |
| `STRIX_TIMEOUT` | `9h30m` | 每轮扫描超时 |
| `STRIX_FIX_LOOP_MAX_ROUNDS` | `3` | 最大扫描/修复轮次 |
| `STRIX_KEEP_WORKSPACE` | `false` | 保留临时工作区 |
| `STRIX_FRONTEND_STATIC` | `false` | 强制执行纯静态分析 |
| `STRIX_COORDINATION_OPTIMIZED` | `false` | 在扫描指令中加入审计协调要求 |
| `STRIX_TOKEN_OPTIMIZED` | `false` | 在扫描指令中加入 Token 效率要求 |
| `STRIX_FAIL_ON_CONTEXT_ERROR` | `true` | 将上下文窗口错误视为扫描失败 |
| `STRIX_SANDBOX_CPUS` | `2` | Docker 沙箱 CPU 限制 |
| `STRIX_SANDBOX_MEM_LIMIT` | `3g` | Docker 沙箱内存限制 |
| `STRIX_SANDBOX_PIDS_LIMIT` | `1024` | Docker 沙箱 PID 限制 |
| `STRIX_SANDBOX_SHM_SIZE` | `1g` | Docker 沙箱共享内存大小 |
| `PI_FIX_DRY_RUN` | `false` | 只读修复分析，不修改文件 |
| `PI_FIX_ALLOW_BREAKING` | `true` | 允许必要的破坏性修复 |

## 每轮流程

**扫描**

- 项目复制到本次运行目录的 `strix/round-N/workspace/target`，并删除 `.git`、点号文件/目录、依赖与构建目录、归档包、媒体和二进制文件，使 Strix 只看到源代码、脚本、配置、依赖清单、数据库脚本和文本模板。扫描完成后按选项清理副本；中断时保留以供 Strix 续跑。
- 每轮创建独立的 Docker 网络（`strix-managed=true`），结束后删除；沙箱资源由 `STRIX_SANDBOX_*` 限制。
- Strix 以无界面方式运行，并注入本地、防御性、只读的审计指令。
- 只有同时满足以下条件才判定扫描成功：`run.json` 证明运行完成；同一运行目录下恰好有一个 `findings.sarif` 和一个 `penetration_test_report.md`；SARIF 可解析；日志中没有上下文窗口、运行时或内容过滤错误标记。

**修复**

- 修复提示词发送到当前 Pi 会话（`pi.sendUserMessage`），并等待该轮结束。
- 通过临时 Git 索引记录变更，因此 `changes.diff` 也包含新增的未跟踪文件。
- `--dry-run`（或 `PI_FIX_ALLOW_BREAKING=false`）时该轮只保留只读工具。

**恢复**

- `loop-state.json` 持久化当前阶段、轮次、Pi 会话文件和 Strix run 名称。
- `/strix-resume <run-id>` 会续跑未完成的 Strix 扫描，或在恢复的 Pi 会话中继续未完成的修复，再进入下一轮。
- 同一个运行目录只能在原 Pi 会话中恢复；使用启动任务的会话执行 `pi --continue`。

## 输出

每次运行写入 `<输出根目录>/<项目名>-<时间戳>-<pid>/`：

```text
~/strix_runs/my-app-20260921-162025-81334/
├── loop-state.json             # Pi/Strix 阶段检查点
├── summary.md                  # 逐轮日志
├── findings-round-N.txt        # 每轮稳定的 finding 指纹
├── strix/round-N/
│   ├── findings.sarif
│   ├── penetration_test_report.md
│   ├── run.json
│   ├── instruction.md
│   ├── scan-status.txt
│   ├── strix.log
│   ├── strix-console.log
│   └── workspace/target/       # 扫描期间保留；成功后按选项清理
└── pi/round-N/
    ├── prompt.md
    ├── git-status-before.txt
    ├── git-status-after.txt
    └── changes.diff
```

## 安全

- 只审计你获授权的项目。
- 扫描使用清理后的隔离副本；只有修复阶段会修改原始项目。
- 不会自动提交、推送、部署或连接生产系统。
- 扫描和 Pi 产物可能包含源码路径、漏洞证据和修复细节，请按敏感数据处理。

## 开发检查

```bash
npm run check   # node scripts/self-check.ts
```

自检覆盖参数解析、时长与预算处理、SARIF 指纹、清理规则、`run.json` 校验和提示词构造。
