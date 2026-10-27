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
- CH-6. The service shall keep each declared workspace's generated paths out of git's untracked set through a managed block in its natively received Git common directory's `info/exclude`, including a linked worktree or absorbed submodule.
- CH-7. The service shall run CH-4, CH-5, CH-16 and CH-18 on a schedule from the record, so the bound holds without a person or agent remembering it.
- CH-15. For each declared workspace with `gitMaintenance: true`, the service retains Git's scheduled maintenance and multi-pack-index policy. Explicit `gitMaintenance: false` instead selects a per-repository maintenance hold: receive its exact native worktree, Git directory and common directory before workspace effects; remove only its scheduled-maintenance registration; and receive local `maintenance.auto=false` and `gc.auto=0`. Report held only when its exact registration is absent and both local settings are effective. Omission is unmanaged and shall neither release a hold nor perform maintenance. Preserve unrelated registrations, shared timers, other settings, Git objects and active work. A hold is temporary pending explicit original-owner resource-qualified resumption; application shall not invent approval, restore true, fetch, repack, collect, write a multi-pack index, stop timers or terminate work. Unregistering is not evidence that an already running maintenance process completed. Measured 2026-10-27: the repository was still registered and the hourly native scheduler ran despite both local automatic-maintenance settings already being held; explicit false previously had no effect. The earlier enabled policy addressed 262 packs with a stale index on 2026-10-14 (`git log -n 20000`: 2.19 s before, 0.11 s after an index write); performance benefit does not authorize production below the physical reserve.
- CH-16. Age shall select generic scratch candidates, never establish that their contents are disposable. Generic retirement shall remove only an independently received empty real directory owned by the current user, using native rmdir after rechecking its identity and emptiness. All nonempty entries, regular files, links, unreadable or changed identities and useful source remain for original-owner recovery/reuse/publication, regardless of age. Preserve existing keep, mount, open-process and delegated retirement-owner protections; exact terminal-owned artifact cleanup stays with its original producer. Leader2026-10-27 requires producing less data and preserving useful unpublished work; this supersedes the2026-10-26 age-only recursive deletion rule. No new storage/generation limit, timer or recursive source census is introduced.

## Scheduled execution receiving

- CH-36. `plan` shall separately observe the original retention service's current or last execution through one bounded native systemd read. An enabled timer, current unit text or current installed files shall not establish successful scheduled execution. A failed, missing, malformed or never-completed service observation shall report drift; a current process shall be distinguished from a completed run. The declared success exit 2 means the scopes ran with remaining plan drift, not that every machine obligation is resolved. This observation shall execute no retention, scratch scan, restart or retirement.

## Headroom

- CH-18. While free space on the VM's filesystem or on the host volume that holds the VM's disk image is below the record's `headroom.floorBytes`, the service shall expire scratch entries idle longer than `headroom.idleHours` instead of `idleDays`; unknown pressure shall hold scratch retirement. Automatic Guix collection is outside this service. Measured 2026-10-19: the VM's filesystem reported 490 GB free on its 1 TB virtual disk while the host volume had 1 GB, so a floor read inside the VM alone would never have tripped.
- CH-19. `plan` shall report the host volume's free space and the apparent gap between the disk image's logical length and the VM's filesystem use, and when that exceeds `headroom.compactAboveBytes` it shall report the existing WSL maintenance owner's held obligation (CH-13); it shall execute no GC or compaction. Logical length is not Windows physical allocation or safely reclaimable bytes. The original WSL host plan owns that separate native allocation observation. Mounted-filesystem pressure is advisory, never physical fabrication admission. Measured 2026-10-19: a 542 GiB image on 467 GB used.

## Configuration

- CH-8. The service shall keep each plugin MCP server the record disables switched off in the home's `config.toml` through a managed block.

## Observation and repair

- CH-9. When asked to plan, the service shall change nothing and read no scratch entries; it reports scratch retirement as held rather than claiming cleanliness. CH-16's proof belongs to explicitly selected scratch apply.
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
- CH-25. An optional scratch-root `retirementOwner` shall identify its existing lifecycle owner with a canonical credential-free HTTPS service identity. Observation and apply shall hold that entire root, including every current and unknown descendant, before any listing, age check or removal. A malformed owner identity shall refuse before effects, including installing it as the timer's future record. This field delegates retirement away from generic age policy; it grants no cleanup authority to either service.

