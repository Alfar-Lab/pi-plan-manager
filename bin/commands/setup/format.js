"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
	PLAN_PATTERN,
	PHASE_PATTERN,
	assertSafeSegment,
	projectRoot,
	listPhaseNames,
	normalizeDetails,
	normalizeProgress,
	validatePhase,
} = require("../_shared/phase");

function tasksDir(planRoot) {
	return path.join(planRoot, "tasks");
}

// One backup per day, matching the adjustment-flow convention.
function backupTasksDir(dir) {
	const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
	const backup = `${dir}.bak-${stamp}`;
	if (!fs.existsSync(backup)) fs.cpSync(dir, backup, { recursive: true });
	return backup;
}

function isOldTask(task) {
	if (!task || typeof task !== "object" || Array.isArray(task)) return false;
	return typeof task.detail === "string" || typeof task.progress === "string" || "fail_desc" in task;
}

function foldFailDesc(task) {
	if (!("fail_desc" in task)) return;
	const legacy = typeof task.fail_desc === "string" ? task.fail_desc.trim() : "";
	if (legacy) {
		if (!Array.isArray(task.progress)) normalizeProgress(task);
		task.progress.push({ time: "", detail: `[legacy fail_desc] ${legacy}` });
	}
	delete task.fail_desc;
}

function migrateTask(task) {
	let changed = isOldTask(task);
	if (changed) {
		foldFailDesc(task);
		normalizeDetails(task);
		normalizeProgress(task);
	}
	return changed;
}

function atomicWrite(file, content) {
	const temporaryFile = `${file}.${process.pid}.tmp`;
	try {
		fs.writeFileSync(temporaryFile, content, { encoding: "utf8", mode: 0o600 });
		fs.renameSync(temporaryFile, file);
	} finally {
		if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
	}
}

function migrateFormatHandler(options) {
	assertSafeSegment(options.plan, "plan name", PLAN_PATTERN);
	const root = projectRoot(options);
	const planRoot = path.resolve(root, ".ppm", options.plan);
	if (!fs.statSync(planRoot).isDirectory()) throw new Error(`plan not found: ${planRoot}`);

	const names = listPhaseNames(planRoot);
	let phaseCount = 0;
	let taskCount = 0;
	const changed = [];

	for (const name of names) {
		const file = path.join(tasksDir(planRoot), `${name}.json`);
		let content;
		try { content = fs.readFileSync(file, "utf8"); } catch (error) {
			if (error.code === "ENOENT") throw new Error(`phase file not found: ${file}`);
			throw error;
		}
		let phase;
		try { phase = JSON.parse(content); } catch (error) {
			throw new Error(`invalid JSON in ${file}: ${error.message}`);
		}
		if (!phase || typeof phase !== "object" || Array.isArray(phase) || !Array.isArray(phase.tasks)) {
			throw new Error(`${file}: phase root must be an object with a tasks array`);
		}
		if (phase.phase !== name) throw new Error(`${file}: phase field must equal ${name}`);

		let phaseChanged = false;
		for (const task of phase.tasks) {
			if (migrateTask(task)) {
				phaseChanged = true;
				taskCount += 1;
			}
		}

		if (phaseChanged) {
			changed.push(name);
			phaseCount += 1;
			if (!options["dry-run"]) {
				// Validate the migrated result before overwriting.
				validatePhase(phase, name);
				atomicWrite(file, `${JSON.stringify(phase, null, 2)}\n`);
			}
		}
	}

	if (options["dry-run"]) {
		process.stdout.write(
			`Would migrate ${phaseCount} phase file(s), ${taskCount} task(s) in plan ${options.plan}.\n${changed.join(", ") || "(none)"}\n`,
		);
		return;
	}

	let backup;
	if (phaseCount) backup = backupTasksDir(tasksDir(planRoot));
	process.stdout.write(
		`Migrated ${phaseCount} phase file(s), ${taskCount} task(s) in plan ${options.plan}.${backup ? ` Backup: ${backup}` : ""}\n${changed.join(", ") || "(none)"}\n`,
	);
}

module.exports = { migrateFormatHandler, isOldTask, migrateTask };
