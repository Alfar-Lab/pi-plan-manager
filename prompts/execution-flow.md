# Execution Flow

Use this flow for executing, continuing, or resuming a plan. Read this file in full before acting. Use `ppm` as the exclusive interface for reading and changing phase task data; do not read or edit phase JSON with generic file tools.

## Initialize and order

Resolve `<project-path>` and `<plan-name>`. Execution never creates plans: do not run `ppm init` here, because a mistyped name would silently create an empty plan. If the plan does not exist, `ppm plan_status` fails with `plan not found`; stop and ask the user, or switch to the planning flow.

Get phase order and the current phase from the CLI. Do not use memory, filenames, or `plan.md` to claim completion:

```bash
ppm plan_status --plan <plan-name> [--project <project-path>]
```

Start at the `Current:` phase it reports and process phases in numeric order without skipping.

Read `<project-path>/.ppm/<plan-name>/plan.constraint_invariant.md` once before dispatching: its rules are part of every verification in step 6. Read `plan.md` only for `Base commit:`. Do not load the other plan files during execution unless a worker reports a conflict that the task details cannot settle. Workers never read plan files; everything they need is in `ppm task_get`.

## Roles

- Orchestrator (you, the main agent): reads the schedule, dispatches tasks, verifies results, and owns every status change (`task_in_progress`, `task_completed`, `task_fail`, `task_reset`).
- Worker (a sub agent, or yourself when no sub agents exist): executes exactly one task, writes progress with `ppm task_write_progress`, and reports back. Workers never change status and never touch another task.

If the client has no sub agents, run the same loop yourself one task at a time.

## Mandatory task loop

Phases are processed strictly in numeric order. Inside a phase, tasks with no `pre_request` (or `pre_request: []`) are independent and may run in parallel; tasks with `pre_request` entries must wait until every referenced task reaches `completed`. Plan model: sequential phases, parallel waves inside a phase.

Before the first phase, run `ppm plan_validate --plan <name>` and `ppm plan_waves --plan <name>`. Stop and report if validation has errors. Use the wave view to plan dispatch width.

1. Call `ppm task_ready --plan <name> --phase <phase_x>` to get the current wave: `todo` tasks with all `pre_request` dependencies `completed`. Optionally call `ppm task_blocked` to inspect waiting dependencies.
2. If the ready set is empty, act on the reason `task_ready` prints:
   - `In progress: ...` only: normal while workers run. Wait for them, then continue.
   - `Failed: ...` and no `In progress`: the phase is stuck. Stop and report, unless the user asked to retry.
   - `Blocked: ...` with neither of the above cannot happen in a valid plan; run `ppm plan_validate` and report.
   - `Phase <x> complete. Next: <y>`: go to step 10.
3. `task_ready` already lists each ready task with its agent hint and owned files. For each, call `ppm task_get` (full Detail, plus Progress when resuming), then `ppm task_in_progress`. Status commands report newly unblocked tasks and phase completion, so you rarely need an extra `task_list`. The CLI rejects blocked tasks and tasks whose earlier phase is not fully `completed`; do not bypass with `--force` unless the user explicitly asks.
4. Dispatch all ready tasks of the wave in parallel, in a single batch, one worker per task. Map the `agent` hint to the closest available sub agent type: `explore` to a read-only explorer, `implement` to an editing/coding agent, `review` to a reviewer, `verify` to an agent that can run commands. Without a hint, pick by the task detail.
5. The dispatch prompt must be self-contained, because workers start with no context. Include: project root, plan name, the complete `ppm task_get` output verbatim (it already carries phase, task ID, agent, owned files, Detail, and Progress), the rule "modify only the listed Files; report instead of editing anything else", the exact `ppm task_write_progress --plan <name> --phase <phase_x> --task-id <id> [--project <path>] --progress-text "..."` command to record evidence, and the rule "do not change task status".
6. When each worker returns, verify with real command output before trusting its summary: run the task's `Verify` commands, check the diff stays inside the owned `files`, and check it breaks no rule in `plan.constraint_invariant.md`. Out-of-scope edits and constraint violations count as a failure.
7. Record the verification evidence with `ppm task_write_progress` (appends a timestamped entry; `--replace` only to deliberately overwrite).
8. Verified: `ppm task_completed`. Not verified: re-dispatch once with the exact defect; if it fails again, write the failure context, call `ppm task_fail`, and stop unless the user explicitly requests continuation. A `fail` keeps dependents blocked until `ppm task_reset` or a successful retry via `ppm task_in_progress` then `ppm task_completed`.
9. Repeat from step 1 for the next wave. The phase's closing integration/verify task runs last and gates the phase.
10. Continue to the next phase. Stop only when `ppm plan_status` reports `Current: none (plan complete)`.

