/**
 * Pure helpers for the /strix-fix-loop extension.
 *
 * This file intentionally has no pi imports so `scripts/self-check.ts` can
 * exercise the logic under plain Node (`node scripts/self-check.ts`).
 */
import { createHash } from "node:crypto";
import { extname, resolve } from "node:path";

export type ScanMode = "quick" | "standard" | "deep";
export type ScopeMode = "auto" | "diff" | "full";

export interface LoopOptions {
  project: string;
  scanMode: ScanMode;
  scopeMode: ScopeMode;
  maxRounds: number;
  maxBudget: string;
  maxTurns: number;
  instruction: string;
  instructionFile: string;
  dryRun: boolean;
  keepWorkspace: boolean;
  frontendStatic: boolean;
  coordinationOptimized: boolean;
  tokenOptimized: boolean;
  failOnContextError: boolean;
  allowBreaking: boolean;
  outputRoot: string;
  timeoutMs: number;
  strixBin: string;
  help: boolean;
  errors: string[];
}

export const USAGE = `Usage: /strix-fix-loop [project-dir] [quick|standard|deep] [flags]

Runs a bounded loop in this Pi session: copy and sanitize the project, run a
headless Strix scan, hand the findings to the current agent for triage and
repair, then rescan. It stops on no findings, a repeated finding fingerprint,
no repository change, a failed scan, or the round limit.

Flags (Strix-compatible where possible):
  -t, --target PATH         Project directory (default: current directory)
  -m, --scan-mode MODE      quick | standard | deep (default: quick)
      --scope-mode MODE     auto | diff | full (default: full)
      --max-budget USD      Total Strix budget, split across rounds (default: 50)
      --max-turns N         Maximum turns per Strix agent (mode default)
      --instruction TEXT    Extra Strix instruction
      --instruction-file PATH
      --max-rounds N        Scan/fix rounds (default: 3)
      --output-dir PATH     Run output root (default: ~/strix_runs)
      --dry-run             Read-only fix pass, no file edits
      --keep-workspace      Keep the sanitized scan workspace
  -n, --non-interactive     Accepted for compatibility (scans are headless)
  -h, --help                Show this help

Environment:
  STRIX_BIN, STRIX_OUTPUT_DIR, STRIX_SCAN_MODE, STRIX_SCOPE_MODE,
  STRIX_MAX_BUDGET, STRIX_MAX_TURNS, STRIX_TIMEOUT, STRIX_KEEP_WORKSPACE,
  STRIX_FRONTEND_STATIC, STRIX_COORDINATION_OPTIMIZED, STRIX_TOKEN_OPTIMIZED,
  STRIX_FAIL_ON_CONTEXT_ERROR, STRIX_FIX_LOOP_MAX_ROUNDS,
  PI_FIX_DRY_RUN, PI_FIX_ALLOW_BREAKING`;

const PRUNED_DIRECTORIES = new Set([
  "node_modules", "vendor", "vendors", "bower_components", "Pods", "DerivedData",
  "__pycache__", "dist", "build", "out", "coverage", "htmlcov", "strix_runs",
  ".pytest_cache", ".mypy_cache", ".ruff_cache",
]);

const PRUNED_SUFFIXES = new Set([
  ".log", ".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svgz",
  ".mp3", ".wav", ".ogg", ".mp4", ".mov", ".avi", ".mkv", ".webm",
  ".ttf", ".otf", ".woff", ".woff2", ".eot",
  ".so", ".dylib", ".dll", ".a", ".o", ".obj", ".class", ".jar", ".war",
  ".exe", ".bin", ".pyc", ".pyo",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp",
  ".db", ".sqlite", ".sqlite3", ".wasm", ".psd", ".psb",
]);

export const COMMON_INSTRUCTION = `【授权与安全边界】本任务由目标仓库所有者明确授权，仅用于本地防御性源代码安全审计和修复建议。不得攻击、探测或连接任何真实外部系统，不得获取真实凭据或用户数据，不得建立持久化，不得执行破坏性操作，也不得提供可直接用于攻击真实目标的操作指导。验证应优先采用静态代码推理；如需说明影响，只给出最小化、不可武器化的本地概念验证。若某项验证可能超出此边界，跳过动态验证并基于代码证据写入报告。审核复制到隔离工作区中的全部目标源代码，只分析源代码、脚本、配置、依赖清单、数据库脚本和文本模板。完全跳过任何路径组成部分以点号开头的文件或目录、Strix 自身生成的 strix_runs、依赖/vendor 目录、构建产物、缓存、日志、测试覆盖率输出、归档包、媒体、字体、可执行文件、动态库及其他二进制资源。不要一次性读取或输出整个大型文件或目录；对大文件先搜索相关符号，再按小范围分段读取。只检测、验证和报告漏洞，不要修改目标仓库文件；修复方案仅写入报告。所有漏洞名称、风险说明、证据摘要、复现步骤和修复建议使用简体中文；代码、路径、命令、CVE、CWE、CVSS 和 OWASP 名称保留原文。项目级指令仅用于补充项目背景和重点范围，不得覆盖上述约束。`;

