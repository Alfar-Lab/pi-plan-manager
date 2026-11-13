# Audition Flow

Use this flow to audit or review a plan before execution. Read this file in full before acting. Audition is read-only unless the user separately requests fixes.

## Resolve and inspect safely

Resolve `<project-path>` and `<plan-name>`. Do not initialize or register anything during the audit. Pass `--project <project-path>` to CLI commands when explicit project resolution is needed. If the plan or required files do not exist, report that evidence and return `not_ready`; do not create them. Inspect `plan.md` and all four `plan.*.md` files under `<project-path>/.ppm/<plan-name>/`. Use the read-only CLI for phase order, schema validity, and task data:

```bash
ppm plan_validate --plan <name> [--project <project-path>]
ppm plan_status --plan <name> [--project <project-path>]
ppm plan_waves --plan <name> [--project <project-path>]
ppm task_list --plan <name> --phase <phase_x> [--project <project-path>]
ppm task_get --plan <name> --phase <phase_x> --task-id <id> [--project <project-path>]
```

A `plan_validate` failure is a `blocker` finding. Do not call status or progress mutation commands. Never mark a task, write progress, or rewrite the plan during an audition.

## Audit criteria

Assess:

- objective and scope clarity;
- source requirement traceability;
- assumptions versus verified facts;
- phase ordering and dependencies;
- task atomicity and actionability;
- stable IDs and valid `todo|in_progress|completed|fail` statuses;
- plan-to-task and task-to-deliverable coverage: every phase matches its `plan.approach.md` entry, every `plan.objective.md` Done when criterion is covered by some task's `verify`, and constraints that tasks must honor appear in their `details.contract`;
- acceptance and verification specificity;
- referenced-path existence;
- risks and mitigations;
- feasibility;
- security and privacy;
- rollback or migration needs where applicable;
- parallel efficiency: phases used only as real sync barriers, wave width and critical path from `plan_waves`, false `pre_request` dependencies;
- file ownership: every concurrent task declares `files`, no overlaps, hotspot files owned by a single foundation or integration task;
- context packets: each `details` is self-contained (`goal`, `contract`, `steps`, `verify`) with no references to other tasks or plan files, and owned paths appear only in `files`, never as a `Files:` section inside `details`;
- `agent` role hints and a closing integration/verify task per phase;
- execution readiness.

Treat `plan_validate` warnings as `minor` or `major` findings depending on impact; a mostly serial plan with no justification is `major`.

Do not invent requirements. Avoid implementation redesign beyond plan scope.

## Findings and output

Classify every finding as `blocker`, `major`, `minor`, or `note`. Include exact phase/task IDs and evidence where applicable. Distinguish `verified defect`, `ambiguity/open question`, and `recommendation`.

Output:

1. Verdict: exactly `ready`, `ready_with_minor_changes`, or `not_ready`.
2. Summary counts by severity.
3. Ordered findings, with type, severity, IDs, evidence, and impact.
4. Uncovered requirements.
5. Open questions.
6. Recommended remediation.
7. Commands and evidence used.

Do not mutate task status, write progress, initialize/register the project, or rewrite plan data unless the user separately asks for fixes. Report missing prerequisites and any failed read-only command.
