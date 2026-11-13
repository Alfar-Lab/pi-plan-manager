"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
	PLAN_PATTERN,
	PHASE_PATTERN,
	assertSafeSegment,
	projectRoot,
	readPhase,
	readPhaseFile,
	writePhase,
	validatePhase,
	listPhaseNames,
	withFileLock,
	normalizeDetails,
} = require("../_shared/phase");
const { waves, criticalPath, lintPhase } = require("../_shared/analysis");
const { PLAN_DOCS, LEGACY_PLAN_MD } = require("../_shared/patterns");

function resolvePlanRoot(options) {
	assertSafeSegment(options.plan, "plan name", PLAN_PATTERN);
	const root = projectRoot(options);
	const planRoot = path.resolve(root, ".ppm", options.plan);
	if (!planRoot.startsWith(`${path.resolve(root, ".ppm")}${path.sep}`)) throw new Error("resolved plan is outside the project .ppm directory");
	return planRoot;
}

function resolveTaskFile(options) {
	assertSafeSegment(options.phase, "phase name", PHASE_PATTERN);
	return path.join(resolvePlanRoot(options), "tasks", `${options.phase}.json`);
}

function getTask(phase, taskId) {
	const task = phase.tasks.find((candidate) => candidate.id === taskId);
	if (!task) throw new Error(`task not found: ${taskId}`);
	return task;
}

function depsOf(task) {
	return Array.isArray(task.pre_request) ? task.pre_request : [];
}

function statusMap(phase) {
	return new Map(phase.tasks.map((task) => [task.id, task.status]));
}

function unmetDeps(task, statusById) {
	return depsOf(task).filter((dep) => statusById.get(dep) !== "completed");
}

function readyTasks(phase) {
	const statusById = statusMap(phase);
	return phase.tasks
		.filter((task) => task.status === "todo" && !unmetDeps(task, statusById).length)
		.map(({ id, title, pre_request }) => ({ id, title, pre_request: depsOf({ pre_request }) }));
}

function blockedTasks(phase) {
	const statusById = statusMap(phase);
	return phase.tasks
		.filter((task) => task.status === "todo" && unmetDeps(task, statusById).length)
		.map((task) => ({ id: task.id, title: task.title, waiting: unmetDeps(task, statusById) }));
}

function loadPhase(options) {
	const taskFile = resolveTaskFile(options);
	return { taskFile, phase: readPhase(taskFile, options.phase) };
}

// Locked read-modify-write of one phase file.
function mutatePhase(options, mutate) {
	const taskFile = resolveTaskFile(options);
	if (!fs.existsSync(taskFile)) throw new Error(`task file not found: ${taskFile}`);
	return withFileLock(taskFile, () => {
		const phase = readPhase(taskFile, options.phase);
		const result = mutate(phase);
		validatePhase(phase, options.phase);
		writePhase(taskFile, phase);
		return result;
	});
}

// Allowed status transitions. --force bypasses (manual repair only).
const TRANSITIONS = {
	in_progress: ["todo", "fail"],
	completed: ["in_progress"],
	fail: ["todo", "in_progress"],
	todo: ["in_progress", "completed", "fail"],
};

function assertTransition(phase, task, next, planRoot, phaseName) {
	if (task.status === next) throw new Error(`task ${task.id} is already ${next}`);
	if (!TRANSITIONS[next].includes(task.status))
		throw new Error(`invalid transition for ${task.id}: ${task.status} -> ${next} (allowed from: ${TRANSITIONS[next].join(", ")}; use --force to override)`);
	if (next !== "in_progress") return;
	const waiting = unmetDeps(task, statusMap(phase));
	if (waiting.length) throw new Error(`task ${task.id} is blocked by unmet pre_request: ${waiting.join(", ")} (use --force to override)`);
	const unfinished = earlierUnfinishedPhases(planRoot, phaseName);
	if (unfinished.length) throw new Error(`earlier phase not completed: ${unfinished.join(", ")} (use --force to override)`);
}

