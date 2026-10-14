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

- **Archive through Codex.** `codex archive <id>` moves the rollout to `archived_sessions` and marks the thread archived in its database. The app can show and unarchive it. The service never edits Codex's SQLite and never deletes a log.
- **Legacy files are moved, not archived.** Files the thread database does not reference are invisible to the app, so `archive` cannot address them; they move to the record's legacy folder on the same filesystem (a rename).
- **The thread database is read from a copy.** The service copies `state_5.sqlite` with its WAL to a temporary directory and reads the copy with `node:sqlite`, so it takes no lock on the live database.
- **The login is a Windows file, linked from Linux.** The desktop app writes `auth.json` at sign-in and cannot write through a link into the Linux filesystem. The app-server reads one small file over the drive mount, which is cheap: the bridge cost that matters is walking thousands of files. `apply` makes the flip itself from Linux, but only when the two files are identical or one is missing. Two different credential files are the owner's choice.
- **Parent before child.** Archiving a parent thread archives its sub-agent threads; a later archive of a child then fails as already archived and is counted as done.
- **Scratch expires by entry, never by file.** An age sweep per file (systemd-tmpfiles' `e` lines) would delete old files inside a checkout someone is still working in. The unit is each top-level entry under a scratch root, which is how agents lay out one task's working data. Its age is the newest directory mtime (directories change on every create, delete and rename), its own files' mtimes, and each checkout's index and HEAD log, read to a fixed depth and stopped at the first recent change. Checkouts are protected by git's own answer (`status`, commits not on any remote), not by guessing. An entry too large to read within the limit is kept and reported.
- **The timer is a user unit.** Retention needs no root. It runs daily and on boot after a delay.
- **The timer runs an installed copy.** `apply --scope=timer` copies `package.json`, `src/`, `scripts/` and the record to the record's `installDir`, and the unit executes that copy. On Bare Cedar Fog the service sits in a submodule that agents work in, often detached and uncommitted, where a `git clean` or `submodule update` would otherwise remove the file the schedule runs.

## Parameter record

`codex-home-parameters@1`: `home`, `windowsProfileCodexDir` (as mounted in Linux), `windowsProfileCodexDirWindowsPath`, `homeWindowsPath`, `codexBinaryGlob`, `node`, `shellRc`, `installDir`, `retention` (`idleDays`, `legacyDir`, `searchedSoftLimitBytes`, `schedule`), `workspaces[]` (`path`, `excludes[]`), `disabledPluginMcpServers[]` (`plugin`, `server`), and free provenance fields (`observed-*`).

## Residual work

- Dead-turn repair (closing turns orphaned by an app-server death) is today's `codex_unfreeze.py` in the Bare Cedar Fog operator's Claude skills; it moves into this service as `repair`.
