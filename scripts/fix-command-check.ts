/** Exercise the command without a running Pi session or installed Pi peers. */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@earendil-works/pi-tui") {
      return { url: "data:text/javascript,export class Box {}; export class Text {}", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { default: install } = await import("../extensions/strix-fix-loop.ts");
hooks.deregister();
const root = await fs.mkdtemp(join(tmpdir(), "strix-fix-check-"));
try {
  const sarif = join(root, "findings.sarif");
  const report = join(root, "penetration_test_report.md");
  await fs.writeFile(sarif, JSON.stringify({ runs: [{ results: [{ ruleId: "test", message: { text: "test" } }] }] }));
  await fs.writeFile(report, "# CI report");
  const commands = new Map();
  const events = new Map();
  const notifications: string[] = [];
  let tools = ["read", "bash", "edit"];
  let prompt = "";
  let confirmation = true;
  let confirmations = 0;
  let failAgent = false;
  const pi = {
    registerEntryRenderer() {},
    registerCommand(name, command) { commands.set(name, command); },
    on(name, callback) {
      const listeners = events.get(name) ?? new Set();
      listeners.add(callback);
      events.set(name, listeners);
      return () => listeners.delete(callback);
    },
    appendEntry() {},
    getActiveTools() { return tools; },
    setActiveTools(value) { tools = value; },
    sendUserMessage(value) {
      prompt = value;
      if (value.includes("是否 dry-run：true")) assert.deepEqual(tools, ["read"]);
      for (const cb of events.get("agent_start") ?? []) cb();
      for (const cb of events.get("message_end") ?? []) cb({ message: { role: "assistant", stopReason: failAgent ? "error" : "stop" } });
      for (const cb of events.get("agent_settled") ?? []) cb();
    },
  };
  const ctx = {
    cwd: root,
    isIdle: () => true,
    ui: {
      notify(message) { notifications.push(message); },
      setStatus() {},
      async confirm() { confirmations++; return confirmation; },
    },
  };
  install(pi);
  const run = (args: string) => commands.get("strix-fix").handler(args, ctx);
  const paths = '"findings.sarif"';
  await run("--help");
  assert.equal(prompt, "");
  await run(paths + " --dry-run");
  assert.ok(prompt.includes("CI 导入"));
  assert.ok(prompt.includes(root));
  assert.deepEqual(tools, ["read", "bash", "edit"]);
  assert.equal(confirmations, 1);
  await run('"penetration_test_report.md" --yes');
  assert.ok(prompt.includes(sarif));
  await run('"." --yes');
  assert.ok(prompt.includes(report));
  await fs.writeFile(join(root, "unsupported.txt"), "test");
  prompt = "";
  await run('unsupported.txt --yes');
  assert.equal(prompt, "");
  assert.ok(notifications.at(-1)?.includes("pass a .sarif file"));
  confirmation = false;
  prompt = "";
  await run(paths);
  assert.equal(prompt, "");
  await run(paths + " --yes");
  assert.ok(prompt.includes("可以直接修改必要文件"));
  assert.equal(confirmations, 2);
  failAgent = true;
  await run(paths + " --yes --dry-run");
  assert.ok(notifications.at(-1)?.includes("Pi fix did not complete"));
  assert.deepEqual(tools, ["read", "bash", "edit"]);
  failAgent = false;
  for (const contents of ["broken JSON", '{"runs":null}', '{"runs":[{"results":[]}]}']) {
    prompt = "";
    await fs.writeFile(sarif, contents);
    await run(paths + " --yes");
    assert.equal(prompt, "");
  }
  await fs.writeFile(sarif, JSON.stringify({ runs: [{ results: [{ ruleId: "test" }] }] }));
  await fs.writeFile(report, " ");
  prompt = "";
  await run(paths + " --yes");
  assert.equal(prompt, "");
  assert.ok(notifications.at(-1)?.includes("Markdown report is empty"));
  await run("missing --yes");
  assert.ok(notifications.at(-1)?.includes("failed") || notifications.at(-1)?.includes("ENOENT"));
  assert.equal(events.get("agent_start").size, 0);
  console.log("strix-fix command check: ok");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
