# Codex home service

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

Keeps a Codex home sound from one parameter record:

- the home lives on the Linux filesystem
- the Windows-side app reads the one login through a link
- the folder Codex's thread search reads holds only live threads (idle ones archived through Codex, unlisted legacy logs moved aside)
- the login shell's `PATH` carries the record's `shellPath` directories ahead of the system ones (`shellPath`, optional; for example a shim directory that makes agent `gh` calls use the GitHub App's installation tokens), declared in the same managed blocks as the Codex home
- the login shell exports the record's `shellEnvironment` (optional; for example `NPM_CONFIG_USERCONFIG` naming the npm configuration credential custody renders under the credentials directory, so no credential is kept in a home directory)
- generated workspace paths stay out of git's untracked set
- disabled plugin MCP servers stay off
- agent scratch roots lose entries unchanged past an idle limit, never ones open, mounted, kept or holding unpushed work

A user timer runs retention daily. Node built-ins only.

```sh
node scripts/codex-home.mjs plan  --parameters=<codex-home.json>    # read-only; exit 0 converged, 2 drift
node scripts/codex-home.mjs apply --parameters=<codex-home.json>    # idempotent; --scope=placement|retention|scratch|workspace|config|timer[,...]
```

`plan` is the health check. It reads sizes, links and small files only. It never walks a workspace or greps logs, because on a loaded WSL host that is the load being diagnosed.

Bare Cedar Fog's parameters: `561-group-services-section/services/561-group-operations-services-section/services/bare-cedar-fog-services-section/data/records/codex-home-service-records/bare-cedar-fog/codex-home.json`.

Requirements: `specifications/requirements.md`. Design: `specifications/design.md`.