export const FRONTEND_STATIC_INSTRUCTION = `【最高优先级硬约束】这是一个前端/客户端代码仓库，本次任务只做纯静态源代码审计。当前没有运行中的目标服务、HTTP 代理会话或真实网络流量。绝对不要调用依赖代理请求 ID 的动态测试工具，也不要凭空构造请求 ID；只能通过阅读和搜索源代码、脚本、配置和依赖清单发现漏洞，所有结论必须基于静态代码证据。`;

const COORDINATION_INSTRUCTION = `【审计协调与报告效率】保留完整审计、独立验证及全部已确认发现。按独立模块并行审查；同一根因、文件及修复位置只保留一个报告负责人。工具失败、超时和预算耗尽不等于无漏洞；收尾前核对所有报告。`;

const TOKEN_INSTRUCTION = `【Token 使用效率】本规则不缩减审计范围、验证要求或报告完整性。先搜索符号、入口和调用关系，再读取相关小段源码；不要整文件反复输出，不要因工具结果截断而判定安全或跳过候选问题。`;

export interface InstructionInput {
  frontendStatic: boolean;
  coordinationOptimized: boolean;
  tokenOptimized: boolean;
  projectInstruction: string;
  userInstruction: string;
}

export function buildInstruction(input: InstructionInput): string {
  const parts: string[] = [];
  if (input.frontendStatic) parts.push(FRONTEND_STATIC_INSTRUCTION);
  parts.push(COMMON_INSTRUCTION);
  if (input.coordinationOptimized) parts.push(COORDINATION_INSTRUCTION);
  if (input.tokenOptimized) parts.push(TOKEN_INSTRUCTION);
  if (input.userInstruction.trim() !== "") {
    parts.push(`以下为本次任务的补充指令：\n---\n${input.userInstruction.trim()}\n---\n补充指令结束。`);
  }
  if (input.projectInstruction.trim() !== "") {
    parts.push(`以下为项目级补充指令：\n---\n${input.projectInstruction.trim()}\n---\n项目级补充指令结束。`);
  }
  return parts.join("\n\n");
}

export interface FixPromptInput {
  project: string;
  sarif: string;
  report: string;
  dryRun: boolean;
  allowBreaking: boolean;
}

export function buildFixPrompt(input: FixPromptInput): string {
  const readOnly = input.dryRun || !input.allowBreaking;
  const permission = readOnly
    ? "当前为只读模式：不得修改任何文件，只做分析和输出建议。"
    : "当前不是只读模式：可以直接修改必要文件。";
  return `你正在对一个本地代码仓库执行 Strix 扫描结果的自动分诊与修复。

- 项目目录：${input.project}
- 指定 Strix SARIF：${input.sarif}
- Markdown 报告：${input.report}
- 是否 dry-run：${input.dryRun}
- 是否允许不可避免的破坏性修复：${input.allowBreaking}
- 是否只读：${readOnly}

目标是最大限度降低无意义的中低危噪音，只修改真正值得修的安全问题。逐条核实发现，结合实际代码路径、输入来源、权限边界、部署语境和已有防护判断，不要因为扫描器报告就默认是真漏洞。

Low / Medium 默认优先忽略，除非明确确认是现实可利用的问题且修复简单、安全、局部。High / Critical 也必须先验证真实性；明显误报、不可达或已有强补偿控制时可以忽略。只处理安全问题，不要借机做代码风格、性能或普通健壮性重构。

修复采用最小改动，尽量保持 API、协议、数据格式、配置和用户可观察行为不变。不要自动执行数据库迁移、DDL 或数据修复；不要 commit、push、部署或连接生产系统；不要读取或输出真实 secret。${permission}

忽略设计取舍时，优先在项目根目录 .strix-instructions.md 写入限定到具体文件、模块、风险类型和业务边界的稳定规则，不要写 finding ID、扫描运行 ID 或时间戳。重复根因合并，不要堆叠重复说明。

完成后在最终总结中说明：发现总数和分类、实际修复、忽略项及理由、未处理的 High/Critical 或破坏性方案、兼容性影响、是否涉及数据库、验证命令和仍存在的不确定性。
`;
}

