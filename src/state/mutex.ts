import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface ProcessIdentityLive {
  readonly status: "live";
  readonly processStartTicks: string;
}

export interface ProcessIdentityNotFound {
  readonly status: "not_found";
}

export interface ProcessIdentityUnknown {
  readonly status: "identity_unknown";
  readonly reason: string;
}

export type ProcessIdentityResult = ProcessIdentityLive | ProcessIdentityNotFound | ProcessIdentityUnknown;

export interface WindowsProcessIdentity {
  query(pid: number): Promise<ProcessIdentityResult>;
  current(): Promise<{ readonly pid: number; readonly processStartTicks: string }>;
}

export interface LockOwnerRecord {
  readonly pid: number;
  readonly processStartTicks: string;
  readonly nonce: string;
  readonly acquiredAt: number;
}

export class StateLockBusyError extends Error {
  readonly code = "state_lock_busy";
  constructor(message = "State mutation lock is busy; retry after the current owner exits or completes") {
    super(message);
    this.name = "StateLockBusyError";
  }
}

export class UnsupportedStateFilesystemError extends Error {
  readonly code = "unsupported_state_filesystem";
  constructor(message = "State filesystem does not provide the required hard-link semantics") {
    super(message);
    this.name = "UnsupportedStateFilesystemError";
  }
}

function positivePid(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function decimalTicks(value: string): boolean {
  return /^[1-9][0-9]{0,24}$/.test(value);
}

function parseOwner(raw: string): LockOwnerRecord | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (Object.keys(value).some((key) => !["pid", "processStartTicks", "nonce", "acquiredAt"].includes(key))) return null;
    if (typeof value.pid !== "number" || !positivePid(value.pid)) return null;
    if (typeof value.processStartTicks !== "string" || !decimalTicks(value.processStartTicks)) return null;
    if (typeof value.nonce !== "string" || !/^[0-9a-f-]{36}$/i.test(value.nonce)) return null;
    if (typeof value.acquiredAt !== "number" || !Number.isFinite(value.acquiredAt) || value.acquiredAt < 0) return null;
    return {
      pid: value.pid,
      processStartTicks: value.processStartTicks,
      nonce: value.nonce,
      acquiredAt: value.acquiredAt,
    };
  } catch {
    return null;
  }
}

export class PowerShellWindowsProcessIdentity implements WindowsProcessIdentity {
  private currentIdentity: Promise<{ readonly pid: number; readonly processStartTicks: string }> | null = null;

  private async resolveCurrent(): Promise<{ readonly pid: number; readonly processStartTicks: string }> {
    // The PowerShell child can occasionally miss its two-second deadline while Windows is under
    // process-launch pressure. Never weaken the positive-proof requirement, but give the current
    // process a small bounded opportunity to obtain that proof before failing closed. This retry is
    // deliberately limited to our own identity; stale-owner queries below remain single-shot so an
    // ambiguous external owner can never be reclaimed by optimism.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await this.query(process.pid);
      if (result.status === "live") {
        return { pid: process.pid, processStartTicks: result.processStartTicks };
      }
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
    throw new StateLockBusyError("Current process identity could not be verified safely");
  }

  async query(pid: number): Promise<ProcessIdentityResult> {
    if (!positivePid(pid)) return { status: "identity_unknown", reason: "invalid_pid" };
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot) return { status: "identity_unknown", reason: "system_root_missing" };
    const executable = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const script = [
      "$ErrorActionPreference='Stop'",
      `try { $p = Get-Process -Id ${pid} -ErrorAction Stop } catch {`,
      "  if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId*') { exit 3 }",
      "  exit 4",
      "}",
      "$ticks = $p.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)",
      "[Console]::Out.Write($ticks)",
    ].join("; ");

    return new Promise((resolve) => {
      execFile(executable, ["-NoProfile", "-NonInteractive", "-Command", script], {
        shell: false,
        windowsHide: true,
        timeout: 2_000,
        maxBuffer: 128,
        encoding: "utf8",
      }, (error, stdout) => {
        if (error) {
          const code = typeof error.code === "number" ? error.code : Number.NaN;
          if (code === 3) return resolve({ status: "not_found" });
          return resolve({ status: "identity_unknown", reason: error.killed ? "timeout" : "query_failed" });
        }
        if (Buffer.byteLength(stdout, "utf8") > 128) return resolve({ status: "identity_unknown", reason: "oversized_output" });
        const ticks = stdout.trim();
        if (!decimalTicks(ticks)) return resolve({ status: "identity_unknown", reason: "malformed_output" });
        resolve({ status: "live", processStartTicks: ticks });
      });
    });
  }

  current(): Promise<{ readonly pid: number; readonly processStartTicks: string }> {
    if (this.currentIdentity) return this.currentIdentity;
    const pending = this.resolveCurrent();
    this.currentIdentity = pending;
    // Cache only positive proof. A transiently exhausted retry budget must fail this operation
    // closed without poisoning every later mutation in the same long-lived ACP process.
    void pending.catch(() => {
      if (this.currentIdentity === pending) this.currentIdentity = null;
    });
    return pending;
  }
}

