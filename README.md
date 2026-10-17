# t3onsteroids

Windows-first compatibility bridge work for using Chat On Steroids (CoS) as a Local ACP provider in T3 Code.

## Status

**Pre-v1. Not release-qualified yet.**

The repository currently includes:

- exact T3/CoS/ACP compatibility metadata;
- a typed authenticated CoS protocol-1 client plus provider-extension client contract;
- lazy project/session binding and prompt normalization helpers;
- cancellation/recovery/admission semantics with offline tests;
- bounded queue/retry/content-fetch performance guard helpers;
- read-only setup diagnostics and release-boundary reporting.

Still required for finished v1:

- the actual CoS provider-extension server implementation/build;
- a production ACP stdio agent entrypoint;
- event translation and terminal semantics;
- durable crash-safe state and true cross-process admission leasing;
- final controller/privacy hardening and dependency-audit disposition;
- the pinned live T3 → ACP → CoS acceptance matrix and current-T3-HEAD drift run.

See [`PLAN.md`](PLAN.md) for the authoritative remaining roadmap and [`docs/release-status.md`](docs/release-status.md) for release gates.

## Local verification

```text
npm ci
npm run verify
```

`npm run verify` runs typecheck, lint, offline tests, build and a CLI/release-metadata smoke check. It does not exercise the final ACP provider process because that entrypoint is still a remaining v1 gate.

## Windows launch shape

T3 Local ACP uses `shell:false`, so the selected Windows launch shape is a real Node executable plus the built script, not an npm/batch wrapper:

```text
C:\Program Files\nodejs\node.exe
C:\Users\emilg\t3onsteroids\dist\cli\index.js
```

The launch shape has been validated structurally, but the current CLI is not yet the production ACP stdio provider. Do not treat it as release-ready until the ACP entrypoint gate in `PLAN.md` is complete.

## Concurrency

V1 targets one active bridged turn per stable CoS controller identity. **2–4 concurrent CoS chats are a desired post-v1 feature** with explicit load, stream-cap, browser-reliability and isolation gates in `PLAN.md`.