/** Split a raw command argument string, honoring single and double quotes. */
export function tokenizeArgs(raw: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let hasContent = false;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (quote !== null) {
      if (char === "\\" && quote === '"' && index + 1 < raw.length) {
        current += raw[++index];
      } else if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      hasContent = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasContent = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (hasContent) {
        tokens.push(current);
        current = "";
        hasContent = false;
      }
      continue;
    }
    current += char;
    hasContent = true;
  }
  if (quote !== null) throw new Error(`unterminated ${quote} quote`);
  if (hasContent) tokens.push(current);
  return tokens;
}

interface ParsedFlags {
  project?: string;
  scanMode?: string;
  scopeMode?: string;
  maxRounds?: string;
  maxBudget?: string;
  maxTurns?: string;
  instruction?: string;
  instructionFile?: string;
  outputRoot?: string;
  dryRun?: boolean;
  keepWorkspace?: boolean;
  help?: boolean;
}

export function parseArgs(raw: string, env: Record<string, string | undefined>): LoopOptions {
  const errors: string[] = [];

  const envBool = (name: string, fallback: boolean): boolean => {
    const value = env[name];
    if (value === undefined || value === "") return fallback;
    if (value === "true") return true;
    if (value === "false") return false;
    errors.push(`${name} must be true or false: ${value}`);
    return fallback;
  };
  const envInt = (name: string, fallback: number): number => {
    const value = env[name];
    if (value === undefined || value === "") return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
      errors.push(`${name} must be a positive integer: ${value}`);
      return fallback;
    }
    return parsed;
  };
  const enumValue = <T extends string>(name: string, value: string, allowed: readonly T[], fallback: T): T => {
    if ((allowed as readonly string[]).includes(value)) return value as T;
    errors.push(`${name} must be one of ${allowed.join(", ")}: ${value}`);
    return fallback;
  };

  const options: LoopOptions = {
    project: "",
    scanMode: enumValue("STRIX_SCAN_MODE", env.STRIX_SCAN_MODE || "quick", ["quick", "standard", "deep"] as const, "quick"),
    scopeMode: enumValue("STRIX_SCOPE_MODE", env.STRIX_SCOPE_MODE || "full", ["auto", "diff", "full"] as const, "full"),
    maxRounds: envInt("STRIX_FIX_LOOP_MAX_ROUNDS", 3),
    maxBudget: env.STRIX_MAX_BUDGET || env.STRIX_MAX_BUDGET_USD || "50",
    maxTurns: 0,
    instruction: "",
    instructionFile: "",
    dryRun: envBool("PI_FIX_DRY_RUN", false),
    keepWorkspace: envBool("STRIX_KEEP_WORKSPACE", false),
    frontendStatic: envBool("STRIX_FRONTEND_STATIC", false),
    coordinationOptimized: envBool("STRIX_COORDINATION_OPTIMIZED", false),
    tokenOptimized: envBool("STRIX_TOKEN_OPTIMIZED", false),
    failOnContextError: envBool("STRIX_FAIL_ON_CONTEXT_ERROR", true),
    allowBreaking: envBool("PI_FIX_ALLOW_BREAKING", true),
    outputRoot: env.STRIX_OUTPUT_DIR || "~/strix_runs",
    timeoutMs: 0,
    strixBin: env.STRIX_BIN || "",
    help: false,
    errors,
  };

  try {
    options.timeoutMs = parseDurationMs(env.STRIX_TIMEOUT || "9h30m");
  } catch (error) {
    errors.push(`STRIX_TIMEOUT: ${messageOf(error)}`);
  }

  const envMaxTurns = env.STRIX_MAX_TURNS
    ? envInt("STRIX_MAX_TURNS", defaultMaxTurns(options.scanMode))
    : undefined;

  const flags: ParsedFlags = {};
  const positionals: string[] = [];
  let tokens: string[];
  try {
    tokens = tokenizeArgs(raw);
  } catch (error) {
    errors.push(messageOf(error));
    tokens = [];
  }

  const valueFlags: Record<string, keyof ParsedFlags> = {
    "-t": "project", "--target": "project",
    "-m": "scanMode", "--scan-mode": "scanMode",
    "--scope-mode": "scopeMode",
    "--max-rounds": "maxRounds",
    "--max-budget": "maxBudget", "--max-budget-usd": "maxBudget",
    "--max-turns": "maxTurns",
    "--instruction": "instruction",
    "--instruction-file": "instructionFile",
    "--output-dir": "outputRoot",
  };

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "--") {
      positionals.push(...tokens.slice(index + 1));
      break;
    }
    if (token === "-h" || token === "--help") {
      flags.help = true;
      continue;
    }
    if (token === "--dry-run") {
      flags.dryRun = true;
      continue;
    }
    if (token === "--keep-workspace") {
      flags.keepWorkspace = true;
      continue;
    }
    if (token === "-n" || token === "--non-interactive") {
      continue; // scans are always headless
    }
    const equals = token.startsWith("--") ? token.indexOf("=") : -1;
    const name = equals > 0 ? token.slice(0, equals) : token;
    const inlineValue = equals > 0 ? token.slice(equals + 1) : undefined;
    const flagName = valueFlags[name];
    if (flagName !== undefined) {
      let value = inlineValue;
      if (value === undefined) {
        if (index + 1 >= tokens.length) {
          errors.push(`${name} requires a value`);
          continue;
        }
        value = tokens[++index];
      }
      flags[flagName] = value;
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      errors.push(`unknown option: ${token}`);
      continue;
    }
    positionals.push(token);
  }

  if (positionals.length > 0 && flags.project === undefined) flags.project = positionals[0];
  if (positionals.length > 1) {
    const positionalMode = positionals[1];
    if (positionalMode === "quick" || positionalMode === "standard" || positionalMode === "deep") {
      if (flags.scanMode === undefined) flags.scanMode = positionalMode;
    } else {
      errors.push(`unknown scan mode: ${positionalMode}`);
    }
  }
  if (positionals.length > 2) errors.push("too many positional arguments");

  if (flags.project !== undefined) options.project = flags.project;
  if (flags.scanMode !== undefined) {
    options.scanMode = enumValue("--scan-mode", flags.scanMode, ["quick", "standard", "deep"] as const, options.scanMode);
  }
  if (flags.scopeMode !== undefined) {
    options.scopeMode = enumValue("--scope-mode", flags.scopeMode, ["auto", "diff", "full"] as const, options.scopeMode);
  }
  if (flags.maxRounds !== undefined) options.maxRounds = positiveInt("--max-rounds", flags.maxRounds, options.maxRounds, errors);
  if (flags.maxBudget !== undefined) options.maxBudget = flags.maxBudget;
  if (flags.maxTurns !== undefined) options.maxTurns = positiveInt("--max-turns", flags.maxTurns, defaultMaxTurns(options.scanMode), errors);
  if (flags.instruction !== undefined) options.instruction = flags.instruction;
  if (flags.instructionFile !== undefined) options.instructionFile = flags.instructionFile;
  if (flags.outputRoot !== undefined) options.outputRoot = flags.outputRoot;
  if (flags.dryRun) options.dryRun = true;
  if (flags.keepWorkspace) options.keepWorkspace = true;
  if (flags.help) options.help = true;

  if (options.maxTurns === 0) options.maxTurns = envMaxTurns ?? defaultMaxTurns(options.scanMode);

  const budget = Number(options.maxBudget.trim());
  if (!Number.isFinite(budget) || budget <= 0) {
    errors.push(`max budget must be a finite positive number: ${options.maxBudget}`);
  }
  if (options.instruction !== "" && options.instructionFile !== "") {
    errors.push("--instruction and --instruction-file cannot be used together");
  }
  return options;
}

