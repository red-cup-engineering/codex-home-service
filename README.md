# Codex home service

Keeps a Codex home sound from one parameter record:

- the home lives on the Linux filesystem
- the Windows-side app reads the one login through a link
- the folder Codex's thread search reads holds only live threads (idle ones archived through Codex, unlisted legacy logs moved aside)
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
