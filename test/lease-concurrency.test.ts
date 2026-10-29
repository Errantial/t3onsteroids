import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { releaseReadiness } from "../src/release.js";
import {
  CONCURRENCY_QUALIFICATION_ENV,
  DurableAdmissionLease,
  MAX_CONCURRENT_TURNS_ENV,
  MAX_LEASE_SLOTS,
  QUALIFIED_MAX_CONCURRENT_TURNS,
  leaseReferencedSessionIds,
  resolveLeaseCapacity,
  scaledPollMs,
  type ProcessIdentityResult,
  type WindowsProcessIdentity,
} from "../src/state/index.js";

const hash = "d".repeat(64);
const sessions = [
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
] as const;

class FixedIdentity implements WindowsProcessIdentity {
  async current(): Promise<{ readonly pid: number; readonly processStartTicks: string }> {
    return { pid: 4242, processStartTicks: "638962560000004242" };
  }
  async query(pid: number): Promise<ProcessIdentityResult> {
    return pid === 4242 ? { status: "live", processStartTicks: "638962560000004242" } : { status: "not_found" };
  }
}

const roots: string[] = [];
async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3os-lease-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function leaseFor(root: string, capacity?: number): DurableAdmissionLease {
  return new DurableAdmissionLease(root, hash, {
    identity: new FixedIdentity(),
    mutex: { timeoutMs: 1_000 },
    ...(capacity === undefined ? {} : { capacity }),
  });
}

function admit(lease: DurableAdmissionLease, index: number) {
  return lease.acquire({ sessionId: sessions[index]!, inputId: `input-${index}`, generation: 1, ownerId: `owner-${index}` });
}

function notSent(index: number) {
  return { kind: "not_sent" as const, sessionId: sessions[index]!, inputId: `input-${index}`, generation: 1 };
}

describe("admission lease capacity", () => {
  it("defaults to exactly one turn, as in V1, and keeps the V1 lease file name", async () => {
    const root = await tempRoot();
    const lease = leaseFor(root);
    expect((await admit(lease, 0)).status).toBe("acquired");
    expect((await admit(lease, 1)).status).toBe("held");
    expect(await fs.readdir(path.join(root, "leases"))).toEqual([`${hash}.json`]);
  });

  it("admits up to its capacity on separate slots and refuses the next turn", async () => {
    const root = await tempRoot();
    const lease = leaseFor(root, 2);
    const first = await admit(lease, 0);
    const second = await admit(lease, 1);
    expect([first.status, second.status]).toEqual(["acquired", "acquired"]);
    expect(first.lease.leaseId).not.toBe(second.lease.leaseId);
    expect((await admit(lease, 2)).status).toBe("held");
    expect((await fs.readdir(path.join(root, "leases"))).sort()).toEqual([`${hash}.json`, `${hash}.s1.json`]);
  });

  it("allows only one active turn per session even with free slots", async () => {
    const root = await tempRoot();
    const lease = leaseFor(root, 3);
    const first = await admit(lease, 0);
    const again = await lease.acquire({ sessionId: sessions[0], inputId: "input-next", generation: 2, ownerId: "owner-0" });
    expect(again).toMatchObject({ status: "held", lease: { leaseId: first.lease.leaseId } });
  });

  it("looks a lease up by its exact id and releases only that slot", async () => {
    const root = await tempRoot();
    const lease = leaseFor(root, 2);
    const first = await admit(lease, 0);
    const second = await admit(lease, 1);
    await expect(lease.readByLeaseId(second.lease.leaseId)).resolves.toMatchObject({
      status: "found",
      lease: { sessionId: sessions[1] },
    });
    await expect(lease.releaseAfterProof(second.lease.leaseId, notSent(1))).resolves.toBe("released");
    await expect(lease.readByLeaseId(second.lease.leaseId)).resolves.toEqual({ status: "missing" });
    await expect(lease.readByLeaseId(first.lease.leaseId)).resolves.toMatchObject({ status: "found" });
    // The freed slot is reused by the next admission.
    expect((await admit(lease, 2)).status).toBe("acquired");
  });

  it("refuses release with another turn's proof and leaves both leases intact", async () => {
    const root = await tempRoot();
    const lease = leaseFor(root, 2);
    const first = await admit(lease, 0);
    await admit(lease, 1);
    await expect(lease.releaseAfterProof(first.lease.leaseId, notSent(1))).resolves.toBe("proof_mismatch");
    expect((await lease.readSlots())).toMatchObject({ status: "ok", held: [{}, {}] });
  });

  it("keeps honoring leases above a lowered capacity and counts them as occupied", async () => {
    const root = await tempRoot();
    const wide = leaseFor(root, 2);
    await admit(wide, 0);
    const second = await admit(wide, 1);

    const narrow = leaseFor(root, 1);
    await expect(narrow.readByLeaseId(second.lease.leaseId)).resolves.toMatchObject({ status: "found" });
    expect((await admit(narrow, 2)).status).toBe("held");
    await expect(narrow.releaseAfterProof(second.lease.leaseId, notSent(1))).resolves.toBe("released");
    // Slot 0 is still occupied, so a capacity of 1 still refuses.
    expect((await admit(narrow, 2)).status).toBe("held");
  });

  it("fails closed when any slot is corrupt", async () => {
    const root = await tempRoot();
    const lease = leaseFor(root, 2);
    await admit(lease, 0);
    await fs.writeFile(path.join(root, "leases", `${hash}.s1.json`), "{not json");
    await expect(admit(lease, 1)).rejects.toThrow(/lease_corrupt/);
    await expect(lease.read()).resolves.toMatchObject({ status: "corrupt" });
  });

  it("protects every slot's session from pruning", async () => {
    const root = await tempRoot();
    const lease = leaseFor(root, 3);
    await admit(lease, 0);
    await admit(lease, 1);
    await admit(lease, 2);
    await expect(leaseReferencedSessionIds(root)).resolves.toEqual(new Set([sessions[0], sessions[1], sessions[2]]));
  });

  it("rejects out-of-range capacity", () => {
    for (const capacity of [0, -1, 1.5, MAX_LEASE_SLOTS + 1]) {
      expect(() => leaseFor("unused", capacity)).toThrow(/capacity/);
    }
  });
});