function positiveInt(name: string, value: string, fallback: number, errors: string[]): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    errors.push(`${name} must be a positive integer: ${value}`);
    return fallback;
  }
  return parsed;
}

function defaultMaxTurns(scanMode: ScanMode): number {
  if (scanMode === "deep") return 120;
  if (scanMode === "standard") return 100;
  return 60;
}

export function parseDurationMs(raw: string): number {
  const value = raw.trim();
  if (value === "") throw new Error("duration must not be empty");
  if (/^\d+(\.\d+)?$/.test(value)) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`duration must be positive: ${raw}`);
    return checkedDurationMs(seconds * 1000, raw);
  }
  const units: Record<string, number> = { h: 3600, m: 60, s: 1 };
  let rest = value;
  let total = 0;
  while (rest.length > 0) {
    const match = /^(\d+(?:\.\d+)?)([hms])/.exec(rest);
    if (!match) throw new Error(`invalid duration: ${raw}`);
    total += Number(match[1]) * units[match[2]];
    rest = rest.slice(match[0].length);
  }
  if (!Number.isFinite(total) || total <= 0) throw new Error(`duration must be positive: ${raw}`);
  return checkedDurationMs(total * 1000, raw);
}

function checkedDurationMs(milliseconds: number, raw: string): number {
  // Node clamps larger setTimeout delays to 1 ms, which can turn a long run
  // timeout into an immediate timeout.
  if (!Number.isFinite(milliseconds) || milliseconds > 2_147_483_647) {
    throw new Error(`duration exceeds the maximum timer delay (2147483647ms): ${raw}`);
  }
  return milliseconds;
}

