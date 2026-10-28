# Planning Flow

Use this flow for creating a structured project plan or breaking work into executable tasks. Read this file in full before acting.

## Resolve the project and plan

Resolve `<project-path>` explicitly when supplied; otherwise use the active working-directory project root. Ask when multiple roots are plausible. Use a lowercase kebab-case `<plan-name>` unless the project already follows another convention. Projects register in `~/.config/project-plan-manager/config.json`.

Before writing any plan file, initialize and register the target plan:

```bash
ppm init --plan <plan-name> [--project <project-path>]
```

The plan layout is:

```text
<project-path>/.ppm/<plan-name>/
|-- plan.md
`-- tasks/
    |-- phase_0.json
    |-- phase_1.json
    `-- phase_2.json
```

## Planning rules

- Inspect relevant source, configuration, and documentation before planning. Use evidence, not guesses: when a code-intelligence tool (code graph, LSP, references search) is available, use it to map which files each change touches, who calls/imports them, and which changes truly depend on others. That evidence drives file ownership and `pre_request`.
- Separate verified facts, assumptions, decisions, open questions, and future work.
- Do not invent requirements. Ask when missing information changes scope, behavior, acceptance criteria, or architecture.
- Make phases ordered, dependency-aware, independently verifiable, and traceable to deliverables.
- Link source requirements and related project documentation with relative paths.
- Include `Last updated: YYYY-MM-DD` in maintained Markdown files.
- Directly write newly created phase JSON during planning when needed; execution must use the CLI for task data.
- Inspect the execution environment before writing any `verify` step (see "Verification environment" below). A plan whose verify commands cannot pass in the real environment is an invalid plan.

## Mandatory plan.md format

Every `plan.md` must use this exact skeleton:

```markdown
# <Plan Name>

Created: <YYYY-MM-DD>
Last updated: <YYYY-MM-DD>

## 1. Objective

## 2. Source documents and requirements

## 3. Current-state findings

## 4. Constraints and invariants

## 5. Proposed approach

## 6. Dependencies

## 7. Risks and mitigations

## 8. Verification strategy

## 9. Definition of done
```

The headings, their order, and the `Created:` and `Last updated:` metadata labels are mandatory. `Created` remains the initial creation date. Change `Last updated` whenever `plan.md` or a phase plan definition is maintained. Do not add the previously used Ordered phases or Deliverables sections to the mandatory skeleton; phase delivery details belong in phase JSON or appropriate existing narrative. Every JSON task must trace to a phase deliverable.

## Task JSON contract

Each `tasks/phase_x.json` uses:

```json
{
  "phase": "phase_x",
  "title": "Phase title",
  "tasks": [
    {
      "id": "TASK-001",
      "title": "Short action-oriented title",
      "agent": "implement",
      "size": "M",
      "files": ["src/api/users.ts", "src/api/users/**"],
      "details": {
        "goal": "",
        "contract": "",
        "steps": ["Add something on A", "Create something on B"],
        "verify": ""
      },
      "status": "todo",
      "progress": [{ "time": "2026-10-26T19:42:51Z", "detail": "Something bla bla bla" }],
      "pre_request": ["TASK-002"]
    }
  ]
}
```

Invariants:

- `phase` matches the filename without `.json`.
- IDs remain unique and stable within a phase.
- Status is exactly `todo`, `in_progress`, `completed`, or `fail`. New tasks start as `todo`.
- `details` is the self-contained context packet: `goal`, `contract`, `steps` (array of concrete ordered steps), `verify` (exact commands and expected result). The executor maps it to whatever sub agents the client provides.
- `progress` is an array of `{ time, detail }` entries: factual execution records, verification evidence, or failure context.
- `pre_request` is optional. When present it lists task IDs within the same phase that must reach `completed` before this task can start. Omit it, or use `[]`, for independent parallel-eligible tasks. Entries must reference existing task IDs in the same phase, must not include the task itself, must not duplicate, and must not form cycles.
- `files` is the task's write ownership: repo-relative paths or globs (`*`, `**`, `?`). A literal path owns itself and everything under it, so `src/users` and `src/users/` both cover `src/users/x.ts`. No absolute paths, no `..`. A task may read anything but must only modify files it owns.
- `agent` is a client-agnostic role hint: `explore` (read-only investigation), `implement` (code change), `review` (read-only diff/plan review), or `verify` (run checks, report evidence). The executor maps it to whatever sub agents the client provides.
- `size` is the planner's own size estimate: `S` or `M`. `L` is not allowed; a task that feels like `L` must be split (see "Task sizing"). Defined in "Task sizing" below.