- CH-26. The record-selected shared harness controller shall reconcile and inspect the workspace source references for both providers without copying executable bodies or manufacturing Codex hook trust; source registration alone never proves active-session enforcement.
- CH-27. Thread observation shall use the native provider metadata protocol with a five-second total deadline, finite output/page budgets and log-repair scanning explicitly disabled; unavailable metadata stays unknown without private-storage access or fallback.

Leader, 2026-10-23: "these giant disc-reads are KILLING our system" and "Where is your harness? Where is Claude's harness?". The failed carrier was a missing Claude workspace projection and a Codex hook pointing to a retired source path. Health itself repeated scratch metadata/checkout proofs and database copies. CH-9, CH-26 and CH-27 remove those reads and make registration drift visible through the ordinary owner.

- CH-28. Known heavy commands shall refuse when their shared admission lock or flock is unavailable, including a lock that disappears after rewriting; no lock failure may run the original command unlocked.

- CH-29. When harnessResources is selected, the existing retention schedule shall reconcile those exact provider registrations at its unchanged cadence, preserving unrelated hooks and provider trust.
- CH-30. When the record lists `shellPath`, the service shall declare those absolute directories ahead of the system ones in the same managed blocks that declare the Codex home (each added once however many shells nest), refuse a directory a shell would read as syntax, and report drift in `plan` like the rest of the block, so a host's login-shell `PATH` is changed by its record and never by a hand-edited startup file.
- CH-31. When the record lists `shellEnvironment`, the service shall export those variables in the same managed blocks, each value plain text or `${NAME}` references to variables already set, and refuse a name the block owns (`CODEX_HOME`, `PATH`) or a value a shell would read as syntax, so a tool's configuration can be named as a file credential custody renders under the credentials directory instead of a file in a home directory.
- CH-32. `apply` shall run each selected scope independently: one scope's failure is reported and every other selected scope still runs, and the command exits 1 when any scope failed (2 remains drift, 0 converged). A record the service refuses outright (CH-23, CH-25) stops every scope before any effect. Observed 2026-10-25: the hourly retention timer failed at its first scope on every run ("native thread provider exceeded its deadline during initialize": the provider binary lives on the Windows drive and does not answer within CH-27's five seconds), so the scratch scope after it never ran and agent scratch accumulated unexpired.
- CH-35. `retire --session=<id> [--after-pid=<pid>]` shall retire one ended session's scratch on an event instead of waiting for an age: in each scratch root without a `retirementOwner`, the entry named by that id goes at once through the same guards as the scratch scope (kept, mounted, open), the id being a plain name and never a path. With `--after-pid` it first waits for that process, the ending session, to exit, up to `--wait-seconds`, because a session's own process still holds its folder when its SessionEnd hook fires. A held entry is reported and left for the scratch scope; the command exits 0 whether it removed or held, so a hook that calls it never blocks a session. It is the entrance an agent harness's SessionEnd hook, or any pressure trigger, calls.

Leader, 2026-10-23: "We shuoldn't have any sqlite or sql anywhere lol". CH-27 replaces direct private-storage access with the provider-owned thread/list and thread/archive protocol. The house service imports no SQL driver, issues no SQL and owns no provider database. Vendor internals remain vendor-owned; deleting or rewriting them is not a migration.

### Effective parent budget for shared containment

CH-27. A record-selected containment installer shall be reconciled by harness apply and its existing timer, with dry-run free of effects and active provider trust reported separately.

Shared work containment uses the destination user manager's effective memory allocation. A 12GiB VM with user.slice at4GiB previously received work high5552209920/max7402946560 from VM fractions, so a3.4GiB npm process throttled the parent and prevented its900-second timeout from completing termination for37minutes. The existing harness now reads only memory.high/memory.max of the four known destination ancestors and takes their minimum with physical memory before applying its unchanged45%/60% shares. Bare Cedar Fog therefore declares work high1843M/max2457M within the received4GiB parent. Session protection, heavy slots, CPU/I/O weights, zero work swap and provider trust remain under their existing owners. Codex-home's record explicitly selects the existing shared containment installer; its harness apply and scheduled reconciliation install the same units instead of merely refreshing hook references. Dry-run has no installation effects; source-reference registration alone is not a claim of active provider enforcement.