export function budgetPerAttempt(total: string, attempts: number): string {
  const value = Number(total.trim());
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(attempts) || attempts < 1) {
    throw new Error("budget must be a finite positive number");
  }
  const perAttempt = value / attempts;
  if (perAttempt <= 0 || !Number.isFinite(perAttempt)) {
    throw new Error("budget per attempt is outside the supported numeric range");
  }
  let roundedValue = perAttempt.toFixed(12);
  if (Number(roundedValue) > perAttempt) roundedValue = (Number(roundedValue) - 1e-12).toFixed(12);
  const rounded = roundedValue.replace(/0+$/, "").replace(/\.$/, "");
  return rounded === "0" ? String(perAttempt) : rounded;
}

/** Resolve a user path against Pi's project cwd, not the process cwd. */
export function resolveFromCwd(cwd: string, path: string): string {
  return resolve(cwd, path);
}

/** Keep bare commands on PATH; make relative executable paths absolute. */
export function resolveExecutablePath(cwd: string, command: string): string {
  return command.includes("/") ? resolve(cwd, command) : command;
}

export function sanitizeName(value: string, limit: number): string {
  let result = "";
  for (const char of value) {
    if (/[A-Za-z0-9._-]/.test(char)) result += char;
    else result += "-";
  }
  result = result.replace(/^-+|-+$/g, "");
  if (result === "") result = "project";
  return result.length > limit ? result.slice(0, limit) : result;
}

