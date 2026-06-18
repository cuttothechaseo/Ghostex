import { readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GxserverLogEntry, GxserverLogLevel } from "../protocol/index.js";
import type { GxserverPaths } from "./paths.js";

export interface GxserverLogger {
  log(entry: GxserverLogInput): Promise<void>;
}

export type GxserverLogInput = Omit<GxserverLogEntry, "error" | "ts"> & {
  error?: string | Error;
  ts?: string;
};

const REDACTED_TEXT = "[redacted]";
const REDACTED_PATH = "[redacted:path]";
const REDACTED_URL = "[redacted:url]";
const REDACTED_SECRET = "[redacted:secret]";
const DEBUGGING_MODE_SETTINGS_CACHE_MS = 1_000;
const GXSERVER_LOG_FILE_MAX_BYTES = 25 * 1024 * 1024;
const GXSERVER_LOG_FILE_MAX_ROTATIONS = 3;
const GXSERVER_LOG_FILE_MAX_LINES = 25_000;
const GXSERVER_LOG_RETENTION_STARTUP_DELAY_MS = 60_000;
const scheduledRetentionLogFiles = new Set<string>();

interface DebuggingModeCache {
  checkedAtMs: number;
  enabled: boolean;
}

/*
CDXC:GxserverLogs 2026-05-30-14:16:
gxserver writes structured JSONL to `~/.ghostex/logs/gxserver.jsonl` with camelCase fields. This is the foundation for later log query/migration APIs, so every line must be independently parseable JSON and include stable request/session/project identity fields when available.

CDXC:GxserverLogs 2026-05-30-23:52:
Users must be able to zip and share gxserver logs without leaking project/session names, filesystem paths, prompt text, command text, URLs with private query strings, or credentials. Sanitize every optional message/error/details field and legacy-derived string field at the JSONL boundary so future call sites cannot bypass the ID-first logging contract.

CDXC:GxserverLogs 2026-06-06-07:09:
Routine gxserver diagnostics became a CPU and disk multiplier during terminal-title storms. Persist only warning/error entries unless Settings Debug Logging and UI is enabled, and enforce that policy at the logger boundary so future info/debug call sites cannot spam `~/.ghostex/logs/gxserver.jsonl` during normal use.

CDXC:GxserverLogs 2026-06-06-07:26:
gxserver logs can become GB-scale when a diagnostic storm already happened.
Rotate the JSONL file at 25 MB with three retained files before appending any
persisted entry so support bundles stay bounded after the next warning/error or
Debugging Mode diagnostic write.

CDXC:GxserverLogs 2026-06-06-23:21:
Preview fields are user-owned content by default because they commonly contain terminal titles, command output, prompts, or response bodies. Redact string preview keys at the logger boundary so future diagnostic call sites cannot accidentally persist snippets in Debugging Mode.

CDXC:GxserverLogs 2026-06-17-22:51:
Inline URL redaction must cover websocket and file URLs as well as HTTP URLs because gxserver transport errors and support-log diagnostics can embed `ws://`, `wss://`, or `file://` values with private paths or query strings inside free-form text.
*/
export function createGxserverLogger(paths: GxserverPaths): GxserverLogger {
  const debuggingModeCache: DebuggingModeCache = { checkedAtMs: 0, enabled: false };
  scheduleGxserverLogLineRetention(paths);
  return {
    async log(entry: GxserverLogInput): Promise<void> {
      if (!shouldPersistGxserverLogEntry(entry.level, () => readDebuggingModeEnabled(paths, debuggingModeCache))) {
        return;
      }
      await mkdir(paths.logsDir, { recursive: true });
      const line = JSON.stringify(normalizeLogEntry(entry));
      await rotateGxserverLogIfNeeded(paths.logFile, Buffer.byteLength(line, "utf8") + 1);
      await appendFile(paths.logFile, `${line}\n`, "utf8");
    },
  };
}

