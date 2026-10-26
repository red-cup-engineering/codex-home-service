# Codex home service: design

## Scheduled execution receiving (CH-36)

The existing health plan reads only seven named fields from the original
`codex-home-retention.service`, with a five-second and 16 KiB native read bound.
It reports execution independently of the timer, unit text and installed-copy
checks. A failed result remains drift even when the timer is enabled. The
service's declared success exits 0 and 2 count only after a completed run;
exit 2 retains its existing meaning of unresolved plan drift. A live process
is reported as running, never completed. Missing, partial, repeated or
malformed fields and an unobserved first run remain unknown. The observation
does not start the service or inspect scratch. Scoped timer installation stays
under this owner's existing atomic installed-copy and unit reconciliation.

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
- **Archive through Codex.** the native `thread/archive` operation moves the rollout to `archived_sessions` and marks the thread archived in its database. The app can show and unarchive it. The service never opens private provider storage and never deletes a log.
- **Legacy files are moved, not archived.** Files the thread database does not reference are invisible to the app, so `archive` cannot address them; they move to the record's legacy folder on the same filesystem (a rename).
- **Thread metadata belongs to the provider.** One native stdio connection initializes once, pages active and archived thread metadata with all source kinds and useStateDbOnly=true, then exits. That flag disables provider log-scan repair. A five-second total deadline, 2 MiB output cap and twenty-page limit refuse an incomplete result. No conversation starts or resumes, no model is called, and no private storage is opened by house code. Scoped retention uses thread/archive on that same connection.
- **The login is a Windows file, linked from Linux.** The desktop app writes `auth.json` at sign-in and cannot write through a link into the Linux filesystem. The app-server reads one small file over the drive mount, which is cheap: the bridge cost that matters is walking thousands of files. `apply` makes the flip itself from Linux, but only when the two files are identical or one is missing. Two different credential files are the owner's choice.
- **Parent before child.** Archiving a parent thread archives its sub-agent threads; a later archive of a child then fails as already archived and is counted as done.
- **Scratch expires by entry, never by file.** An age sweep per file (systemd-tmpfiles' `e` lines) would delete old files inside a checkout someone is still working in. The unit is each top-level entry under a scratch root, which is how agents lay out one task's working data. Its age is the newest directory mtime (directories change on every create, delete and rename), its own files' mtimes, and each checkout's index and HEAD log, read to a fixed depth and stopped at the first recent change. Checkouts are protected by git's own answer (`status`, commits not on any remote), not by guessing. An entry too large to read within the limit is kept and reported.
- **The timer is a user unit.** Retention needs no root. It runs hourly, so CH-18 sees a falling floor within the hour, and on boot after a delay.
- **The timer runs an installed copy.** `apply --scope=timer` copies `package.json`, `src/`, `scripts/` and the record to the record's `installDir`, and the unit executes that copy. On Bare Cedar Fog the service sits in a submodule that agents work in, often detached and uncommitted, where a `git clean` or `submodule update` would otherwise remove the file the schedule runs.
- **Headroom is read on both sides of the disk image (CH-18, CH-19).** Inside the VM, ext4 sees its virtual size (1 TB on Bare Cedar Fog), not the host volume the image grows into. The image's logical length can retain the filesystem's high-water mark (542 GiB image on 467 GB used, 2026-10-19); sparse or compressed allocation can differ. The trigger reads both free spaces (two `statfs` calls) and the image's logical size (one `stat`), and trips on whichever side is short. Deleting inside the VM does not itself prove that space returned to the host. This service reports only an apparent logical gap and explicitly unknown allocation/reclaim; the original WSL host plan owns the native physical allocation observation. Compaction is a separate exact-disk operation, so this service retains the existing WSL maintenance referral when the apparent gap warrants receiving. These mounted-filesystem observations are advisory and cannot reopen fabrication; missing either pressure observation holds scratch retirement.
- **Store reclamation stays with its existing owner.** This service executes no Guix GC or compaction. Legacy active GC or compaction selectors refuse before cleanup and before timer installation; inactive provenance is not a selector. The timer installer is an admission boundary for its future record, even though it executes no cleanup itself. The matching record retains old command/tool identity as inactive provenance and refers the remaining exact-disk/checkpoint/physical-capacity obligation to WSL maintenance. Generation roots remain explicitly kept, rather than assuming rootless paths are disposable.
- **Derived directories are opaque to the idle check (CH-20).** A directory of installed dependencies changes when it is installed, not when anyone works in it, and it can hold tens of thousands of directories. The check counts its own change time and does not enter it, so the directory limit is spent on the work itself.
- **A branch in a repository outside the entry is as good as a remote (CH-21).** A linked worktree's branches live in its repository's common directory. When that directory is outside the scratch entry, removing the entry leaves the branches, so the check asks git for commits on no remote and no branch. A clone inside the entry keeps the stricter question, because its branches go with it.
- **The user manager is reached directly (CH-22).** A `wsl.exe` shell has no `XDG_RUNTIME_DIR`, so `systemctl --user` finds no bus. The service supplies `/run/user/<uid>` when it is unset, where the manager that runs the timer listens.

## Parameter record

### Bounded checkout proof and delegated retirement (2026-10-23)

The ordinary health plan previously blocked for several minutes inside an
unbounded native `git status --untracked-files=normal`. It also treated old
deployment-engine runtime/source/agency entries as generic age-expirable even
when a received release still referenced their original composition. Neither an
age nor an apparently clean source tree is lifecycle authority for that data.

Checkout proof remains with native Git. It first binds the exact real scratch
checkout and native top-level identity, rejecting ancestor/cross-root discovery
and the record's home/workspace roots. Each child has a 500 ms timeout, a 64 KiB
output cap, SIGKILL on deadline and native child reaping; all checkout queries in
one scratch observation share a five-second monotonic budget. The child receives
no inherited alternate Git directory/index/config/trace bindings. Command-line
configuration disables optional index locks, filesystem monitors, hooks,
untracked caches, index preloading and submodule recursion. A bounded index read
refuses submodule-bearing or oversized checkouts before status. Ordinary small
isolated checkouts still use native untracked status and native reachability;
timeout, excess output or uncertain scope holds the entry. There is no added
directory catalogue, index refresh or whole-workspace fallback.

Each existing `scratch.roots` declaration may instead carry `retirementOwner`,
a canonical HTTPS service URL with a nonempty path and no credentials, query or
fragment. Validation runs before observation effects or timer installation.
That root contributes one held summary naming the existing owner and is never
listed or passed into activity/Git/removal logic. Delegating a deployment root
holds all its current and unknown children without enumerating versions; its
original owner's retained lifecycle receipt remains the reopening contract.
The operations record owns the actual delegation; source code embeds no host,
deployment version or per-task retention exception. No timer is activated by
this source repair.

Receiving includes original clean/untracked/unpushed and linked-worktree cases,
actual native timeout/reaping and output bounds, protected/ancestor refusal,
native index/monitor nonmutation, and a delegated root containing both a live
composition and an unknown child. Observation and scratch-only apply preserve
both, with an explicit no-list boundary and malformed-identity refusal.

`codex-home-parameters@1`: `home`, `windowsProfileCodexDir` (as mounted in Linux), `windowsProfileCodexDirWindowsPath`, `homeWindowsPath`, `codexBinaryGlob`, `node`, `shellRc`, `loginProfile`, `installDir`, `retention` (`idleDays`, `legacyDir`, `searchedSoftLimitBytes`, `schedule`), `workspaces[]` (`path`, `excludes[]`), `disabledPluginMcpServers[]` (`plugin`, `server`), `scratch` (`idleDays`, `opaqueDirs[]`, `roots[]` with `path`, `keep[]`, `match`), `headroom` (`vmVolume`, `hostVolume`, `diskImage`, `floorBytes`, `idleHours`, `compactAboveBytes`, `maintenanceReferral`, inactive `legacyMaintenance` provenance), and free provenance fields (`observed-*`).

## Residual work

- Dead-turn repair (closing turns orphaned by an app-server death) is today's `codex_unfreeze.py` in the Bare Cedar Fog operator's Claude skills; it moves into this service as `repair`.
- A store path that an installed unit executes is safe from CH-18's collection only while some root holds it. The service does not yet root those paths itself; on Bare Cedar Fog the record keeps the scratch entry that holds them.

## Scoped installed-copy receiving

`apply --scope=timer` first refuses active legacy maintenance selectors, then selects only the existing installation/unit branch: four source files plus the exact parameter record, the existing service/timer definitions, daemon-reload only if those definitions changed, and enable --now of that same timer. It does not select placement, retention, scratch, workspace, Guix or compaction. Installed files are staged exclusively, fsynced and renamed, so a concurrent reader cannot parse a truncated source. Before the operational repair, independently receive source/record and recheck the existing service PID/job, original installed digests and actual timer identity; preserve uncertainty rather than overlap an active retention invocation. Preserve the hourly schedule and original work. Source tests are distinct from actual installed-copy receiving and the later ordinary timer outcome.

## Low-read health and shared provider control (2026-10-23)

The ordinary plan lists only the searched session files and reads declared small configuration files. It does not call scratch observation, process-file-descriptor enumeration or checkout proof. Each scratch root is explicitly held without a listing; this is not a claim that it is clean. Scoped scratch apply retains all existing idle, open-process, mount, native Git and delegated-owner protections.

Optional `harnessResources` selects one absolute zero-dependency owning controller source, workspace paths, provider names and explicitly retired source references. `plan` uses its dry-run reconciliation; `apply --scope=harness` repairs only those local provider registrations. Both providers reference the same executable source. The source path is checked on every plan, so a source relocation appears as drift. No hook bodies, credential files, provider trust records or standing instructions are copied. The installed service keeps the source selection in its existing parameter record. Codex trust and already-running session uptake remain separate provider observations.

Scoped scratch activity now shares a 250 ms / 1,024-entry metadata budget across all roots, with at most 256 descendant directories per entry. Iteration uses native directory handles and closes them on early return instead of first materializing a complete directory listing. Exhaustion and unreadable activity hold retirement; they never turn missing evidence into permission to delete. Existing native Git proof retains its separate aggregate deadline.

The shared controller now refuses known heavy work if flock or its shared lock is unavailable; a lock that disappears between rewriting and execution returns admission status 75 without executing the command. Busy waits and exactly-once markers retain their existing behavior. Explicit provider disable/allow-list modes remain visible limitations; the host cgroup still bounds processes independently.

Receiving witnessed Claude's workspace settings being replaced again after the first repair. A one-time file write is therefore insufficient. When harnessResources is declared, the existing timer adds only the harness scope to its existing retention/scratch invocation and unchanged hourly cadence. Reconciliation merges unrelated hooks and rewrites only declared missing/stale source references; it grants no provider trust and makes no claim about a running process.

Native protocol: https://learn.chatgpt.com/docs/app-server. The selected provider binary remains in the operations record. A missing rollout path can be joined only to a unique id in the already-read finite session-file list. Ambiguous or incomplete provider metadata holds both archive and legacy moves; it never authorizes a storage crawl. Provider-internal persistence is outside this service's implementation.

### Effective parent budget for shared containment

Shared work containment uses the destination user manager's effective memory allocation. A 12GiB VM with user.slice at4GiB previously received work high5552209920/max7402946560 from VM fractions, so a3.4GiB npm process throttled the parent and prevented its900-second timeout from completing termination for37minutes. The existing harness now reads only memory.high/memory.max of the four known destination ancestors and takes their minimum with physical memory before applying its unchanged45%/60% shares. Bare Cedar Fog therefore declares work high1843M/max2457M within the received4GiB parent. Session protection, heavy slots, CPU/I/O weights, zero work swap and provider trust remain under their existing owners. Codex-home's record explicitly selects the existing shared containment installer; its harness apply and scheduled reconciliation install the same units instead of merely refreshing hook references. Dry-run has no installation effects; source-reference registration alone is not a claim of active provider enforcement.

### Independent scopes, running sessions, proof budgets (CH-32..CH-34)

`apply` splits into one function per scope, run in the listed order (harness, placement, retention, scratch, workspace, config, timer). After the record-level refusals, a scope that throws is logged as `FAILED <scope>: <message>` and the next scope runs; `applyScopes` returns `{ log, notes, failures }` (`notes` is what was seen and left, such as the scratch kept-and-why summary, and is not a change), `apply` keeps returning the log and throws `ApplyFailed` carrying log and failures, and the command exits 1. The retention scope depends on a provider binary on the Windows drive that sometimes does not answer in time; it must not decide whether scratch is expired.

A scratch root's `liveSessionFlags` reads the running processes' command lines once per run and keeps entries named by a session id they carry; it adds to, and does not replace, the open-file check, because an open directory handle is the vendor's incidental behaviour.

`scratch.proofBudget` replaces one shared 250 ms / 1,024-read budget with per-entry budgets under an overall deadline. A root's own `proofBudget` overrides the per-entry limits for that root only. Active entries still cost a few reads. The checkout proof gains `protocol.allow=never` and `GIT_TERMINAL_PROMPT=0`, which makes lazy fetching impossible on any Git version (`GIT_NO_LAZY_FETCH` exists only from Git 2.44) and so lets blobless clones be proven instead of held for good. Windows backing capacity: `headroom.hostVolume` is `statfs` of the drive that holds the disk image, which is the volume `wsl-host` observes with PowerShell; reading that observation here would start a Windows program on every run, so CH-18 keeps its own `statfs` and its own floor.

### Retiring on an event (CH-35)

The scratch scope retires by age and so needs something to run it; `retire` is the same decision, for one named session and with no idle wait, for something that knows a session ended. The caller is the harness's SessionEnd hook (agent-harness `src/session-end-scratch-hook.mjs`), which hands over the session id and the session process id and returns. Pressure triggers (a PSI trigger on `/proc/pressure/io`, a crossing of `headroom.floorBytes`) would call `apply --scope=scratch`; no source of the second kind exists inside the VM (free space has no change notification, and the Windows volume is reachable only through a Windows program), so it stays unwired here.