function earlierUnfinishedPhases(planRoot, phaseName) {
	const names = listPhaseNames(planRoot);
	const index = names.indexOf(phaseName);
	return names.slice(0, Math.max(index, 0)).filter((name) => {
		const phase = readPhase(path.join(planRoot, "tasks", `${name}.json`), name);
		return phase.tasks.some((task) => task.status !== "completed");
	});
}

// Next phase name after phaseName, or null when it is the last.
function nextPhase(planRoot, phaseName) {
	const names = listPhaseNames(planRoot);
	return names[names.indexOf(phaseName) + 1] || null;
}

function phaseDoneNote(planRoot, phaseName) {
	const next = nextPhase(planRoot, phaseName);
	return `Phase ${phaseName} complete. ${next ? `Next: ${next}` : "Plan complete."}`;
}

function idsWith(phase, status) {
	return phase.tasks.filter((task) => task.status === status).map((task) => task.id);
}

// Output: "<id>: <old> -> <new>." plus newly unblocked tasks and phase completion.
function setTaskStatus(options, status) {
	const planRoot = resolvePlanRoot(options);
	const { previous, phase } = mutatePhase(options, (current) => {
		const task = getTask(current, options["task-id"]);
		if (!options.force) assertTransition(current, task, status, planRoot, options.phase);
		const old = task.status;
		task.status = status;
		return { previous: old, phase: current };
	});
	const id = options["task-id"];
	const parts = [`${id}: ${previous} -> ${status}.`];
	if (status === "completed") {
		const unblocked = readyTasks(phase).filter((task) => task.pre_request.includes(id)).map((task) => task.id);
		if (unblocked.length) parts.push(`Unblocked: ${unblocked.join(", ")}.`);
		if (phase.tasks.every((task) => task.status === "completed")) parts.push(phaseDoneNote(planRoot, options.phase));
	}
	process.stdout.write(`${parts.join(" ")}\n`);
}

function timestamp() {
	return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

function taskWriteProgressHandler(options) {
	const text = options["progress-text"].trim();
	mutatePhase(options, (phase) => {
		const task = getTask(phase, options["task-id"]);
		const entry = { time: timestamp(), detail: text };
		if (options.replace) {
			task.progress = [entry];
		} else {
			task.progress.push(entry);
		}
	});
	process.stdout.write(`${options["task-id"]}: progress ${options.replace ? "replaced" : "appended"}\n`);
}

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// RFC 7396 JSON merge patch: objects merge recursively, null deletes a key, arrays and scalars replace.
function mergePatch(target, patch) {
	if (!isPlainObject(patch)) return patch;
	const out = isPlainObject(target) ? { ...target } : {};
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) delete out[key];
		else out[key] = mergePatch(out[key], value);
	}
	return out;
}

// "-" reads stdin so shells can pass JSON through a quoted heredoc without escaping.
function parseTaskInput(raw) {
	const text = raw === "-" ? fs.readFileSync(0, "utf8") : raw;
	let value;
	try { value = JSON.parse(text); } catch (error) { throw new Error(`--task is not valid JSON: ${error.message}`); }
	const tasks = Array.isArray(value) ? value : [value];
	if (!tasks.length) throw new Error("--task is an empty array");
	tasks.forEach((task, i) => {
		if (!isPlainObject(task) || typeof task.id !== "string" || !task.id.trim()) throw new Error(`--task[${i}] must be an object with a non-empty string id`);
	});
	return tasks;
}

// Only unstarted or failed tasks are plan material; running and completed tasks are history.
const EDITABLE = new Set(["todo", "fail"]);

function assertEditable(task, options) {
	if (!EDITABLE.has(task.status) && !options.force)
		throw new Error(`task ${task.id} is ${task.status}; only todo/fail tasks can be changed (use --force to override)`);
}

