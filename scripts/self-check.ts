/**
 * Runnable self-check for the pure logic in extensions/strix-core.ts.
 *
 *   node scripts/self-check.ts
 */
import assert from "node:assert/strict";
import {
  budgetPerAttempt,
  assistantCompletionError,
  buildFixPrompt,
  buildInstruction,
  completedRunError,
  fingerprintDigest,
  isBinaryHeader,
  isManagedInternalNetwork,
  parseArgs,
  parseDurationMs,
  parseResumeArgs,
  parseVersion,
  resolveFromCwd,
  resolveExecutablePath,
  sanitizeName,
  sarifFindings,
  shouldCopyEntry,
  shouldRequestFixConfirmation,
  shouldPruneEntry,
  stableStringify,
  tokenizeArgs,
  versionAtLeast,
} from "../extensions/strix-core.ts";

let checks = 0;
function check(name: string, run: () => void): void {
  run();
  checks++;
  console.log(`ok ${checks}: ${name}`);
}

check("tokenizeArgs honors quotes", () => {
  assert.deepEqual(tokenizeArgs('a "b c" \'d e\' --f=g'), ["a", "b c", "d e", "--f=g"]);
  assert.deepEqual(tokenizeArgs(""), []);
  assert.throws(() => tokenizeArgs('"unterminated'));
});

check("parseArgs defaults", () => {
  const options = parseArgs("", {});
  assert.deepEqual(options.errors, []);
  assert.equal(options.project, "");
  assert.equal(options.scanMode, "quick");
  assert.equal(options.scopeMode, "full");
  assert.equal(options.maxRounds, 3);
  assert.equal(options.maxTurns, 60);
  assert.equal(options.timeoutMs, 34_200_000);
  assert.equal(options.dryRun, false);
  assert.equal(options.yes, false);
});

check("parseArgs flags, positionals and quoting", () => {
  const options = parseArgs(
    '"/tmp/my project" deep --max-rounds 5 --max-budget 10 --max-turns 7 --dry-run --yes --instruction "focus on auth"',
    {},
  );
  assert.deepEqual(options.errors, []);
  assert.equal(options.project, "/tmp/my project");
  assert.equal(options.scanMode, "deep");
  assert.equal(options.maxRounds, 5);
  assert.equal(options.maxBudget, "10");
  assert.equal(options.maxTurns, 7);
  assert.equal(options.dryRun, true);
  assert.equal(options.yes, true);
  assert.equal(options.instruction, "focus on auth");
});

check("fix approval only gates fresh and pending rounds", () => {
  assert.equal(shouldRequestFixConfirmation("scan", false), true);
  assert.equal(shouldRequestFixConfirmation("awaiting_confirmation", false), true);
  assert.equal(shouldRequestFixConfirmation("prepare_fix", false), false);
  assert.equal(shouldRequestFixConfirmation("fix", false), false);
  assert.equal(shouldRequestFixConfirmation("fix_done", false), false);
  assert.equal(shouldRequestFixConfirmation("awaiting_confirmation", true), false);
});

check("parseArgs reports invalid input", () => {
  assert.ok(parseArgs("--bogus", {}).errors.some((item) => item.includes("unknown option")));
  assert.ok(parseArgs("proj nope", {}).errors.some((item) => item.includes("unknown scan mode")));
  assert.ok(
    parseArgs("--instruction a --instruction-file b", {}).errors.some((item) => item.includes("cannot be used together")),
  );
  assert.ok(parseArgs("--max-rounds 0", {}).errors.some((item) => item.includes("positive integer")));
  assert.ok(parseArgs("", { PI_FIX_DRY_RUN: "maybe" }).errors.some((item) => item.includes("must be true or false")));
});

check("parseResumeArgs supports approval bypass and output roots", () => {
  assert.deepEqual(parseResumeArgs('run-123 --yes --output-dir "/tmp/custom runs"'), {
    runId: "run-123",
    outputRoot: "/tmp/custom runs",
    yes: true,
    help: false,
  });
  assert.deepEqual(parseResumeArgs("--help"), { runId: "", outputRoot: undefined, yes: false, help: true });
  assert.throws(() => parseResumeArgs(""), /run-id is required/);
  assert.throws(() => parseResumeArgs("run-123 --unknown"), /unexpected argument/);
});