Never dispatch two concurrently running workers that own the same file; `plan_validate` guarantees this for planned tasks, so preserve it if you add ad-hoc work.

The only valid statuses are `todo`, `in_progress`, `completed`, and `fail`. Allowed transitions: `todo|fail -> in_progress`, `in_progress -> completed|fail`, `todo -> fail`, and any non-`todo` status `-> todo` via `task_reset`. Preserve task identity and stable IDs.

## Dashboard

Before quoting any dashboard URL to the user, run `ppm check_dashboard [--port <port>]` and act on its output: start a missing server with `ppm dashboard_serve [--project <path>] [--port <port>]`, then re-check and share the verified URL. Never invent a `127.0.0.1:<port>/task.html` URL without that confirmation.

## Completion report

Confirm plan completion through `ppm plan_status`, then read the `## Done when` section of `plan.objective.md` and check every criterion with real command output. An unmet criterion means the plan is not done: report it and stop (or, if the user asks, add tasks through the adjustment flow). Report changed files, statuses, verification evidence, unresolved questions, failures, and whether the plan is complete.

## Execution command reference

Append `--project <project-path>` to any command when not running from the project root.

```bash
ppm plan_status --plan <name>
ppm plan_validate --plan <name>
ppm plan_waves --plan <name>
ppm task_list --plan <name> --phase phase_0
ppm task_ready --plan <name> --phase phase_0
ppm task_blocked --plan <name> --phase phase_0
ppm task_get --plan <name> --phase phase_0 --task-id TASK-001
ppm task_in_progress --plan <name> --phase phase_0 --task-id TASK-001
ppm task_completed --plan <name> --phase phase_0 --task-id TASK-001
ppm task_fail --plan <name> --phase phase_0 --task-id TASK-001
ppm task_reset --plan <name> --phase phase_0 --task-id TASK-001
ppm task_write_progress --plan <name> --phase phase_0 --task-id TASK-001 --progress-text "Implemented endpoint; verification passed."
```

Output formats (one line per item, empty fields omitted):

- `plan_status`: `<phase> <title>: <done>/<total> done | in_progress: <ids> | fail: <ids>` per phase, then `Current: <phase>` or `Current: none (plan complete)`.
- `task_list`: `<id> [<status>] <title> (after <deps>)`; `+progress` marks a `todo` task that has progress from an earlier attempt.
- `task_ready`: `Ready <n>:` then `<id> [<agent>] <title> | files: <files>`. When empty it says why: `No ready tasks. Phase <x> complete. Next: <y>` (or `Plan complete.`), or `No ready tasks.` followed by `In progress: <ids>.`, `Failed: <ids>.`, `Blocked: <id> (waiting <ids>).` as applicable.
- `task_blocked`: `<id> <title> | waiting: <ids>`.
- `task_get`: header `<id> [<status>] <title>` (todo shows `ready` or `blocked: waiting <ids>`), a meta line `Phase | After | Agent | Files`, `## Detail`, and `## Progress` only when present. The output is self-contained and can be forwarded to a worker as-is.
- Status commands: `<id>: <old> -> <new>.` plus `Unblocked: <ids>.` and `Phase <x> complete. Next: <y>` when applicable. `task_write_progress`: `<id>: progress appended|replaced`.
- `plan_waves`: waves per phase, critical path, and a summary line. Status commands accept `--force` to skip transition guards (manual repair only).