## Designing for parallel sub-agent execution

The plan is a schedule for an orchestrator dispatching tasks to fresh-context sub agents. Optimize for **small, safely finishable tasks first**, then for the fewest sequential waves with zero write conflicts and zero rediscovery. Never trade task size for wave count: a low-width plan made of small tasks is better than a high-width plan made of oversized ones.

### 1. Phases are sync barriers, not topics

A phase boundary forces every lane to stop until the whole phase is `completed`. Create a new phase only when the next work needs the verified, integrated result of the current phase (for example a shared contract that must exist and compile before consumers build on it). Express every other ordering with `pre_request` inside one phase. Prefer 2 to 4 phases; a plan with many single-topic phases is serial execution in disguise.

Default shape:

- `phase_0` Foundation: contracts first. Shared types, interfaces, schemas, signatures, stubs, migrations, config keys, and the shared algorithm as an interface plus tests (see section 3). Small, often serial.
- `phase_1..n` Fan-out: many independent tasks, each implementing one slice against the fixed contract.
- Closing task per phase: one small `verify` or `review` task whose `pre_request` lists every other task of the phase. It runs the phase verification and owns only the small registration files (see section 5).

### 2. File ownership (accuracy)

- Every task that can run concurrently with another must declare `files`.
- Tasks that may run at the same time must not own the same file. `plan_validate` fails on overlaps; fix by adding `pre_request` or moving the shared file to one task.
- Hotspot files touched by many slices (`package.json`, lockfiles, barrel `index` files, route/DI registries, migration numbering, shared config) belong to the foundation task or the closing task, never to several fan-out tasks.
- Migrations are owned by exactly one task, named in that task's `files`. Every other task's Files section must list migrations under "must not be touched".

### 3. Detail is a self-contained context packet

A sub agent starts with no memory of the conversation or `plan.md`. Every `detail` uses these labeled sections (`Contract` may be omitted only when no interface is involved; `plan_validate` warns on the others):

```text
Goal: one or two sentences of intended outcome.
Files: files to modify (mirror `files`) and files that must not be touched.
Contract: exact signatures, types, schemas, endpoints, or names to honor; paste them, do not reference.
Steps: concrete ordered steps with every design decision already made.
Verify: exact commands to run and the expected result.
Done when: observable acceptance criteria.
```

No "see plan.md", no "decide the best approach", no "similar to TASK-003". If a decision is open, resolve it during planning or ask the user.

Packet size is a sizing signal, not just a quality rule:

- A packet should fit in roughly one page. If it needs to restate a whole algorithm or a long design to be self-contained, the task is too big or the algorithm belongs in `phase_0`.
- Put shared algorithms and cross-slice behavior in `phase_0` as an interface, stub, and tests. Fan-out tasks then reference the contract by pasting only the signatures they consume, not by re-explaining the algorithm.
- If two tasks need the same long paragraph in their packets, move that paragraph into a `phase_0` contract or test.

### 4. Task sizing (hard limits)

One task = one coherent change a single sub agent can finish and verify in one session. These limits are required, not advisory:

- At most **5 files or globs** in `files`.
- At most **1 concern**. A concern is a distinct layer or responsibility, for example service logic, persistence, HTTP routes, SSE/streaming, DI wiring, auth/security, OpenAPI. A task spanning two or more concerns must be split.
- At most **6 `steps`**.
- A `details` packet that exceeds about one page must be split or have its shared parts moved to `phase_0`.
- Set `size`: `S` = 1 to 2 files, 1 concern, simple steps. `M` = 3 to 5 files, 1 concern. If you would write `L`, split the task.

Split signals: the title needs "and" to describe it, the task owns unrelated directories, or it mixes new logic with wiring/registration. Merge tasks only when they always touch the same file and cannot be verified separately.

