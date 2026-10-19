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

Measured 2026-10-18 (record, `observed-2026-10-18`): after the desktop app's update to 26.1013 (installed 2026-10-17) the app-server ran with `CODEX_HOME=/mnt/c/Users/emsen/.codex` again while `plan` reported CH-1 current. The app forwards its Windows home through `WSLENV` and starts the app-server under `bash -lc`, a login shell that is not interactive; Ubuntu's `~/.bashrc` returns at its interactive guard before the managed block, and the check ran a login shell without that variable, so it saw the default. Rollouts (446 MB, 34 files), config, plugins and `.tmp` were back on the 9P bridge, and the active config lacked the CH-8 disable.

Measured 2026-10-19 (record, `observed-2026-10-19`): the Windows volume (952 GB) had 1 GB free, the Ubuntu disk image had grown to 542 GiB, and every command in the VM failed with an I/O error until WSL restarted. Inside the VM, ext4 reported 467 GB used and 490 GB free of a 1 TB virtual disk, so nothing in the VM saw the shortage. The Guix store held 220 GB, 141 GB of it reachable from no root, and nothing collected it. Agents kept working data in places the record did not declare: the workspace's `.tmp` (1,902 entries), `~/.local/state/561-group/antigravity-worktrees`, `~/.codex/worktrees`, Claude Code's `/tmp/claude-1000`. About 67 per-commit runtimes of installed dependencies (~0.85 GB and ~77,000 files each) sat inside two scratch entries that every release touched, so neither entry ever aged. `plan` reported the retention timer and git maintenance disabled while both had run that day, because `systemctl --user` found no bus from a `wsl.exe` shell.

Each requirement has one shall. Identifiers are stable.

## Placement

- CH-1. The service shall hold the Codex home on the Linux filesystem named by the parameter record, declared where a login shell reads it, and `plan` shall report drift when a login shell started with the Windows profile's Codex folder already in `CODEX_HOME`, as the desktop app starts one, resolves `CODEX_HOME` anywhere else or under a Windows mount.
- CH-2. The service shall keep one login credential: the real `auth.json` shall be in the Windows profile's Codex folder, where the desktop app writes it at sign-in, and the home's `auth.json` shall be a link to it. `plan` shall report a reversed link, a missing file or two separate files as drift. Measured 2026-10-14: with the link the other way (Windows → Linux), the app could read the login but could not store a new sign-in ("credentials couldn't be stored locally").
- CH-3. The service shall leave the Windows profile's Codex folder a real directory, because the desktop app refuses a linked one.

## Bounded scan surfaces

- CH-4. The service shall keep the folder the Codex app searches to the threads the app lists that have been active within the record's idle limit, archiving the others with Codex's own `archive` command so they stay recoverable.
- CH-5. The service shall move conversation files that the app's thread database does not reference, and that are older than one day, out of the searched folder into the record's legacy folder, deleting nothing.
- CH-6. The service shall keep each declared workspace's generated paths out of git's untracked set through a managed block in that repository's `.git/info/exclude`.
- CH-7. The service shall run CH-4, CH-5, CH-16 and CH-18 on a schedule from the record, so the bound holds without a person or agent remembering it.
- CH-15. For each declared workspace with `gitMaintenance`, the service shall keep git's own scheduled maintenance enabled and its multi-pack index covering all but the record's `maxUncoveredPacks` packs, because every agent git command searches each uncovered pack. Measured 2026-10-14 on 262 packs with a stale index: `git log -n 20000` took 2.19 s, and 0.11 s after `git multi-pack-index write`. Maintenance had been configured but never scheduled.
- CH-16. For each scratch root the record declares, the service shall remove every top-level entry that the root's `match` admits and in which nothing has changed for the record's `idleDays`, unless the record keeps it, a process has it open, a filesystem is mounted inside it, or a git checkout inside it has uncommitted changes or commits on no remote; and it shall prune the worktree registrations the removal leaves. Measured 2026-10-14: `~/.cache/561-group` held about 50 GB in 21 entries with no owner or expiry, 27 GB of it unchanged since 10-07..10-09, and the workspace's `.codex/worktrees` held 131 agent worktrees of which git still listed 35. The owner approved a 7-day limit the same day, and on 2026-10-19, after the disk filled, 2 days, with 6 hours under the headroom floor (CH-18).
- CH-20. CH-16's idle check shall not descend into the directories the record names in `scratch.opaqueDirs`, whose own change time still counts. Measured 2026-10-19: one runtime's installed dependencies were ~77,000 files, so an entry holding a few runtimes passed the check's directory limit and was kept as "too large to prove idle" for good.
- CH-21. For CH-16, a linked worktree whose commits are all on branches of a repository outside its scratch entry shall count as pushed, because removing the entry leaves those branches in place.