// Add or merge-patch tasks in one phase file (created on first use). One task per failure, not a whole-file rewrite.
function taskUpsertHandler(options) {
	const patches = parseTaskInput(options.task);
	const planRoot = resolvePlanRoot(options);
	if (!fs.existsSync(planRoot)) throw new Error(`plan not found: ${planRoot} (run ppm init --plan ${options.plan} first)`);
	const taskFile = resolveTaskFile(options);
	fs.mkdirSync(path.dirname(taskFile), { recursive: true });
	const { phase, results } = withFileLock(taskFile, () => {
		const current = fs.existsSync(taskFile) ? readPhase(taskFile, options.phase) : { phase: options.phase, title: options.phase, tasks: [] };
		if (options.title) current.title = options.title;
		const done = patches.map(({ status, progress, ...patch }) => {
			const index = current.tasks.findIndex((task) => task.id === patch.id);
			const existing = current.tasks[index];
			if (existing) assertEditable(existing, options);
			if (status !== undefined && status !== (existing?.status ?? "todo"))
				throw new Error(`${patch.id}: status is set only by task_in_progress/task_completed/task_fail/task_reset; omit it`);
			if (progress != null && progress !== "" && !(Array.isArray(progress) && !progress.length))
				throw new Error(`${patch.id}: progress is written only by task_write_progress; omit it`);
			const task = mergePatch(existing ?? {}, patch);
			if (!existing) Object.assign(task, { status: "todo", progress: [] });
			normalizeDetails(task);
			if (index >= 0) current.tasks[index] = task;
			else current.tasks.push(task);
			return `${task.id}: ${existing ? "updated" : "added"}`;
		});
		// Name the task, not its array index, so the caller re-sends just that one.
		try { validatePhase(current, options.phase); } catch (error) {
			throw new Error(error.message.replace(/tasks\[(\d+)\]/g, (m, i) => `task ${current.tasks[i]?.id ?? m}`));
		}
		writePhase(taskFile, current);
		return { phase: current, results: done };
	});
	// Task-level lint only; phase-level findings may be transient until the phase is complete (see plan_validate).
	const ids = patches.map((patch) => `${patch.id}:`);
	const warnings = lintPhase(phase).warnings.filter((warning) => ids.some((id) => warning.startsWith(id)));
	process.stdout.write(`${[...results, ...warnings.map((w) => `warning: ${w}`)].join("\n")}\n${options.phase}: ${phase.tasks.length} task(s)\n`);
}

function taskRemoveHandler(options) {
	const id = options["task-id"];
	const left = mutatePhase(options, (phase) => {
		assertEditable(getTask(phase, id), options);
		const dependents = phase.tasks.filter((task) => depsOf(task).includes(id)).map((task) => task.id);
		if (dependents.length) throw new Error(`task ${id} is in pre_request of: ${dependents.join(", ")} (upsert those first)`);
		phase.tasks = phase.tasks.filter((task) => task.id !== id);
		return phase.tasks.length;
	});
	process.stdout.write(`${id}: removed\n${options.phase}: ${left} task(s)\n`);
}

const afterNote = (task) => (depsOf(task).length ? ` (after ${depsOf(task).join(", ")})` : "");

function taskListHandler(options) {
	const { phase } = loadPhase(options);
	const lines = phase.tasks.map((task) => `${task.id} [${task.status}] ${task.title}${afterNote(task)}${task.status === "todo" && task.progress.length ? " +progress" : ""}`);
	process.stdout.write(lines.length ? `${lines.join("\n")}\n` : "No tasks.\n");
}

function dispatchLine(task) {
	const files = Array.isArray(task.files) && task.files.length ? ` | files: ${task.files.join(", ")}` : "";
	return `${task.id}${task.agent ? ` [${task.agent}]` : ""} ${task.title}${files}`;
}

function taskReadyHandler(options) {
	const { phase } = loadPhase(options);
	const readyIds = new Set(readyTasks(phase).map((task) => task.id));
	if (readyIds.size) {
		const lines = phase.tasks.filter((task) => readyIds.has(task.id)).map(dispatchLine);
		process.stdout.write(`Ready ${lines.length}:\n${lines.join("\n")}\n`);
		return;
	}
	if (phase.tasks.every((task) => task.status === "completed")) {
		process.stdout.write(`No ready tasks. ${phaseDoneNote(resolvePlanRoot(options), options.phase)}\n`);
		return;
	}
	const parts = ["No ready tasks."];
	const running = idsWith(phase, "in_progress");
	const failed = idsWith(phase, "fail");
	const blocked = blockedTasks(phase);
	if (running.length) parts.push(`In progress: ${running.join(", ")}.`);
	if (failed.length) parts.push(`Failed: ${failed.join(", ")}.`);
	if (blocked.length) parts.push(`Blocked: ${blocked.map(({ id, waiting }) => `${id} (waiting ${waiting.join(", ")})`).join(", ")}.`);
	process.stdout.write(`${parts.join(" ")}\n`);
}

