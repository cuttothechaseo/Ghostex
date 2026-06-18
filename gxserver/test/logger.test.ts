import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createGxserverLogger,
  normalizeLogEntry,
  pruneGxserverLogLines,
  scheduleGxserverLogLineRetention,
} from "../src/logger.js";
import { getGxserverPaths } from "../src/paths.js";

test("JSONL logger writes one parseable camelCase entry per line", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "gxserver-logs-"));
  try {
    const paths = getGxserverPaths(homeDir);
    const logger = createGxserverLogger(paths);

    await logger.log({
      client: "local-cli",
      details: { action: "query", count: 1 },
      durationMs: 12,
      error: new Error("boom"),
      event: "apiRequest",
      legacyFile: "legacy.log",
      level: "warn",
      message: "request failed",
      projectId: "P3a91",
      requestId: "req-1",
      serverId: "S7k",
      sessionId: "G8v20",
      source: "unitTest",
      ts: "2026-05-30T10:16:00.000Z",
    });

    const lines = (await readFile(paths.logFile, "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;

    assert.deepEqual(parsed, {
      ts: "2026-05-30T10:16:00.000Z",
      level: "warn",
      event: "apiRequest",
      serverId: "S7k",
      requestId: "req-1",
      projectId: "P3a91",
      sessionId: "G8v20",
      client: "local-cli",
      durationMs: 12,
      error: "boom",
      details: { action: "query", count: 1 },
      legacyFile: "legacy.log",
      message: "request failed",
      source: "unitTest",
    });
    assert.equal(Object.keys(parsed).some((key) => key.includes("_")), false);
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});

test("JSONL logger suppresses info and debug when debugging mode is disabled", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "gxserver-logs-gated-"));
  try {
    const paths = getGxserverPaths(homeDir);
    const logger = createGxserverLogger(paths);

    await logger.log({ event: "routine.info", level: "info", ts: "2026-06-06T03:09:00.000Z" });
    await logger.log({ event: "routine.debug", level: "debug", ts: "2026-06-06T03:09:01.000Z" });
    await logger.log({ event: "routine.warn", level: "warn", ts: "2026-06-06T03:09:02.000Z" });
    await logger.log({ event: "routine.error", level: "error", ts: "2026-06-06T03:09:03.000Z" });

    const lines = (await readFile(paths.logFile, "utf8")).trim().split("\n");
    assert.deepEqual(
      lines.map((line) => (JSON.parse(line) as Record<string, unknown>).event),
      ["routine.warn", "routine.error"],
    );
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});

test("JSONL logger writes routine diagnostics when debugging mode is enabled", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "gxserver-logs-debug-"));
  try {
    const paths = getGxserverPaths(homeDir);
    await writeNativeSidebarSettings(homeDir, { debuggingMode: true });
    const logger = createGxserverLogger(paths);

    await logger.log({ event: "routine.info", level: "info", ts: "2026-06-06T03:09:00.000Z" });
    await logger.log({ event: "routine.debug", level: "debug", ts: "2026-06-06T03:09:01.000Z" });

    const lines = (await readFile(paths.logFile, "utf8")).trim().split("\n");
    assert.deepEqual(
      lines.map((line) => (JSON.parse(line) as Record<string, unknown>).event),
      ["routine.info", "routine.debug"],
    );
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});

test("JSONL logger rotates oversized gxserver log files before appending", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "gxserver-logs-rotate-"));
  try {
    const paths = getGxserverPaths(homeDir);
    await mkdir(paths.logsDir, { recursive: true });
    await writeFile(paths.logFile, `${"x".repeat(25 * 1024 * 1024)}\n`, "utf8");
    const logger = createGxserverLogger(paths);

    await logger.log({ event: "routine.warn", level: "warn", ts: "2026-06-06T03:26:00.000Z" });

    const current = await readFile(paths.logFile, "utf8");
    const rotated = await readFile(`${paths.logFile}.1`, "utf8");
    assert.match(current, /routine\.warn/u);
    assert.equal(rotated.startsWith("xxx"), true);
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});

test("JSONL retention keeps active split file and deletes older gxserver rotations", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "gxserver-logs-retention-"));
  try {
    const paths = getGxserverPaths(homeDir);
    await mkdir(paths.logsDir, { recursive: true });
    await writeFile(paths.logFile, ["old-active", "new-active-1", "new-active-2"].join("\n") + "\n", "utf8");
    await writeFile(`${paths.logFile}.1`, ["old-rotated", "new-rotated-1", "new-rotated-2"].join("\n") + "\n", "utf8");
    await writeFile(`${paths.logFile}.2`, ["older-rotated", "older-rotated-2"].join("\n") + "\n", "utf8");

    await pruneGxserverLogLines(paths, 2);

    assert.deepEqual((await readFile(paths.logFile, "utf8")).trim().split("\n"), ["new-active-1", "new-active-2"]);
    await assertFileMissing(`${paths.logFile}.1`);
    await assertFileMissing(`${paths.logFile}.2`);
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});

test("JSONL retention can be scheduled after logger startup", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "gxserver-logs-retention-scheduled-"));
  try {
    const paths = getGxserverPaths(homeDir);
    await mkdir(paths.logsDir, { recursive: true });
    await writeFile(paths.logFile, ["old", "new-1", "new-2"].join("\n") + "\n", "utf8");

    scheduleGxserverLogLineRetention(paths, { delayMs: 1, maxLines: 2 });
    await delay(30);

    assert.deepEqual((await readFile(paths.logFile, "utf8")).trim().split("\n"), ["new-1", "new-2"]);
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});

