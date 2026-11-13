# Adjustment Flow

Use this flow to restructure an existing, partially executed plan so its unfinished part follows the current planning rules (typically a plan written before file ownership, agent hints, context packets, and wave-oriented phases existed). Read this file in full before acting. Completed work is history: never rewrite it.

## 1. Baseline

Resolve `<project-path>` and `<plan-name>`. Never run `ppm init` here; if `plan_status` reports `plan not found`, stop and ask. If the plan still lives in `docs/plans/`, run `ppm migrate --dry-run`, then `ppm migrate`, first.

```bash
ppm plan_status --plan <name> [--project <project-path>]
ppm plan_validate --plan <name> [--project <project-path>]
ppm plan_waves --plan <name> [--project <project-path>]
```

Keep this output as the baseline. Record the completed count per phase.

- Any task `in_progress`: stop and ask the user to let it finish or approve `ppm task_reset` for it. Never restructure under a running worker.
- Back up before editing: `cp -r <project-path>/.ppm/<name>/tasks <project-path>/.ppm/<name>/tasks.bak-YYYYMMDD` (`.ppm/` is often not in git).

## 2. What may change

| Scope | Rule |
|---|---|
| Phase whose tasks are all `completed` | Frozen. Do not edit, rename, or delete the file. |
| `completed` task in an unfinished phase | Frozen: keep `id`, `title`, `status`, `progress` byte-for-byte. The `detail` field is reinterpretted as a context packet (`details.goal`, `details.contract`, `details.steps`, `details.verify`). It may be listed in `pre_request` of new tasks. Adding `files`/`agent` is not required. |
| `todo` / `fail` task in a started phase | Rework freely: split, merge, rewrite `detail` as a context packet (`details` object with `goal`, `contract`, `steps`, `verify`), add `files` and `agent`, rewire `pre_request`, add a closing `verify`/`review` task. |
| Phase with no `completed` task | Rework fully: tasks, order, merge or split phases. |
| `fail` task being replaced | Carry its `progress` (failure evidence) into the successor task's `details` under a `Prior attempt:` line. The `progress` array entries `{ time, detail }` are preserved byte-for-byte. |

Phase files stay `phase_<n>.json` with `phase` equal to the filename. Frozen phases keep their names; reworked phases may be renumbered after the last frozen one. Delete a phase file only when all its tasks were moved elsewhere.

Task IDs: keep IDs of retained tasks. New tasks get new IDs; never reuse the ID of a removed task. New tasks start as `todo` with empty `progress` automatically.

Make every change through `ppm task_upsert` (send only the changed fields of a retained task; new tasks in full) and `ppm task_remove`, as described in planning-flow.md "Writing tasks". Do not write or edit phase JSON files. Both commands refuse `in_progress`/`completed` tasks, which protects frozen work. Upsert new tasks before removing the old ones they replace, and rewire dependents' `pre_request` first so the removal is not blocked. A `fail` task keeps its status when patched; reset it with `ppm task_reset` only when it should run again.

## 3. Rework

Apply every rule in [planning-flow.md](planning-flow.md) sections "Task JSON contract" (including "Writing tasks") and "Designing for parallel sub-agent execution" to the reworked part: phases as sync barriers, file ownership with hotspots owned by one task, context-packet `detail`, `agent` hints, one closing task per phase, task sizing. Inspect the current source first: completed work may have changed what the remaining tasks need. Do not duplicate work already `completed`.

## 4. Verify

Iterate until all hold:

- `ppm plan_validate` prints `Plan valid` with no errors. Remaining warnings may only concern frozen `completed` tasks.
- `ppm plan_status` shows the same completed count per retained phase as the baseline.
- `ppm plan_waves` shows real parallelism for the reworked phases (not one task per wave without reason).
- `diff -r` against the backup shows no change in frozen phases or frozen tasks.

## 5. Record

Append to `plan.md` and update its `Last updated:` date:

```markdown
## Adjustment log

### YYYY-MM-DD
- Reason: ...
- Frozen: phase_0, phase_1 (tasks 1.1, 1.2)
- Reworked: ...
- ID map: 1.3 -> 1.3a, 1.3b; 2.1 removed (merged into 2.4)
- Backup: tasks.bak-YYYYMMDD
```

## 6. Report

Report baseline vs final `plan_status` and `plan_waves`, the ID map, remaining warnings with justification, and the backup path. Do not execute tasks in this flow; hand off to the execution flow only if the user asks.