function taskBlockedHandler(options) {
	const { phase } = loadPhase(options);
	const blocked = blockedTasks(phase);
	process.stdout.write(blocked.length
		? `${blocked.map(({ id, title, waiting }) => `${id} ${title} | waiting: ${waiting.join(", ")}`).join("\n")}\n`
		: "No blocked tasks.\n");
}

function statusLabel(task, phase) {
	if (task.status !== "todo") return task.status;
	const waiting = unmetDeps(task, statusMap(phase));
	return waiting.length ? `todo, blocked: waiting ${waiting.join(", ")}` : "todo, ready";
}

// Self-contained: header carries id/status/eligibility so it can be forwarded to a sub agent as-is.
function taskGetHandler(options) {
	const { phase } = loadPhase(options);
	const task = getTask(phase, options["task-id"]);
	const meta = [`Phase: ${options.phase}`];
	if (depsOf(task).length) meta.push(`After: ${depsOf(task).join(", ")}`);
	if (task.agent) meta.push(`Agent: ${task.agent}`);
	if (Array.isArray(task.files) && task.files.length) meta.push(`Files: ${task.files.join(", ")}`);
	const d = task.details || {};
	const detailText = [
		d.goal ? `Goal: ${d.goal}` : "",
		d.contract ? `Contract: ${d.contract}` : "",
		d.steps?.length ? `Steps:\n${d.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}` : "",
		d.verify ? `Verify: ${d.verify}` : "",
	].filter(Boolean).join("\n\n");
	const blocks = [`${task.id} [${statusLabel(task, phase)}] ${task.title}`, meta.join(" | "), `## Detail\n${detailText}`];
	if (task.progress.length) {
		const progText = task.progress.map((p) => `[${p.time}] ${p.detail}`).join("\n");
		blocks.push(`## Progress\n${progText}`);
	}
	process.stdout.write(`${blocks.join("\n")}\n`);
}

function planPhases(options) {
	const planRoot = resolvePlanRoot(options);
	if (!fs.existsSync(planRoot)) throw new Error(`plan not found: ${planRoot}`);
	return { planRoot, names: listPhaseNames(planRoot) };
}

// Errors: schema defects and concurrent file-ownership conflicts (always fail).
// Warnings: efficiency/clarity smells (fail only with --strict).
function planValidateHandler(options) {
	const { planRoot, names } = planPhases(options);
	const errors = [];
	const warnings = [];
	const readDoc = (file) => { try { return fs.readFileSync(path.join(planRoot, file), "utf8"); } catch { return null; } };
	const planMd = readDoc("plan.md");
	const approach = readDoc("plan.approach.md");
	if (planMd === null) errors.push("plan.md: missing");
	const missingDocs = PLAN_DOCS.filter((file) => readDoc(file) === null);
	// Legacy single-file plans keep executing; the adjustment flow splits them.
	if (missingDocs.length && LEGACY_PLAN_MD.test(planMd ?? "")) warnings.push("plan.md: legacy single-file format; split it into plan.*.md via the adjustment flow");
	else errors.push(...missingDocs.map((file) => `${file}: missing`));
	if (!names.length) errors.push("tasks/: no phase_*.json files");
	// Traceability: every phase is derived from a phase entry in plan.approach.md.
	if (approach !== null) for (const name of names) if (!approach.includes(name)) warnings.push(`${name}: not described in plan.approach.md`);
	let taskCount = 0;
	for (const name of names) {
		let phase, legacyTasks;
		try { ({ phase, legacyTasks } = readPhaseFile(path.join(planRoot, "tasks", `${name}.json`), name)); } catch (error) {
			errors.push(`${name}: ${error.message}`);
			continue;
		}
		taskCount += phase.tasks.length;
		// Raw file differs from the normalized contract (legacy strings, "Files:" in details.goal, packed ";" steps).
		if (legacyTasks) warnings.push(`${name}: ${legacyTasks} task(s) not in current details format (e.g. a "Files:" section in goal or several actions in one step); run ppm migrate_format --plan ${options.plan}`);
		const lint = lintPhase(phase);
		errors.push(...lint.errors.map((message) => `${name}: ${message}`));
		warnings.push(...lint.warnings.map((message) => `${name}: ${message}`));
	}
	const list = (items) => items.map((item) => `- ${item}`).join("\n");
	const warningBlock = warnings.length ? `Warnings (${warnings.length}):\n${list(warnings)}\n` : "";
	if (errors.length || (options.strict && warnings.length)) {
		process.stdout.write(`Plan invalid: ${options.plan}\n${errors.length ? `Errors (${errors.length}):\n${list(errors)}\n` : ""}${warningBlock}`);
		process.exitCode = 1;
		return;
	}
	process.stdout.write(`Plan valid: ${options.plan}; phases: ${names.length}; tasks: ${taskCount}; warnings: ${warnings.length}\n${warningBlock}`);
}