check("parseArgs reads environment defaults", () => {
  const options = parseArgs("", {
    STRIX_FIX_LOOP_MAX_ROUNDS: "4",
    STRIX_SCAN_MODE: "standard",
    STRIX_MAX_BUDGET: "12.5",
    STRIX_KEEP_WORKSPACE: "true",
    PI_FIX_ALLOW_BREAKING: "false",
  });
  assert.deepEqual(options.errors, []);
  assert.equal(options.maxRounds, 4);
  assert.equal(options.scanMode, "standard");
  assert.equal(options.maxTurns, 100);
  assert.equal(options.maxBudget, "12.5");
  assert.equal(options.keepWorkspace, true);
  assert.equal(options.allowBreaking, false);
});

check("parseDurationMs", () => {
  assert.equal(parseDurationMs("3600"), 3_600_000);
  assert.equal(parseDurationMs("1h30m"), 5_400_000);
  assert.equal(parseDurationMs("2.5s"), 2500);
  assert.throws(() => parseDurationMs("1x"));
  assert.throws(() => parseDurationMs("0"));
  assert.throws(() => parseDurationMs("720h"), /maximum timer delay/);
  assert.throws(() => parseDurationMs("2147483.648"), /maximum timer delay/);
});

check("budgetPerAttempt splits the total", () => {
  const perRound = Number(budgetPerAttempt("50", 3));
  assert.ok(Math.abs(perRound - 50 / 3) < 1e-9);
  assert.equal(budgetPerAttempt("1", 6), "0.166666666666");
  assert.ok(Number(budgetPerAttempt("1", 6)) * 6 <= 1);
  assert.ok(Number(budgetPerAttempt("0.000000000001", 3)) > 0);
  assert.throws(() => budgetPerAttempt("0", 3));
});

check("relative output paths resolve from Pi cwd", () => {
  assert.equal(resolveFromCwd("/pi/project", "artifacts"), "/pi/project/artifacts");
  assert.equal(resolveFromCwd("/pi/project", "/tmp/artifacts"), "/tmp/artifacts");
});

check("relative executable paths survive a child cwd change", () => {
  assert.equal(resolveExecutablePath("/pi/project", "bin/strix"), "/pi/project/bin/strix");
  assert.equal(resolveExecutablePath("/pi/project", "strix"), "strix");
});

check("SARIF findings ignore coverage and stay stable", () => {
  const document = {
    runs: [
      {
        results: [
          {
            ruleId: "R1",
            level: "warning",
            locations: [{ physicalLocation: { artifactLocation: { uri: "src/a.js" }, region: { startLine: 4 } } }],
            message: { text: "same finding" },
          },
          { ruleId: "strix-coverage/missing", level: "note" },
        ],
      },
    ],
  };
  const first = sarifFindings(document);
  const second = sarifFindings(JSON.parse(JSON.stringify(document)));
  assert.equal(first.total, 2);
  assert.equal(first.coverage, 1);
  assert.equal(first.fingerprints.length, 1);
  assert.deepEqual(first.fingerprints, second.fingerprints);
  assert.equal(fingerprintDigest(first.fingerprints), fingerprintDigest(second.fingerprints));
  assert.throws(() => sarifFindings({}));
});

check("SARIF identity includes tool, rule and artifact", () => {
  const partialFingerprints = { "primaryLocationLineHash/v1": "same-source-line" };
  const result = (ruleId: string, uri: string) => ({
    ruleId,
    partialFingerprints,
    locations: [{ physicalLocation: { artifactLocation: { uri } } }],
  });
  const parsed = sarifFindings({
    runs: [
      {
        tool: { driver: { name: "scanner-a" } },
        results: [result("R1", "src/a.ts"), result("R1", "src/a.ts"), result("R2", "src/a.ts")],
      },
      {
        tool: { driver: { name: "scanner-b" } },
        results: [
          result("R1", "src/a.ts"),
          result("R1", "src/b.ts"),
          { rule: { id: "R3" }, partialFingerprints, locations: [{ physicalLocation: { artifactLocation: { uri: "src/c.ts" } } }] },
        ],
      },
    ],
  });
  assert.equal(parsed.total, 6);
  assert.equal(parsed.fingerprints.length, 5);
});

check("completedRunError recognizes run.json states", () => {
  assert.equal(completedRunError({ status: "completed" }), null);
  assert.equal(completedRunError({ completed: true, scan_results: { success: true } }), null);
  assert.notEqual(completedRunError({ status: "running" }), null);
  assert.notEqual(completedRunError({ status: "completed", completed: false }), null);
  assert.notEqual(completedRunError({ completed: true, finished: false }), null);
  assert.notEqual(completedRunError({ status: "completed", scan_results: { scan_completed: false } }), null);
  assert.notEqual(completedRunError({}), null);
  assert.notEqual(completedRunError(null), null);
});