test("log normalization keeps optional identity fields absent when unknown", () => {
  assert.deepEqual(normalizeLogEntry({ event: "storageMigrated", level: "info", ts: "now" }), {
    ts: "now",
    level: "info",
    event: "storageMigrated",
  });
});

async function assertFileMissing(filePath: string): Promise<void> {
  try {
    await readFile(filePath, "utf8");
  } catch (error) {
    assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
    return;
  }
  assert.fail(`expected ${filePath} to be missing`);
}

test("log normalization redacts project/session names, paths, command text, urls, and secrets", () => {
  const normalized = normalizeLogEntry({
    details: {
      args: ["comments", "add", "gxserver-1", "private project note"],
      comment: "private project note",
      cwd: "/Users/person/dev/private-project",
      nested: {
        authToken: "secret-token",
        sessionTitle: "Customer deploy",
        url: "https://example.test/path?token=secret",
      },
      projectId: "P3a91",
      sessionId: "G8v20",
      title: "Customer deploy",
      titlePreview: "Customer deploy",
      worktreePath: "/Users/person/dev/private-project-feature",
    },
    error: "failed in /Users/person/dev/private-project with token=secret-token",
    event: "https://example.test/private?token=secret-token",
    legacyFile: "/Users/person/dev/private-project/legacy.log",
    level: "warn",
    message: 'legacy {"title":"Customer deploy","workspaceRoot":"/Users/person/dev/private-project"}',
    source: "/Users/person/dev/private-project/source.log",
    ts: "now",
  });

  assert.equal(normalized.projectId, undefined);
  assert.equal(normalized.details?.projectId, "P3a91");
  assert.equal(normalized.details?.sessionId, "G8v20");
  assert.deepEqual(normalized.details?.args, { count: 4, redacted: true });
  assert.equal(normalized.details?.comment, "[redacted]");
  assert.equal(normalized.details?.cwd, "[redacted:path]");
  assert.equal(normalized.details?.title, "[redacted]");
  assert.equal(normalized.details?.titlePreview, "[redacted]");
  assert.equal(normalized.details?.worktreePath, "[redacted:path]");
  assert.deepEqual((normalized.details?.nested as Record<string, unknown>)?.url, {
    host: "example.test",
    protocol: "https",
    redacted: true,
    type: "url",
  });
  assert.equal((normalized.details?.nested as Record<string, unknown>)?.authToken, "[redacted:secret]");
  assert.equal((normalized.details?.nested as Record<string, unknown>)?.sessionTitle, "[redacted]");
  assert.equal(normalized.event, "[redacted:url]");
  assert.equal(normalized.legacyFile, "[redacted:path]");
  assert.equal(normalized.source, "[redacted:path]");
  assert.doesNotMatch(JSON.stringify(normalized), /Customer deploy|private-project|secret-token|private project note/);
});

test("typed operation scope rejection logs stay shareable", () => {
  const normalized = normalizeLogEntry({
    details: {
      action: "board",
      commandText: "bd list --repo /Users/person/dev/private-project",
      endpoint: "runBeadsAction",
      errorCode: "notFound",
      errorType: "GxserverProjectPathError",
      hasProjectId: true,
      hasProjectPath: true,
      projectPath: "/Users/person/dev/private-project",
      secretToken: "secret-token",
      url: "https://example.test/repo?token=secret-token",
    },
    event: "typedOperation.scopeRejected",
    level: "warn",
    requestId: "req-1",
    serverId: "S7k",
    ts: "now",
  });

  assert.equal(normalized.event, "typedOperation.scopeRejected");
  assert.equal(normalized.details?.action, "board");
  assert.equal(normalized.details?.endpoint, "runBeadsAction");
  assert.equal(normalized.details?.projectPath, "[redacted:path]");
  assert.equal(normalized.details?.commandText, "[redacted]");
  assert.equal(normalized.details?.secretToken, "[redacted:secret]");
  assert.deepEqual(normalized.details?.url, {
    host: "example.test",
    protocol: "https",
    redacted: true,
    type: "url",
  });
  assert.doesNotMatch(JSON.stringify(normalized), /private-project|secret-token|bd list/);
});

test("log text redacts inline websocket and file urls", () => {
  const normalized = normalizeLogEntry({
    error: "bridge failed for wss://remote.example.test/socket?token=secret-token",
    event: "transport reconnect ws://127.0.0.1:4798/api/socket?session=CustomerDeploy",
    level: "warn",
    message: "opened file:///Users/person/dev/private-project/state.json?token=secret-token",
    ts: "now",
  });

  assert.equal(normalized.event, "transport reconnect [redacted:url]");
  assert.equal(normalized.error, "bridge failed for [redacted:url]");
  assert.equal(normalized.message, "opened [redacted:url]");
  assert.doesNotMatch(JSON.stringify(normalized), /remote\.example|127\.0\.0\.1|CustomerDeploy|private-project|secret-token/);
});

async function writeNativeSidebarSettings(homeDir: string, settings: Record<string, unknown>): Promise<void> {
  const stateDir = path.join(homeDir, ".ghostex", "state");
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, "native-sidebar-settings.json"), JSON.stringify(settings), "utf8");
}
