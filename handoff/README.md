# Windows migration handoff

This repository is the portable source handoff for continuing v1 work on another Windows machine.

## Main bridge repository

- Clone `https://github.com/Errantial/t3onsteroids.git`.
- `main` contains the current bridge/plan state.
- Branch `agent/step7-live-harness` preserves the Step-7 live-smoke harness work (`77ea0ea2a9713c6f5573acfa9962c13c293acb92`).

## Chat On Steroids companion source changes

The CoS companion changes live in a separate upstream repository and therefore are preserved here as a patch series instead of being mixed into this repository's Git history.

Base CoS repository: `https://github.com/totec448-spec/chat-on-steroids.git`

Base commit: `87ae9d631f82d8da2f462d910410031ad8f97ac5`

Final local candidate commit before migration: `d5f27e7486c977351401ab1801fb01112aa2919b`

To reconstruct the exact CoS source lineage on the new machine:

```powershell
git clone https://github.com/totec448-spec/chat-on-steroids.git cos-provider-extension
cd cos-provider-extension
git checkout 87ae9d631f82d8da2f462d910410031ad8f97ac5
git switch -c agent/cos-drain-opt
git am ..\t3onsteroids\handoff\cos-provider-extension-patches\*.patch
```

The patch series contains 17 commits, ending with `Order provider drain probe after turn end`.

Do not copy old CoS secrets, browser storage, controller tokens, or live profile state to the new machine. Recreate a fresh isolated qualification profile there.