async function writeAndSync(file: string, contents: string): Promise<void> {
  const handle = await fs.open(file, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export interface HardLinkMutexOptions {
  readonly identity?: WindowsProcessIdentity;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface HardLinkMutexHandle {
  readonly owner: LockOwnerRecord;
  release(): Promise<void>;
}

export class HardLinkMutex {
  private readonly identity: WindowsProcessIdentity;
  private readonly timeoutMs: number;
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly locksRoot: string,
    private readonly name: string,
    options: HardLinkMutexOptions = {},
  ) {
    if (!/^[a-zA-Z0-9._-]{1,160}$/.test(name)) throw new Error("invalid lock name");
    this.identity = options.identity ?? new PowerShellWindowsProcessIdentity();
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.pollMs = options.pollMs ?? 25;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private fixedPath(): string {
    return path.join(this.locksRoot, `${this.name}.lock`);
  }

  private async ownerTemp(owner: LockOwnerRecord): Promise<string> {
    const dir = path.join(this.locksRoot, "tmp");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${this.name}.${owner.nonce}.owner`);
    await writeAndSync(file, JSON.stringify(owner));
    return file;
  }

  private async fixedOwner(): Promise<LockOwnerRecord | null> {
    try {
      return parseOwner(await fs.readFile(this.fixedPath(), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async reclaimIfProvenStale(owner: LockOwnerRecord): Promise<boolean> {
    const identity = await this.identity.query(owner.pid);
    const stale = identity.status === "not_found" ||
      (identity.status === "live" && identity.processStartTicks !== owner.processStartTicks);
    if (!stale) return false;
    const stalePath = `${this.fixedPath()}.stale-${randomUUID()}`;
    try {
      await fs.rename(this.fixedPath(), stalePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return true;
      if (code === "EACCES" || code === "EPERM") return false;
      throw error;
    }
    await fs.rm(stalePath, { force: true });
    return true;
  }

  async acquire(): Promise<HardLinkMutexHandle> {
    await fs.mkdir(this.locksRoot, { recursive: true });
    const identity = await this.identity.current();
    const deadline = this.now() + this.timeoutMs;
    for (;;) {
      const owner: LockOwnerRecord = {
        pid: identity.pid,
        processStartTicks: identity.processStartTicks,
        nonce: randomUUID(),
        acquiredAt: this.now(),
      };
      const temp = await this.ownerTemp(owner);
      try {
        await fs.link(temp, this.fixedPath());
        await fs.unlink(temp);
        let released = false;
        return {
          owner,
          release: async () => {
            if (released) return;
            const current = await this.fixedOwner();
            if (!current || current.nonce !== owner.nonce || current.pid !== owner.pid ||
                current.processStartTicks !== owner.processStartTicks) {
              throw new StateLockBusyError("State mutex ownership changed before release");
            }
            await fs.unlink(this.fixedPath());
            released = true;
          },
        };
      } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => undefined);
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      const existing = await this.fixedOwner();
      if (existing && await this.reclaimIfProvenStale(existing)) continue;
      // A malformed fixed lock can only come from external corruption; never guess that it is stale.
      if (!existing && await fs.stat(this.fixedPath()).then(() => true, () => false)) {
        throw new StateLockBusyError("State mutex owner metadata is unreadable");
      }
      if (this.now() >= deadline) throw new StateLockBusyError();
      await this.sleep(this.pollMs);
    }
  }

  async withLock<T>(work: () => Promise<T>): Promise<T> {
    const handle = await this.acquire();
    try {
      return await work();
    } finally {
      await handle.release();
    }
  }
}

export async function probeHardLinkStateFilesystem(stateRoot: string): Promise<void> {
  const probeDir = path.join(stateRoot, "locks", "probe");
  await fs.mkdir(probeDir, { recursive: true });
  const nonce = randomUUID();
  const source = path.join(probeDir, `${nonce}.source`);
  const linked = path.join(probeDir, `${nonce}.linked`);
  const payload = JSON.stringify({ nonce, probe: true });
  try {
    await writeAndSync(source, payload);
    await fs.link(source, linked);
    const [sourceText, linkedText] = await Promise.all([fs.readFile(source, "utf8"), fs.readFile(linked, "utf8")]);
    if (sourceText !== payload || linkedText !== payload) throw new UnsupportedStateFilesystemError("Hard-link probe content did not remain identical");
    await fs.unlink(source);
    if (await fs.readFile(linked, "utf8") !== payload) throw new UnsupportedStateFilesystemError("Hard-link target did not survive source unlink");
  } catch (error) {
    if (error instanceof UnsupportedStateFilesystemError) throw error;
    throw new UnsupportedStateFilesystemError(`Hard-link probe failed: ${(error as NodeJS.ErrnoException).code ?? "unknown"}`);
  } finally {
    await fs.rm(source, { force: true }).catch(() => undefined);
    await fs.rm(linked, { force: true }).catch(() => undefined);
  }
}