export function scheduleGxserverLogLineRetention(
  paths: GxserverPaths,
  options: { delayMs?: number; maxLines?: number } = {},
): void {
  const maxLines = options.maxLines ?? GXSERVER_LOG_FILE_MAX_LINES;
  const delayMs = options.delayMs ?? GXSERVER_LOG_RETENTION_STARTUP_DELAY_MS;
  const scheduleKey = `${paths.logFile}:${maxLines}`;
  if (scheduledRetentionLogFiles.has(scheduleKey)) {
    return;
  }
  scheduledRetentionLogFiles.add(scheduleKey);
  /*
  CDXC:GxserverLogs 2026-06-16-12:22:
  gxserver JSONL rotations can carry old warning storms long after the current daemon is quiet. Wait one minute after logger startup, then trim retained `gxserver.jsonl*` output so support bundles stay bounded without interrupting the current diagnostic stream.

  CDXC:GxserverLogs 2026-06-16-14:09:
  Retention now keeps only the active/latest gxserver split file and deletes older `gxserver.jsonl.N` siblings before trimming the retained file to 25,000 lines. Prefer the unrotated active file when it exists because the daemon writes there after startup.
  */
  const timer = setTimeout(() => {
    void pruneGxserverLogLines(paths, maxLines).catch(() => {
      // Retention is best-effort cleanup; logging this failure would recurse into the same support file.
    });
  }, delayMs);
  timer.unref();
}

export async function pruneGxserverLogLines(paths: GxserverPaths, maxLines = GXSERVER_LOG_FILE_MAX_LINES): Promise<void> {
  const logFiles = gxserverLogFiles(paths.logFile);
  const retainedLogFile = await retainedGxserverLogFile(paths.logFile, logFiles);
  if (!retainedLogFile) {
    return;
  }
  await Promise.all(logFiles.filter((logFile) => logFile !== retainedLogFile).map((logFile) => rm(logFile, { force: true })));
  await pruneLogFileToMaxLines(retainedLogFile, maxLines);
}

export function normalizeLogEntry(entry: GxserverLogInput): GxserverLogEntry {
  return {
    ts: entry.ts ?? new Date().toISOString(),
    level: entry.level,
    event: sanitizeLogText(entry.event),
    ...(entry.serverId ? { serverId: entry.serverId } : {}),
    ...(entry.requestId ? { requestId: entry.requestId } : {}),
    ...(entry.projectId ? { projectId: entry.projectId } : {}),
    ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
    ...(entry.client ? { client: entry.client } : {}),
    ...(typeof entry.durationMs === "number" ? { durationMs: entry.durationMs } : {}),
    ...(entry.error ? { error: sanitizeLogText(normalizeError(entry.error)) } : {}),
    ...(entry.details ? { details: sanitizeLogDetails(entry.details) } : {}),
    ...(entry.legacyFile ? { legacyFile: sanitizeLogText(entry.legacyFile) } : {}),
    ...(entry.message ? { message: sanitizeLogText(entry.message) } : {}),
    ...(entry.source ? { source: sanitizeLogText(entry.source) } : {}),
  };
}

export function sanitizeLogDetails(details: Record<string, unknown>): Record<string, unknown> {
  return sanitizeLogRecord(details);
}

export function sanitizeLogText(value: string): string {
  return redactSensitiveText(value);
}

export function logLevelFromStatus(statusCode: number): GxserverLogLevel {
  if (statusCode >= 500) {
    return "error";
  }
  if (statusCode >= 400) {
    return "warn";
  }
  return "info";
}

function shouldPersistGxserverLogEntry(
  level: GxserverLogLevel,
  isDebuggingModeEnabled: () => boolean,
): boolean {
  return level === "warn" || level === "error" || isDebuggingModeEnabled();
}

function readDebuggingModeEnabled(paths: GxserverPaths, cache: DebuggingModeCache): boolean {
  const nowMs = Date.now();
  if (nowMs - cache.checkedAtMs < DEBUGGING_MODE_SETTINGS_CACHE_MS) {
    return cache.enabled;
  }
  cache.checkedAtMs = nowMs;
  cache.enabled = readDebuggingModeSettingsFile(paths);
  return cache.enabled;
}