check("prune classification", () => {
  assert.equal(shouldPruneEntry("node_modules", true, false), true);
  assert.equal(shouldPruneEntry("target", true, false), true);
  assert.equal(shouldPruneEntry(".git", true, false), true);
  assert.equal(shouldPruneEntry(".env", false, false), true);
  assert.equal(shouldPruneEntry("logo.png", false, false), true);
  assert.equal(shouldPruneEntry("link", false, true), true);
  assert.equal(shouldPruneEntry("main.go", false, false), false);
  assert.equal(shouldPruneEntry("src", true, false), false);
});

check("copy filter excludes pruned paths and special files", () => {
  assert.equal(shouldCopyEntry(".git", true, false, false), false);
  assert.equal(shouldCopyEntry("node_modules", true, false, false), false);
  assert.equal(shouldCopyEntry("source.ts", false, true, false), true);
  assert.equal(shouldCopyEntry("link.ts", false, false, true), false);
  assert.equal(shouldCopyEntry("socket", false, false, false), false);
});

check("binary header detection", () => {
  assert.equal(isBinaryHeader(Uint8Array.from([0x7f, 0x45, 0x4c, 0x46])), true);
  assert.equal(isBinaryHeader(Uint8Array.from([0x4d, 0x5a, 0x90, 0x00])), true);
  assert.equal(isBinaryHeader(Buffer.from("%PDF")), true);
  assert.equal(isBinaryHeader(Uint8Array.from([0x50, 0x4b, 0x03, 0x04])), true);
  assert.equal(isBinaryHeader(Buffer.from([0xd0, 0xcf, 0x11, 0xe0])), true);
  assert.equal(isBinaryHeader(Buffer.from([0x00, 0x61, 0x73, 0x6d])), true);
  assert.equal(isBinaryHeader(Buffer.from("hello")), false);
  assert.equal(shouldPruneEntry("report.pdf", false, false), true);
  assert.equal(shouldPruneEntry("report.docx", false, false), true);
});

check("stableStringify sorts keys", () => {
  assert.equal(stableStringify({ b: 1, a: [{ d: 2, c: 3 }] }), '{"a":[{"c":3,"d":2}],"b":1}');
});

check("sanitizeName and versions", () => {
  assert.equal(sanitizeName("my project!!", 64), "my-project");
  assert.equal(sanitizeName("***", 8), "project");
  assert.deepEqual(parseVersion("strix 1.4.1"), [1, 4, 1]);
  assert.equal(versionAtLeast([1, 5, 0], [1, 4, 1]), true);
  assert.equal(versionAtLeast([1, 4, 0], [1, 4, 1]), false);
});

check("sandbox networks must be managed and internal", () => {
  assert.equal(isManagedInternalNetwork("true|true\n"), true);
  assert.equal(isManagedInternalNetwork("true|false\n"), false);
  assert.equal(isManagedInternalNetwork("false|true\n"), false);
});

check("incomplete Pi assistant runs are not treated as finished", () => {
  assert.equal(assistantCompletionError("stop", undefined), null);
  assert.equal(assistantCompletionError("error", "provider failed"), "error: provider failed");
  assert.equal(assistantCompletionError("aborted", undefined), "assistant stopped with aborted");
  assert.equal(assistantCompletionError("length", undefined), "assistant stopped with length");
});

check("instructions and fix prompt", () => {
  const instruction = buildInstruction({
    frontendStatic: true,
    coordinationOptimized: false,
    tokenOptimized: false,
    projectInstruction: "focus on src",
    userInstruction: "check auth",
  });
  assert.ok(instruction.includes("纯静态源代码审计"));
  assert.ok(instruction.includes("check auth"));
  assert.ok(instruction.includes("focus on src"));

  const readOnlyPrompt = buildFixPrompt({
    project: "/tmp/p",
    sarif: "/tmp/p/findings.sarif",
    report: "/tmp/p/report.md",
    dryRun: true,
    allowBreaking: true,
  });
  assert.ok(readOnlyPrompt.includes("只读模式"));
  assert.ok(readOnlyPrompt.includes("/tmp/p/findings.sarif"));

  const fixPrompt = buildFixPrompt({
    project: "/tmp/p",
    sarif: "/tmp/p/findings.sarif",
    report: "/tmp/p/report.md",
    dryRun: false,
    allowBreaking: true,
  });
  assert.ok(fixPrompt.includes("可以直接修改必要文件"));
});

console.log(`strix-fix-loop self-check: ok (${checks} checks)`);
