# Codex home service: design

## Theory

The Codex desktop app in WSL mode is a Windows process driving a Linux app-server. Three of its built-in operations read whole data sets on every use: the thread search (`rg` over every conversation log, per query), the per-turn git snapshot of the workspace (every untracked file), and the startup walk of the home's plugins and skills. Their cost is proportional to the size of what they read and to the cost per file of the filesystem it lives on. On WSL2 a Linux process reading the Windows drive goes through 9P, where per-file operations cost milliseconds (Microsoft, "Working across file systems": store project files on the Linux file system for performance).

So the defence is not a throttle on those operations, which people rightly turn off when it gets in their way, but bounds on what they read: the home on ext4, the searched folder limited to live threads, generated files out of git's untracked set. Each bound removes load instead of rationing it, so nothing pushes anyone to remove it.

Method for diagnosis is the USE method (Gregg): utilization, saturation and errors per resource, from counters. `plan` follows it: it reads sizes, links and small files. It never walks the workspace or greps the logs, because on this host that is the load being diagnosed.

## Shape

```
parameters (operations record) --plan--> items {current | drift, measured}
                                \--apply--> host (archive, move, managed blocks, timer)
```

- `src/codex-home.mjs`: pure functions (managed-block merge, retention selection, legacy selection, timer units) and the observers/appliers that touch the host.
- `scripts/codex-home.mjs`: the command line: `plan`, `apply [--scope=all|retention|placement|config|workspace|timer]`.
- Managed blocks are delimited by `# BEGIN codex-home-service` / `# END codex-home-service` and replaced whole, so the owner's other lines are never touched.

## Choices

