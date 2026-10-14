# Codex home service: requirements

Leader statements taken as theory (2026-10-14):

- "WE CANNOT KEEP CROSSING THE WSL WINDOWS LINE PUT ALL SHIT ON ONE SIDE OF IT PERMANENTLY ONE TIME MIGRATION RIGHT NOW AND MAKE IT BASICALLY IMPOSSIBLE TO SET IT BACK"
- "FIX THE FUCKING RG SHIT ... MAKE THE DATA IT READS NOT SO FUCKING GIANT"
- "you are doing everything by hand that needs to be handled by actual software tooling"
- "IF THE TECHNOLOGY WERE DESIGNED WELL PEOPLE WOULD NOT KEEP TURNING IT OFF"

Measured on Bare Cedar Fog the same day (record `codex-home-service-records/bare-cedar-fog/codex-home.json`, `observed-2026-10-14`):

- With the Codex home on `/mnt/c` (the 9P bridge), a walk of its ~7,000 files took 15.8 s, and every skills/plugins/MCP/config request repeated it: `config/read` 27 s, `skills/list` 36 s, `thread/queue/list` 106 s, thread open ~83 s. With the home on ext4: 1.8 s, 3.1 s, 0.05 s, 0.9 s.
- The Codex app's thread search runs `rg -l --fixed-strings --ignore-case --no-ignore --glob *.jsonl -- <text> <home>/sessions` per query. Over 4.1 GB it ran 13+ minutes at ~350% CPU per query and froze the WSL VM (load 55). 2.9 GB of it was legacy logs the app does not list, and 1.05 GB was threads idle more than two days.
- The workspace held 61,980 untracked generated files under its disposable `.codex/`. Every Codex turn's git snapshot and thread open walked them: `git ls-files --others` took 8.3 s.
- The desktop app's Windows-side "Local Work executor" reads the login from the Windows profile's Codex folder. Without it, the executor restarted every 1.4 s (≈2,900 times) and Local Work stalled for 22 minutes.
- The app refuses to start if the Windows profile's Codex folder is itself a link ("Organization settings could not be loaded").

Each requirement has one shall. Identifiers are stable.

## Placement

- CH-1. The service shall hold the Codex home on the Linux filesystem named by the parameter record, and `plan` shall report drift when a login shell resolves `CODEX_HOME` anywhere else or under a Windows mount.
- CH-2. The service shall keep one login credential: the real `auth.json` shall be in the Windows profile's Codex folder, where the desktop app writes it at sign-in, and the home's `auth.json` shall be a link to it. `plan` shall report a reversed link, a missing file or two separate files as drift. Measured 2026-10-14: with the link the other way (Windows → Linux), the app could read the login but could not store a new sign-in ("credentials couldn't be stored locally").
- CH-3. The service shall leave the Windows profile's Codex folder a real directory, because the desktop app refuses a linked one.

## Bounded scan surfaces

- CH-4. The service shall keep the folder the Codex app searches to the threads the app lists that have been active within the record's idle limit, archiving the others with Codex's own `archive` command so they stay recoverable.
- CH-5. The service shall move conversation files that the app's thread database does not reference, and that are older than one day, out of the searched folder into the record's legacy folder, deleting nothing.
- CH-6. The service shall keep each declared workspace's generated paths out of git's untracked set through a managed block in that repository's `.git/info/exclude`.
- CH-7. The service shall run CH-4 and CH-5 on a schedule from the record, so the bound holds without a person or agent remembering it.
- CH-15. For each declared workspace with `gitMaintenance`, the service shall keep git's own scheduled maintenance enabled and its multi-pack index covering all but the record's `maxUncoveredPacks` packs, because every agent git command searches each uncovered pack. Measured 2026-10-14 on 262 packs with a stale index: `git log -n 20000` took 2.19 s, and 0.11 s after `git multi-pack-index write`. Maintenance had been configured but never scheduled.

## Configuration

- CH-8. The service shall keep each plugin MCP server the record disables switched off in the home's `config.toml` through a managed block.

## Observation and repair

- CH-9. When asked to plan, the service shall change nothing, shall not walk any tree larger than the searched folder's directory listing, and shall report each item as current or drift with its measured size.
- CH-10. When asked to apply, the service shall change only items not current, so a second apply changes nothing.
- CH-11. The service shall carry no host, user, path, size or brand in its code; every particular shall come from the parameter record.
- CH-12. The service shall run on Node's built-in modules alone.
- CH-13. The service shall not run PowerShell or restart WSL or the app; when a change needs a Windows action, it shall print the one command the owner runs.
- CH-14. The service shall run its schedule from a copy of itself and its record installed outside any git working tree, and `plan` shall report drift when that copy differs from the source, so that a checkout change (clean, submodule update, branch switch) cannot silently remove the scheduled job.

## Receiving conditions

1. `plan` exits 0 on a converged host and 2 on drift, naming the items.
2. `apply` run twice changes nothing the second time.
3. After apply, Codex's own search command over the searched folder completes in seconds, measured.
4. The retention timer is listed by `systemctl --user list-timers` and its last run succeeded.