Aim for 3 to 6 parallel tasks per wave. A wave narrower than that is acceptable when the alternative is an oversized task.

### 5. Closing task limits

The closing task is a gate, not a dumping ground.

- `agent` must be `verify` or `review`.
- It may own at most **3 files**, limited to small registration or wiring files (route registry, DI container, barrel exports).
- It must not contain new feature logic. If integration needs real code (orchestration, new handlers, security logic), make it a separate fan-out task with its own file ownership and `pre_request`, and let the closing task only verify it.
- Do not collect "everything left over" into the closing task.

### 6. Role hints

Set `agent` on every task. Use `explore` only when an investigation result is a real prerequisite that planning could not settle; prefer resolving it during planning. Use `review` or `verify` for the closing task.

### 7. Verification environment

Before writing any `verify` step, determine and record in `plan.md` section 8:

- Which database, service, or sandbox the verify commands run against, and whether it is the live one or an isolated test one.
- Which migrations, seed data, or schema changes must already exist for the commands to pass, and which task provides them.
- What the executor is forbidden to do (for example migrating a live DB, touching shared infrastructure).

Rules:

- If a verify command needs a schema change that must be applied to a database the executor may not modify, the plan must either use an isolated test database created by a named task, or record this as an open question and ask the user. Do not write a verify step that is structurally unable to pass.
- Verify commands for a task may only depend on things provided by that task or by its `pre_request` chain or earlier phases.
- Prefer verification that does not need external state (unit tests with fakes, in-memory or ephemeral DB) for fan-out tasks, and reserve environment-dependent integration checks for the closing task.

## Required planning deliverables

Produce `plan.md` and one phase JSON file per ordered phase. Include actionable tasks, dependencies, acceptance or verification criteria, risks and mitigations, unresolved questions, and a definition of done. Confirm all files are inside the intended project and referenced paths exist.

After writing or editing any phase JSON, run both commands and iterate until `plan_validate` prints `Plan valid` with no errors:

```bash
ppm plan_validate --plan <plan-name> [--project <project-path>]
ppm plan_waves --plan <plan-name> [--project <project-path>]
```

- `plan_validate` errors (schema, cycles, concurrent file overlap, empty phase, missing `plan.md`) must be fixed. Warnings (serial phase, missing ownership, missing context-packet sections, no closing task, no agent hint, task over the sizing limits, missing `size`, `size: L`, closing task over its limits) should be fixed or justified in the report. `--strict` treats warnings as errors.
- `plan_waves` shows waves per phase, critical path, peak width, and average parallelism. If most waves have width 1, or the critical path equals the task count, first remove false dependencies and split tasks that hide independent work. **Never merge tasks or phases, and never enlarge a task, just to improve these numbers.** A narrow plan of small tasks is acceptable; a wide plan of oversized tasks is not.

Report changed files, unresolved questions, and the final `plan_validate` and `plan_waves` output as verification.

## Execution handoff notes

These notes are written into the plan so the executor does not have to improvise.

- One task ID is dispatched to one worker at a time. Never split a single task between two workers with an ad hoc ownership division; if a task needs splitting, update the plan and add new task IDs.
- Workers modify only files in their task's `files`. A worker that needs to change another file stops and reports it instead of editing.
- If a worker returns "partial" or no code, do not re-dispatch the same task unchanged. Split it into smaller tasks in the plan first, then dispatch the new tasks.
- Record the commit or `HEAD` the plan was written against in `plan.md` section 3. If `HEAD` moves during execution, the orchestrator re-checks affected tasks before dispatching more work.

## Supporting commands

Run from the target project root, or add `--project <project-path>`:

```bash
ppm init [--project <project-path>]
ppm init --plan <plan-name> [--project <project-path>]
ppm plan_validate --plan <plan-name> [--project <project-path>]
ppm plan_status --plan <plan-name> [--project <project-path>]
ppm plan_waves --plan <plan-name> [--project <project-path>]
ppm migrate [--project <project-path>] [--dry-run]
ppm clean_roots [--dry-run]
```

Run `ppm migrate --dry-run` before `ppm migrate`. Run `ppm clean_roots --dry-run` before `ppm clean_roots`. `plan_init` remains a compatibility alias for `init --plan`.