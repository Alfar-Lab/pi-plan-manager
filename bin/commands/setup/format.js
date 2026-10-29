"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { PLAN_PATTERN, assertSafeSegment, projectRoot, listPhaseNames, readPhaseFile, writePhase, withFileLock } = require("../_shared/phase");

// tasks.bak-YYYYMMDD (adjustment-flow convention); never reuses an existing backup, which may be stale.
function backupTasksDir(dir) {
	const iso = new Date().toISOString();
	let backup = `${dir}.bak-${iso.slice(0, 10).replace(/-/g, "")}`;
	if (fs.existsSync(backup)) backup += `-${iso.slice(11, 19).replace(/:/g, "")}`;
	fs.cpSync(dir, backup, { recursive: true, errorOnExist: true, force: false });
	return backup;
}

// Rewrites legacy tasks (detail string, progress string, fail_desc, status "start") to the
// current JSON contract. Same normalization readPhase applies in memory, persisted to disk.
// Shared by the CLI and the dashboard's POST /api/migrate_format.
function migrateFormat(options) {
	assertSafeSegment(options.plan, "plan name", PLAN_PATTERN);
	const root = projectRoot(options);
	const planRoot = path.resolve(root, ".ppm", options.plan);
	if (!fs.existsSync(planRoot) || !fs.statSync(planRoot).isDirectory()) throw new Error(`plan not found: ${planRoot}`);
	const tasksDir = path.join(planRoot, "tasks");

	// Parse + validate every phase first, so one broken file aborts before anything is written.
	const pending = listPhaseNames(planRoot)
		.map((name) => ({ name, file: path.join(tasksDir, `${name}.json`), ...readPhaseFile(path.join(tasksDir, `${name}.json`), name) }))
		.filter((entry) => entry.legacyTasks);
	const result = { plan: options.plan, phases: pending.map((entry) => entry.name), tasks: pending.reduce((sum, entry) => sum + entry.legacyTasks, 0), backup: null };
	if (options["dry-run"] || !pending.length) return result;

	result.backup = backupTasksDir(tasksDir);
	// Re-read under the lock so a concurrent task_* write is not overwritten with stale content.
	for (const entry of pending) withFileLock(entry.file, () => writePhase(entry.file, readPhaseFile(entry.file, entry.name).phase));
	return result;
}

function migrateFormatHandler(options) {
	const result = migrateFormat(options);
	const verb = options["dry-run"] ? "Would migrate" : "Migrated";
	process.stdout.write(`${verb} ${result.phases.length} phase file(s), ${result.tasks} task(s) in plan ${result.plan}.${result.backup ? ` Backup: ${result.backup}` : ""}\n${result.phases.join(", ") || "(none)"}\n`);
}

module.exports = { migrateFormat, migrateFormatHandler };