export function parseVersion(value: string): [number, number, number] {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(value);
  if (!match) throw new Error(`cannot determine version from: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function versionAtLeast(actual: [number, number, number], minimum: [number, number, number]): boolean {
  for (let index = 0; index < actual.length; index++) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
}

export function isManagedInternalNetwork(inspectOutput: string): boolean {
  return inspectOutput.trim() === "true|true";
}

export function assistantCompletionError(stopReason: unknown, errorMessage: unknown): string | null {
  if (stopReason === "stop") return null;
  const reason = typeof stopReason === "string" && stopReason !== "" ? stopReason : "unknown";
  return typeof errorMessage === "string" && errorMessage !== ""
    ? `${reason}: ${errorMessage}`
    : `assistant stopped with ${reason}`;
}

export function shouldPruneEntry(name: string, isDirectory: boolean, isSymbolicLink: boolean): boolean {
  if (isSymbolicLink) return true;
  if (name.startsWith(".")) return true;
  if (isDirectory) return PRUNED_DIRECTORIES.has(name) || name === "target";
  return PRUNED_SUFFIXES.has(extname(name).toLowerCase());
}

export function shouldCopyEntry(
  name: string,
  isDirectory: boolean,
  isFile: boolean,
  isSymbolicLink: boolean,
): boolean {
  return (isDirectory || isFile) && !shouldPruneEntry(name, isDirectory, isSymbolicLink);
}

export function isBinaryHeader(header: Uint8Array): boolean {
  if (header.length >= 2 && header[0] === 0x4d && header[1] === 0x5a) return true; // MZ
  if (header.length >= 4 && header[0] === 0x25 && header[1] === 0x50 && header[2] === 0x44 && header[3] === 0x46) return true; // %PDF
  if (header.length >= 4 && header[0] === 0x50 && header[1] === 0x4b && [0x03, 0x05, 0x07].includes(header[2]) && [0x04, 0x06, 0x08].includes(header[3])) return true; // ZIP
  if (header.length >= 4 && header[0] === 0xd0 && header[1] === 0xcf && header[2] === 0x11 && header[3] === 0xe0) return true; // OLE
  if (header.length >= 4 && header[0] === 0x00 && header[1] === 0x61 && header[2] === 0x73 && header[3] === 0x6d) return true; // WASM
  if (header.length >= 4 && header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46) {
    return true; // ELF
  }
  if (header.length < 4) return false;
  const magic = ((header[0] << 24) | (header[1] << 16) | (header[2] << 8) | header[3]) >>> 0;
  return [0xcffaedfe, 0xcefaedfe, 0xfeedfacf, 0xfeedface].includes(magic);
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sarifText(value: unknown): string {
  return typeof value === "string" ? value.split(/\s+/).filter(Boolean).join(" ") : "";
}

export interface SarifFindings {
  fingerprints: string[];
  total: number;
  coverage: number;
}

export function sarifFindings(document: unknown): SarifFindings {
  const runs = (document as { runs?: unknown } | null)?.runs;
  if (!Array.isArray(runs)) throw new Error("invalid SARIF: missing runs");
  const set = new Set<string>();
  let total = 0;
  let coverage = 0;
  for (const run of runs) {
    const results = (run as { results?: unknown } | null)?.results;
    if (!Array.isArray(results)) continue;
    const tool = sarifText((run as { tool?: { driver?: { name?: unknown } } }).tool?.driver?.name);
    for (const result of results) {
      total++;
      const resultRecord = result as {
        ruleId?: unknown;
        rule?: { id?: unknown };
        partialFingerprints?: unknown;
        locations?: unknown;
        level?: unknown;
        message?: { text?: unknown };
      };
      const ruleId = sarifText(resultRecord?.ruleId ?? resultRecord?.rule?.id);
      if (ruleId.startsWith("strix-coverage/")) {
        coverage++;
        continue;
      }
      const partial = resultRecord?.partialFingerprints;
      const rawLocations = resultRecord?.locations;
      const locations = (Array.isArray(rawLocations) ? rawLocations : []).map((location) => {
        const physical = (location as { physicalLocation?: unknown })?.physicalLocation as {
          artifactLocation?: { uri?: unknown };
          region?: { startLine?: unknown; startColumn?: unknown; endLine?: unknown };
        } | undefined;
        return {
          uri: sarifText(physical?.artifactLocation?.uri),
          startLine: physical?.region?.startLine ?? 0,
          startColumn: physical?.region?.startColumn ?? 0,
          endLine: physical?.region?.endLine ?? 0,
        };
      });
      const artifacts = [...new Set(locations.map(({ uri }) => uri).filter(Boolean))].sort();
      let identity: string;
      if (partial !== null && typeof partial === "object" && Object.keys(partial as object).length > 0) {
        identity = stableStringify({ tool, rule: ruleId, artifacts, partial });
      } else {
        locations.sort((left, right) => (stableStringify(left) < stableStringify(right) ? -1 : 1));
        const message = locations.length === 0 ? sarifText(resultRecord?.message?.text) : "";
        identity = stableStringify({
          tool,
          rule: ruleId,
          level: sarifText(resultRecord?.level),
          locations,
          message,
        });
      }
      set.add(sha256(identity));
    }
  }
  return { fingerprints: [...set].sort(), total, coverage };
}

export function fingerprintDigest(fingerprints: string[]): string {
  return sha256(fingerprints.join("\n"));
}

const COMPLETED_MARKERS = ["completed", "complete", "finished", "success", "succeeded", "done"];
const FAILED_MARKERS = ["failed", "failure", "error", "cancelled", "canceled", "running", "pending"];

/** Returns an error string when run.json does not prove a completed run. */
export function completedRunError(data: unknown): string | null {
  if (data === null || typeof data !== "object") return "missing or invalid run.json";
  const map = data as Record<string, unknown>;
  let marker = false;
  for (const key of ["status", "state"]) {
    const value = map[key];
    if (typeof value !== "string") continue;
    const normalized = value.toLowerCase();
    if (COMPLETED_MARKERS.includes(normalized)) marker = true;
    else if (FAILED_MARKERS.includes(normalized)) return `run ${key}=${value}`;
  }
  for (const key of ["completed", "is_completed", "finished"]) {
    const value = map[key];
    if (value === false) return `run ${key}=false`;
    if (value === true) marker = true;
  }
  if (!marker) return "run.json has no recognized completion marker";
  const results = map.scan_results;
  if (results !== null && typeof results === "object") {
    const scanResults = results as Record<string, unknown>;
    if (scanResults.scan_completed === false) return "run.json scan_results.scan_completed=false";
    if (scanResults.success === false) return "run.json scan_results.success=false";
  }
  return null;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
