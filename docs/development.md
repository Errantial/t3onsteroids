# Development

Development is Windows-first and uses Node directly.

The Windows packaging/launch shape uses the real Node executable plus the built script path, for example:

```text
C:\Program Files\nodejs\node.exe
C:\Users\emilg\t3onsteroids\dist\cli\index.js
```

Do not point T3 at `npm.cmd`, `npx.cmd`, or another `.cmd`/`.bat` wrapper. T3 spawns Local ACP providers with `shell:false` on Windows.

This is the intended v1 launcher strategy: T3 executes the real `node.exe` with `dist/cli/index.js` as its argument. The project does not currently add an unpinned third-party single-file packager merely to manufacture a wrapper `.exe`; a future self-contained executable must be separately pinned and qualified.

The launch shape is selected and structurally validated, but the current CLI still exposes diagnostics/release metadata rather than the final ACP stdio agent. Production T3 provider configuration is therefore intentionally deferred until the **production ACP provider process** gate in `PLAN.md` is complete.

`initialize`/validation and bridge-local session allocation stay free of CoS mutation. Use `--diagnose --user-data-dir <path> [--cwd <project>]` for a read-only controller/project readiness check. Diagnostics never enable Local control API or Allow actions for you.

The supported v1 release lane remains one active bridged turn per stable CoS controller identity. Two-to-four concurrent chats are explicitly planned as a desired post-v1 feature, with isolated browser/controller load, cancellation-isolation, latency, memory and stream-cap qualification before the capability can be advertised.

Run the full local verification lane with:

```text
npm run verify
```

This performs typecheck, lint, offline tests, build and a CLI/release-metadata smoke check. It does not exercise the final ACP stdio provider and does not substitute for live one-turn performance qualification or the pinned T3/CoS acceptance matrix.