describe("evidence-gated concurrency configuration", () => {
  it("defaults to the qualified ceiling", () => {
    expect(QUALIFIED_MAX_CONCURRENT_TURNS).toBe(1);
    expect(resolveLeaseCapacity({})).toBe(1);
    expect(resolveLeaseCapacity({ [MAX_CONCURRENT_TURNS_ENV]: " 1 " })).toBe(1);
  });

  it("fails explicitly, instead of clamping, when asked for unqualified concurrency", () => {
    expect(() => resolveLeaseCapacity({ [MAX_CONCURRENT_TURNS_ENV]: "2" })).toThrow(/not qualified/);
  });

  it("allows it only for an explicit qualification run, within the controller stream budget", () => {
    const qualification = { [CONCURRENCY_QUALIFICATION_ENV]: "1" };
    expect(resolveLeaseCapacity({ ...qualification, [MAX_CONCURRENT_TURNS_ENV]: "2" })).toBe(2);
    expect(resolveLeaseCapacity({ ...qualification, [MAX_CONCURRENT_TURNS_ENV]: "4" })).toBe(4);
    expect(() => resolveLeaseCapacity({ ...qualification, [MAX_CONCURRENT_TURNS_ENV]: "5" })).toThrow(/cannot exceed/);
  });

  it("rejects malformed values", () => {
    for (const value of ["0", "-1", "two", "1.5", "10", "01"]) {
      expect(() => resolveLeaseCapacity({ [MAX_CONCURRENT_TURNS_ENV]: value })).toThrow();
    }
  });
});

describe("shared controller budget", () => {
  const READS_PER_MINUTE_CAP = 600;
  // The turn-start wait loop reads the input and the session on every pass.
  const waitReadsPerMinute = (turns: number, capacity: number): number =>
    turns * 2 * (60_000 / scaledPollMs(500, capacity));

  it("keeps the combined wait-loop read rate at the single-turn rate however many turns run", () => {
    const singleTurn = waitReadsPerMinute(1, 1);
    for (let capacity = 1; capacity <= MAX_LEASE_SLOTS; capacity++) {
      expect(waitReadsPerMinute(capacity, capacity)).toBeLessThanOrEqual(singleTurn);
      expect(waitReadsPerMinute(capacity, capacity)).toBeLessThan(READS_PER_MINUTE_CAP);
    }
  });

  it("leaves the V1 polling interval unchanged at capacity 1 and rejects nonsense", () => {
    expect(scaledPollMs(500, 1)).toBe(500);
    expect(scaledPollMs(50, 4)).toBe(200);
    expect(() => scaledPollMs(0, 1)).toThrow();
    expect(() => scaledPollMs(500, 0)).toThrow();
  });

  it("exposes the lease capacity that callers scale by", () => {
    expect(leaseFor("unused").maxConcurrentTurns).toBe(1);
    expect(leaseFor("unused", 3).maxConcurrentTurns).toBe(3);
  });

  it("keeps the advertised release concurrency equal to the qualified ceiling", () => {
    expect(releaseReadiness().supportedConcurrency).toBe(QUALIFIED_MAX_CONCURRENT_TURNS);
  });
});