## Headroom

- CH-18. While free space on the VM's filesystem or on the host volume that holds the VM's disk image is below the record's `headroom.floorBytes`, the service shall expire scratch entries idle longer than `headroom.idleHours` instead of `idleDays`; unknown pressure shall hold scratch retirement. Automatic Guix collection is outside this service. Measured 2026-10-19: the VM's filesystem reported 490 GB free on its 1 TB virtual disk while the host volume had 1 GB, so a floor read inside the VM alone would never have tripped.
- CH-19. `plan` shall report the host volume's free space and how much the disk image holds beyond what the VM's filesystem uses, and when that exceeds `headroom.compactAboveBytes` it shall report the existing WSL maintenance owner's held obligation (CH-13); it shall execute no GC or compaction. Mounted-filesystem pressure is advisory, never physical fabrication admission. Measured 2026-10-19: a 542 GiB image on 467 GB used.

## Configuration

- CH-8. The service shall keep each plugin MCP server the record disables switched off in the home's `config.toml` through a managed block.

## Observation and repair

- CH-9. When asked to plan, the service shall change nothing, shall not walk any tree larger than the searched folder's directory listing, and shall report each item as current or drift with its measured size. CH-16's idle check is the one bounded exception: it reads directory metadata in each scratch entry to a fixed depth and stops at the first change inside the idle window.
- CH-10. When asked to apply, the service shall change only items not current, so a second apply changes nothing.
- CH-11. The service shall carry no host, user, path, size or brand in its code; every particular shall come from the parameter record.
- CH-12. The service shall run on Node's built-in modules alone.
- CH-13. The service shall not run PowerShell or restart WSL or the app; when a change needs a Windows action, it shall print the one command the owner runs.
- CH-17. `plan` shall read the `CODEX_HOME` of every running Codex app-server from its process environment and report drift when any differs from the record's home, because a shell that resolves correctly is evidence about the shell, not about the process.
- CH-14. The service shall run its schedule from a copy of itself and its record installed outside any git working tree, and `plan` shall report drift when that copy differs from the source, so that a checkout change (clean, submodule update, branch switch) cannot silently remove the scheduled job.
- CH-22. The service shall reach the user's service manager the way its own timer does, supplying the manager's runtime directory when the calling shell has none, so that `plan` never reports a running timer as disabled. Measured 2026-10-19: from a `wsl.exe` shell `systemctl --user` found no bus, and `plan` reported the retention timer and git maintenance disabled; both had run that day.

## Receiving conditions

1. `plan` exits 0 on a converged host and 2 on drift, naming the items.
2. `apply` run twice changes nothing the second time.
3. After apply, Codex's own search command over the searched folder completes in seconds, measured.
4. The retention timer is listed by `systemctl --user list-timers` and its last run succeeded.
5. With headroom below the floor, one apply leaves no scratch entry idle longer than `headroom.idleHours` except those CH-16 keeps, and preserves all original Guix roots and pending maintenance custody; no automatic store collection runs.

- CH-23. Legacy active `headroom.guix` or `headroom.compactCommand` selectors shall refuse before any scratch/retention effect or timer installation. Inactive `headroom.legacyMaintenance` provenance remains admissible. A timer-only installation shall copy the exact admitted code/record atomically without executing cleanup or maintenance, so an obsolete selection cannot reintroduce a future failing timer record.