- **The home is declared where the app's shell reads it (CH-1).** The desktop app forwards its own `CODEX_HOME` (the Windows profile's folder) into WSL through `WSLENV` and runs `bash -lc '... exec codex app-server'`. A login shell reads `~/.profile`; Ubuntu's `~/.profile` sources `~/.bashrc`, whose interactive guard returns before anything below it. The managed block therefore goes at the end of the record's `loginProfile` as well as the `shellRc` (for interactive shells that are not login shells), and the export there replaces the forwarded value. The check starts a login shell with the forwarded value set, so it fails the way the app would, and CH-17 reads the app-server's own environment. A running app-server keeps the home it started with; the owner restarts the app (CH-13).
- **Archive through Codex.** `codex archive <id>` moves the rollout to `archived_sessions` and marks the thread archived in its database. The app can show and unarchive it. The service never edits Codex's SQLite and never deletes a log.
- **Legacy files are moved, not archived.** Files the thread database does not reference are invisible to the app, so `archive` cannot address them; they move to the record's legacy folder on the same filesystem (a rename).
- **The thread database is read from a copy.** The service copies `state_5.sqlite` with its WAL to a temporary directory and reads the copy with `node:sqlite`, so it takes no lock on the live database.
- **The login is a Windows file, linked from Linux.** The desktop app writes `auth.json` at sign-in and cannot write through a link into the Linux filesystem. The app-server reads one small file over the drive mount, which is cheap: the bridge cost that matters is walking thousands of files. `apply` makes the flip itself from Linux, but only when the two files are identical or one is missing. Two different credential files are the owner's choice.
- **Parent before child.** Archiving a parent thread archives its sub-agent threads; a later archive of a child then fails as already archived and is counted as done.
- **Scratch expires by entry, never by file.** An age sweep per file (systemd-tmpfiles' `e` lines) would delete old files inside a checkout someone is still working in. The unit is each top-level entry under a scratch root, which is how agents lay out one task's working data. Its age is the newest directory mtime (directories change on every create, delete and rename), its own files' mtimes, and each checkout's index and HEAD log, read to a fixed depth and stopped at the first recent change. Checkouts are protected by git's own answer (`status`, commits not on any remote), not by guessing. An entry too large to read within the limit is kept and reported.
- **The timer is a user unit.** Retention needs no root. It runs hourly, so CH-18 sees a falling floor within the hour, and on boot after a delay.
- **The timer runs an installed copy.** `apply --scope=timer` copies `package.json`, `src/`, `scripts/` and the record to the record's `installDir`, and the unit executes that copy. On Bare Cedar Fog the service sits in a submodule that agents work in, often detached and uncommitted, where a `git clean` or `submodule update` would otherwise remove the file the schedule runs.
- **Headroom is read on both sides of the disk image (CH-18, CH-19).** Inside the VM, ext4 sees its virtual size (1 TB on Bare Cedar Fog), not the host volume the image grows into. The image grows when the filesystem first writes a region and does not shrink when files go; ext4 reuses freed blocks, so the image follows the filesystem's high-water mark (542 GiB image on 467 GB used, 2026-10-19). The trigger therefore reads both free spaces (two `statfs` calls) and the image's size (one `stat`), and trips on whichever side is short. Deleting inside the VM does not return space to the host. Compaction is a separate exact-disk operation, so this service reports the existing WSL maintenance owner once the gap warrants receiving. These mounted-filesystem observations are advisory and cannot reopen fabrication; missing either pressure observation holds scratch retirement.
- **Store reclamation stays with its existing owner.** This service executes no Guix GC or compaction. Legacy active GC or compaction selectors refuse before cleanup and before timer installation; inactive provenance is not a selector. The timer installer is an admission boundary for its future record, even though it executes no cleanup itself. The matching record retains old command/tool identity as inactive provenance and refers the remaining exact-disk/checkpoint/physical-capacity obligation to WSL maintenance. Generation roots remain explicitly kept, rather than assuming rootless paths are disposable.
- **Derived directories are opaque to the idle check (CH-20).** A directory of installed dependencies changes when it is installed, not when anyone works in it, and it can hold tens of thousands of directories. The check counts its own change time and does not enter it, so the directory limit is spent on the work itself.
- **A branch in a repository outside the entry is as good as a remote (CH-21).** A linked worktree's branches live in its repository's common directory. When that directory is outside the scratch entry, removing the entry leaves the branches, so the check asks git for commits on no remote and no branch. A clone inside the entry keeps the stricter question, because its branches go with it.
- **The user manager is reached directly (CH-22).** A `wsl.exe` shell has no `XDG_RUNTIME_DIR`, so `systemctl --user` finds no bus. The service supplies `/run/user/<uid>` when it is unset, where the manager that runs the timer listens.

## Parameter record

`codex-home-parameters@1`: `home`, `windowsProfileCodexDir` (as mounted in Linux), `windowsProfileCodexDirWindowsPath`, `homeWindowsPath`, `codexBinaryGlob`, `node`, `shellRc`, `loginProfile`, `installDir`, `retention` (`idleDays`, `legacyDir`, `searchedSoftLimitBytes`, `schedule`), `workspaces[]` (`path`, `excludes[]`), `disabledPluginMcpServers[]` (`plugin`, `server`), `scratch` (`idleDays`, `opaqueDirs[]`, `roots[]` with `path`, `keep[]`, `match`), `headroom` (`vmVolume`, `hostVolume`, `diskImage`, `floorBytes`, `idleHours`, `compactAboveBytes`, `maintenanceReferral`, inactive `legacyMaintenance` provenance), and free provenance fields (`observed-*`).

## Residual work

- Dead-turn repair (closing turns orphaned by an app-server death) is today's `codex_unfreeze.py` in the Bare Cedar Fog operator's Claude skills; it moves into this service as `repair`.
- A store path that an installed unit executes is safe from CH-18's collection only while some root holds it. The service does not yet root those paths itself; on Bare Cedar Fog the record keeps the scratch entry that holds them.

## Scoped installed-copy receiving

`apply --scope=timer` first refuses active legacy maintenance selectors, then selects only the existing installation/unit branch: three source files plus the exact parameter record, the existing service/timer definitions, daemon-reload only if those definitions changed, and enable --now of that same timer. It does not select placement, retention, scratch, workspace, Guix or compaction. Installed files are staged exclusively, fsynced and renamed, so a concurrent reader cannot parse a truncated source. Before the operational repair, independently receive source/record and recheck the existing service PID/job, original installed digests and actual timer identity; preserve uncertainty rather than overlap an active retention invocation. Preserve the hourly schedule and original work. Source tests are distinct from actual installed-copy receiving and the later ordinary timer outcome.