function planWavesHandler(options) {
	const { planRoot, names } = planPhases(options);
	if (!names.length) {
		process.stdout.write("No phases.\n");
		return;
	}
	let totalWaves = 0, totalTasks = 0, peak = 0;
	const blocks = names.map((name) => {
		const phase = readPhase(path.join(planRoot, "tasks", `${name}.json`), name);
		const phaseWaves = waves(phase);
		totalWaves += phaseWaves.length;
		totalTasks += phase.tasks.length;
		peak = Math.max(peak, ...phaseWaves.map((wave) => wave.length), 0);
		const lines = phaseWaves.map((wave, index) => `Wave ${index + 1} (${wave.length}): ${wave.map((task) => `${task.id}${task.agent ? ` [${task.agent}]` : ""}${task.status === "todo" ? "" : ` (${task.status})`}`).join(", ")}`);
		const chain = criticalPath(phase);
		return `## ${name} - ${phase.title || name}\n${lines.join("\n") || "No tasks."}\nCritical path (${chain.length}): ${chain.join(" -> ") || "-"}`;
	});
	const speedup = totalWaves ? (totalTasks / totalWaves).toFixed(2) : "0";
	process.stdout.write(`${blocks.join("\n\n")}\n\nSummary: ${names.length} phases (sync barriers), ${totalWaves} sequential waves, ${totalTasks} tasks, peak width ${peak}, avg parallelism ${speedup}\n`);
}

function planStatusHandler(options) {
	const { planRoot, names } = planPhases(options);
	if (!names.length) {
		process.stdout.write("No phases.\n");
		return;
	}
	let current = null;
	const lines = names.map((name) => {
		const phase = readPhase(path.join(planRoot, "tasks", `${name}.json`), name);
		const done = idsWith(phase, "completed").length;
		if (done !== phase.tasks.length && current === null) current = name;
		const parts = [`${name} ${phase.title || name}: ${done}/${phase.tasks.length} done`];
		for (const status of ["in_progress", "fail"]) {
			const ids = idsWith(phase, status);
			if (ids.length) parts.push(`${status}: ${ids.join(", ")}`);
		}
		return parts.join(" | ");
	});
	process.stdout.write(`${lines.join("\n")}\nCurrent: ${current || "none (plan complete)"}\n`);
}

function validateProgressText(opts) {
	if (!opts["progress-text"]?.trim())
		throw new Error("task_write_progress requires a non-empty --progress-text");
}

module.exports = {
	taskListHandler,
	taskReadyHandler,
	taskBlockedHandler,
	taskGetHandler,
	taskWriteProgressHandler,
	taskUpsertHandler,
	taskRemoveHandler,
	setTaskStatus,
	planValidateHandler,
	planStatusHandler,
	planWavesHandler,
	validateProgressText,
	readyTasks,
	blockedTasks,
	assertTransition,
};