function readDebuggingModeSettingsFile(paths: GxserverPaths): boolean {
  try {
    const settingsPath = path.join(paths.homeDir, ".ghostex", "state", "native-sidebar-settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { debuggingMode?: unknown };
    return settings.debuggingMode === true;
  } catch {
    return false;
  }
}

async function rotateGxserverLogIfNeeded(logFile: string, incomingByteCount: number): Promise<void> {
  const size = await readFileSize(logFile);
  if (size + incomingByteCount <= GXSERVER_LOG_FILE_MAX_BYTES) {
    return;
  }
  await rm(rotatedGxserverLogFile(logFile, GXSERVER_LOG_FILE_MAX_ROTATIONS), { force: true });
  for (let index = GXSERVER_LOG_FILE_MAX_ROTATIONS - 1; index >= 1; index -= 1) {
    const source = rotatedGxserverLogFile(logFile, index);
    const destination = rotatedGxserverLogFile(logFile, index + 1);
    try {
      await rename(source, destination);
    } catch (error) {
      if (!isNodeErrorCode(error, "ENOENT")) {
        throw error;
      }
    }
  }
  try {
    await rename(logFile, rotatedGxserverLogFile(logFile, 1));
  } catch (error) {
    if (!isNodeErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
}

async function readFileSize(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return 0;
    }
    throw error;
  }
}

function rotatedGxserverLogFile(logFile: string, index: number): string {
  return `${logFile}.${index}`;
}

function gxserverLogFiles(logFile: string): string[] {
  return [
    logFile,
    ...Array.from({ length: GXSERVER_LOG_FILE_MAX_ROTATIONS }, (_, index) => rotatedGxserverLogFile(logFile, index + 1)),
  ];
}

async function retainedGxserverLogFile(activeLogFile: string, logFiles: string[]): Promise<string | undefined> {
  const activeStats = await statLogFile(activeLogFile);
  if (activeStats?.isFile()) {
    return activeLogFile;
  }
  let retainedLogFile: string | undefined;
  let retainedMtimeMs = Number.NEGATIVE_INFINITY;
  for (const logFile of logFiles) {
    const stats = await statLogFile(logFile);
    if (stats?.isFile() && stats.mtimeMs > retainedMtimeMs) {
      retainedLogFile = logFile;
      retainedMtimeMs = stats.mtimeMs;
    }
  }
  return retainedLogFile;
}

async function statLogFile(logFile: string) {
  try {
    return await stat(logFile);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

async function pruneLogFileToMaxLines(logFile: string, maxLines: number): Promise<void> {
  if (maxLines <= 0) {
    return;
  }
  let content: string;
  try {
    content = await readFile(logFile, "utf8");
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
  if (lines.length <= maxLines) {
    return;
  }
  await writeFile(logFile, `${lines.slice(-maxLines).join("\n")}\n`, "utf8");
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return (error as { code?: unknown }).code === code;
}

function normalizeError(error: string | Error): string {
  return error instanceof Error ? error.message : error;
}

function sanitizeLogRecord(record: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    sanitized[key] = sanitizeLogValue(key, value);
  }
  return sanitized;
}

function sanitizeLogValue(key: string, value: unknown): unknown {
  const normalizedKey = key.toLowerCase();
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return sanitizeStringField(normalizedKey, value);
  }
  if (Array.isArray(value)) {
    if (isSensitiveCollectionKey(normalizedKey)) {
      return { count: value.length, redacted: true };
    }
    return value.map((item) => sanitizeLogValue(key, item));
  }
  if (isRecord(value)) {
    if (isSensitiveCollectionKey(normalizedKey)) {
      return { redacted: true };
    }
    return sanitizeLogRecord(value);
  }
  return String(value);
}

function sanitizeStringField(normalizedKey: string, value: string): unknown {
  if (isSecretKey(normalizedKey)) {
    return REDACTED_SECRET;
  }
  if (isIdentifierKey(normalizedKey) && isSafeIdentifier(value)) {
    return value;
  }
  if (isUrlKey(normalizedKey) || looksLikeUrl(value)) {
    return summarizeUrl(value);
  }
  if (isPathKey(normalizedKey) || looksLikePath(value)) {
    return REDACTED_PATH;
  }
  if (isSensitiveTextKey(normalizedKey)) {
    return REDACTED_TEXT;
  }
  return redactSensitiveText(value);
}

function redactSensitiveText(value: string): string {
  return value
    .replace(
      /"(title|name|projectName|sessionName|cwd|path|projectPath|workspaceRoot|worktreePath|url|input|comment|description|command|text|message|details|token|authToken|bearer|credential|password|secret)"\s*:\s*"[^"]*"/giu,
      (_match, key: string) => `"${key}":"${redactionForKey(key.toLowerCase())}"`,
    )
    .replace(/\b(?:bearer|token|authorization|password|secret|credential)=?[^\s"']+/giu, `${REDACTED_SECRET}`)
    .replace(/(?:https?|wss?|file):\/\/[^\s"')]+/giu, REDACTED_URL)
    .replace(/(?:~|\/Users\/[^/\s"']+|\/(?:private\/)?tmp|\/var\/folders|\/Volumes)\/[^\s"']+/gu, REDACTED_PATH);
}

function redactionForKey(key: string): string {
  if (isSecretKey(key)) {
    return REDACTED_SECRET;
  }
  if (isUrlKey(key)) {
    return REDACTED_URL;
  }
  if (isPathKey(key)) {
    return REDACTED_PATH;
  }
  return REDACTED_TEXT;
}

function summarizeUrl(value: string): Record<string, unknown> {
  try {
    const url = new URL(value);
    return {
      host: url.host,
      protocol: url.protocol.replace(/:$/u, ""),
      redacted: true,
      type: "url",
    };
  } catch {
    return { redacted: true, type: "url" };
  }
}

function isIdentifierKey(key: string): boolean {
  return key === "id" || key.endsWith("id") || key.endsWith("ids") || key.endsWith("ref") || key.endsWith("refs");
}

function isSafeIdentifier(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function isSecretKey(key: string): boolean {
  return /token|bearer|secret|credential|password|cookie|authorization|auth/.test(key);
}

function isUrlKey(key: string): boolean {
  return key === "url" || key.endsWith("url") || key.includes("uri") || key === "href" || key === "origin";
}

function isPathKey(key: string): boolean {
  return (
    key === "path" ||
    key === "cwd" ||
    key.endsWith("path") ||
    key.endsWith("dir") ||
    key.endsWith("directory") ||
    key.endsWith("root") ||
    key.endsWith("file") ||
    key.endsWith("filename") ||
    key.includes("workspace")
  );
}

function isSensitiveTextKey(key: string): boolean {
  return (
    key === "title" ||
    key.endsWith("title") ||
    key === "name" ||
    key.endsWith("name") ||
    key === "message" ||
    key === "details" ||
    key.endsWith("details") ||
    key === "input" ||
    key === "text" ||
    key.endsWith("text") ||
    key === "comment" ||
    key === "description" ||
    key === "label" ||
    key === "preview" ||
    key.endsWith("preview") ||
    key === "command" ||
    key.endsWith("command") ||
    key === "stdout" ||
    key === "stderr" ||
    key === "body" ||
    key.endsWith("body")
  );
}

function isSensitiveCollectionKey(key: string): boolean {
  return key === "args" || key.endsWith("args") || key === "arguments" || key.endsWith("arguments");
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//iu.test(value);
}

function looksLikePath(value: string): boolean {
  return /^(?:~\/|\/Users\/|\/Volumes\/|\/private\/|\/tmp\/|\/var\/folders\/)/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
