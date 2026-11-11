# Codex home

Manage the Codex home and its retention, scratch, workspace, configuration,
timer and harness scopes from the owning machine’s parameter record. The
[requirements](specifications/requirements.md) describe the boundaries and
the [design](specifications/design.md) explains how the scopes reconcile.

```sh
codex-home plan --parameters=/path/to/codex-home.json
codex-home apply --parameters=/path/to/codex-home.json --scope=harness
```

Run `plan` to inspect drift. Use `apply` with the intended scope to
reconcile it. Exit status 0 means converged, 2 means drift remains and 1
means a scope failed. The command prints the result for each selected scope.

Run `npm test` from the mounted service checkout. Harness integration tests
find the source owner through the Git superproject. In a standalone clone
or tarball receiving check, set `CODEX_HOME_HARNESS_ROOT` to the absolute
path of the Agent Harness source checkout before running the same suite.
The tests exercise that owner’s real installer against temporary
workspace directories.
