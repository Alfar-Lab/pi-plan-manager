"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { PLAN_PATTERN, PHASE_PATTERN, VALID_STATUSES, VALID_AGENTS } = require("./patterns");

const LOCK_TIMEOUT_MS = 10000;
const LOCK_STALE_MS = 30000;

function phaseNumber(name) {
	const match = /^phase_(\d+)$/.exec(name);
	return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

// Phase names under <planRoot>/tasks, ordered numerically (phase_2 before phase_10).
function listPhaseNames(planRoot) {
	let entries;
	try { entries = fs.readdirSync(path.join(planRoot, "tasks"), { withFileTypes: true }); } catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".json") && PHASE_PATTERN.test(entry.name.slice(0, -5)))
		.map((entry) => entry.name.slice(0, -5))
		.sort((a, b) => phaseNumber(a) - phaseNumber(b) || a.localeCompare(b));
}

function sleep(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Exclusive lock around read-modify-write of one phase file, so parallel lanes don't lose updates.
// ponytail: O_EXCL lockfile + stale timeout; swap for proper flock if multi-host FS is ever needed.
function withFileLock(file, fn) {
	const lock = `${file}.lock`;
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	for (;;) {
		try {
			fs.closeSync(fs.openSync(lock, "wx"));
			break;
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
			try {
				if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lock); continue; }
			} catch (statError) { if (statError.code !== "ENOENT") throw statError; continue; }
			if (Date.now() > deadline) throw new Error(`timed out waiting for lock: ${lock}`);
			sleep(25 + Math.floor(Math.random() * 25));
		}
	}
	try { return fn(); } finally { try { fs.unlinkSync(lock); } catch { /* already gone */ } }
}

function assertSafeSegment(value, label, pattern) {
	if (!pattern.test(value) || value === "." || value === "..") throw new Error(`invalid ${label}: ${value}`);
}

function projectRoot(options) {
	const candidate = path.resolve(options.project || process.cwd());
	let stat;
	try {
		stat = fs.statSync(candidate);
	} catch (error) {
		if (error.code === "ENOENT") throw new Error(`project directory not found: ${candidate}`);
		throw error;
	}
	if (!stat.isDirectory()) throw new Error(`project path is not a directory: ${candidate}`);
	return fs.realpathSync(candidate);
}

function normalizeDetails(task) {
	if (task.details && typeof task.details === "object" && !Array.isArray(task.details)) {
		if (typeof task.details.goal !== "string") task.details.goal = String(task.details.goal || "");
		if (typeof task.details.contract !== "string") task.details.contract = String(task.details.contract || "");
		if (!Array.isArray(task.details.steps)) {
			task.details.steps = typeof task.details.steps === "string" ? [task.details.steps] : [];
		} else {
			task.details.steps = task.details.steps.map((s) => String(s || ""));
		}
		// A "Files:" block written into goal is split out the same way as in a legacy detail string.
		if (FILES_LABEL.test(task.details.goal)) {
			const moved = parseLegacyDetail(task.details.goal);
			const join = (a, b) => [a, b].filter(Boolean).join("\n");
			Object.assign(task.details, { goal: moved.goal, contract: join(moved.contract, task.details.contract), steps: moved.steps.concat(task.details.steps), verify: join(moved.verify, task.details.verify) });
		}
		task.details.steps = splitSteps(task.details.steps);
		if (typeof task.details.verify !== "string") task.details.verify = String(task.details.verify || "");
		return;
	}
	task.details = parseLegacyDetail(typeof task.detail === "string" ? task.detail : "");
	delete task.detail;
}

// Legacy `detail` string -> details object, losslessly. Labels count only at line start (optionally
// qualified, "Contract (types.ts):"), so inline mentions stay in their section. Text before the first
// label stays in goal; "Done when:" is appended to verify. A "Files:" block never stays in goal (task.files
// owns paths); its text, which often carries constraints ("do not touch ..."), moves to contract as "Scope:".
const DETAIL_LABEL = /^[ \t]*(Goal|Files|Contract|Steps|Verify|Done when)([ \t]*\([^)\n]*\))?[ \t]*:[ \t]*/gim;
const FILES_LABEL = /^[ \t]*Files([ \t]*\([^)\n]*\))?[ \t]*:/im;

function parseLegacyDetail(str) {
	const marks = [...str.matchAll(DETAIL_LABEL)];
	const sections = { goal: [str.slice(0, marks.length ? marks[0].index : str.length)], files: [], contract: [], steps: [], verify: [], "done when": [] };
	marks.forEach((mark, i) => {
		const key = mark[1].toLowerCase();
		const body = str.slice(mark.index + mark[0].length, i + 1 < marks.length ? marks[i + 1].index : str.length).trim();
		// Files text becomes "Scope:"; a qualifier ("Contract (types.ts):") is kept as a label prefix.
		const label = key === "files" ? "Scope" : mark[2] ? mark[1] : "";
		if (body) sections[key].push(label ? `${label}${mark[2] ? ` ${mark[2].trim()}` : ""}: ${body}` : body);
	});
	const text = (key) => sections[key].map((s) => s.trim()).filter(Boolean).join("\n");
	const doneWhen = text("done when");
	return {
		goal: text("goal"),
		contract: [text("files"), text("contract")].filter(Boolean).join("\n"),
		steps: splitSteps(text("steps").split("\n").map((s) => s.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim()).filter(Boolean)),
		verify: [text("verify"), doneWhen && `Done when: ${doneWhen}`].filter(Boolean).join("\n"),
	};
}

// A lone step packing several actions ("a; b; c") becomes one step per action. ";" inside
// `code` or (), [], {} is kept. Multi-step lists are left alone.
function splitSteps(steps) {
	if (steps.length !== 1) return steps;
	const parts = [];
	let current = "", tick = false, depth = 0;
	for (const ch of steps[0]) {
		if (ch === "`") tick = !tick;
		else if (!tick && "([{".includes(ch)) depth += 1;
		else if (!tick && ")]}".includes(ch) && depth) depth -= 1;
		if (ch === ";" && !tick && !depth) { parts.push(current); current = ""; continue; }
		current += ch;
	}
	parts.push(current);
	const out = parts.map((part) => part.trim()).filter(Boolean);
	return out.length > 1 ? out : steps;
}

const TIMESTAMP_REGEX = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]\s?/;

function normalizeProgress(task) {
	if (Array.isArray(task.progress)) {
		task.progress = task.progress.map((item) => {
			if (item && typeof item === "object") return { time: String(item.time || ""), detail: String(item.detail || "") };
			return { time: "", detail: String(item || "") };
		});
		return;
	}
	if (typeof task.progress === "string" && task.progress.trim()) {
		const entries = [];
		task.progress.split("\n").forEach((line) => {
			const match = line.match(TIMESTAMP_REGEX);
			if (match) entries.push({ time: match[1], detail: line.slice(match[0].length) });
			else if (entries.length) entries[entries.length - 1].detail += `\n${line}`;
			else entries.push({ time: "", detail: line });
		});
		task.progress = entries;
		return;
	}
	task.progress = [];
}

// Parse + normalize + validate. legacyTasks = tasks whose JSON normalization changed, i.e. what
// `ppm migrate_format` would rewrite (the dashboard shows "Reformat Plan" when > 0).
function readPhaseFile(taskFile, expectedPhase) {
	let content;
	try { content = fs.readFileSync(taskFile, "utf8"); } catch (error) {
		if (error.code === "ENOENT") throw new Error(`task file not found: ${taskFile}`);
		throw error;
	}
	let phase;
	try { phase = JSON.parse(content); } catch (error) { throw new Error(`invalid JSON in ${taskFile}: ${error.message}`); }
	const before = Array.isArray(phase?.tasks) ? phase.tasks.map((task) => JSON.stringify(task)) : [];
	// Normalization. fail_desc is folded into progress so no failure context is lost.
	if (Array.isArray(phase?.tasks)) {
		for (const task of phase.tasks) {
			if (!task || typeof task !== "object") continue;
			if (task.status === "start") task.status = "todo";
			if ("fail_desc" in task) {
				const legacy = typeof task.fail_desc === "string" ? task.fail_desc.trim() : "";
				if (legacy) {
					if (!Array.isArray(task.progress)) normalizeProgress(task);
					task.progress.push({ time: "", detail: `[legacy fail_desc] ${legacy}` });
				}
				delete task.fail_desc;
			}
			normalizeDetails(task);
			normalizeProgress(task);
		}
	}
	validatePhase(phase, expectedPhase);
	return { phase, legacyTasks: phase.tasks.filter((task, i) => JSON.stringify(task) !== before[i]).length };
}

function readPhase(taskFile, expectedPhase) {
	return readPhaseFile(taskFile, expectedPhase).phase;
}

function writePhase(taskFile, phase) {
	const temporaryFile = `${taskFile}.${process.pid}.tmp`;
	try {
		fs.writeFileSync(temporaryFile, `${JSON.stringify(phase, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		fs.renameSync(temporaryFile, taskFile);
	} finally { if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile); }
}

function validatePreRequest(task, index, ids) {
	if (!("pre_request" in task)) return;
	const label = `tasks[${index}].pre_request`;
	if (!Array.isArray(task.pre_request)) throw new Error(`${label} must be an array of task ids`);
	const seen = new Set();
	for (const dep of task.pre_request) {
		if (typeof dep !== "string" || !dep.trim()) throw new Error(`${label} entries must be non-empty strings`);
		if (dep === task.id) throw new Error(`${label} cannot reference the task itself: ${dep}`);
		if (!ids.has(dep)) throw new Error(`${label} references unknown task id in same phase: ${dep}`);
		if (seen.has(dep)) throw new Error(`${label} contains duplicate entry: ${dep}`);
		seen.add(dep);
	}
}

function detectCycles(phase) {
	const deps = new Map();
	for (const task of phase.tasks) deps.set(task.id, Array.isArray(task.pre_request) ? task.pre_request : []);
	const WHITE = 0, GRAY = 1, BLACK = 2;
	const color = new Map();
	const stack = [];
	const visit = (id) => {
		if (color.get(id) === GRAY) {
			const cycleStart = stack.indexOf(id);
			const cycle = [...stack.slice(cycleStart), id].join(" -> ");
			throw new Error(`pre_request cycle detected: ${cycle}`);
		}
		if (color.get(id) === BLACK) return;
		color.set(id, GRAY);
		stack.push(id);
		for (const dep of deps.get(id) || []) visit(dep);
		stack.pop();
		color.set(id, BLACK);
	};
	for (const id of deps.keys()) color.set(id, WHITE);
	for (const id of deps.keys()) if (color.get(id) === WHITE) visit(id);
}

// Optional ownership list: repo-relative paths, dirs (trailing "/"), or globs (*, **, ?).
function validateFiles(task, index) {
	if (!("files" in task)) return;
	const label = `tasks[${index}].files`;
	if (!Array.isArray(task.files)) throw new Error(`${label} must be an array of repo-relative paths or globs`);
	const seen = new Set();
	for (const entry of task.files) {
		if (typeof entry !== "string" || !entry.trim()) throw new Error(`${label} entries must be non-empty strings`);
		if (path.isAbsolute(entry) || /^[A-Za-z]:/.test(entry)) throw new Error(`${label} must be repo-relative: ${entry}`);
		if (entry.split(/[\\/]/).includes("..")) throw new Error(`${label} must not contain "..": ${entry}`);
		if (seen.has(entry)) throw new Error(`${label} contains duplicate entry: ${entry}`);
		seen.add(entry);
	}
}

function validateAgent(task, index) {
	if (!("agent" in task)) return;
	if (!VALID_AGENTS.has(task.agent)) throw new Error(`tasks[${index}].agent must be one of ${[...VALID_AGENTS].join("|")}: ${task.agent}`);
}

function validatePhase(phase, expectedPhase) {
	if (!phase || typeof phase !== "object" || Array.isArray(phase)) throw new Error("phase file root must be an object");
	if (phase.phase !== expectedPhase) throw new Error(`phase field must equal ${expectedPhase}`);
	if (!Array.isArray(phase.tasks)) throw new Error("tasks must be an array");
	const ids = new Set();
	phase.tasks.forEach((task, index) => {
		const label = `tasks[${index}]`;
		if (!task || typeof task !== "object" || Array.isArray(task)) throw new Error(`${label} must be an object`);
		for (const field of ["id", "title", "status"]) if (typeof task[field] !== "string" || !task[field].trim()) throw new Error(`${label}.${field} must be a non-empty string`);
		if (ids.has(task.id)) throw new Error(`duplicate task id: ${task.id}`);
		ids.add(task.id);
		if (!VALID_STATUSES.has(task.status)) throw new Error(`${label}.status is invalid: ${task.status}`);
		if (!task.details || typeof task.details !== "object" || Array.isArray(task.details)) throw new Error(`${label}.details must be an object`);
		if (typeof task.details.goal !== "string") throw new Error(`${label}.details.goal must be a string`);
		if (!Array.isArray(task.details.steps)) throw new Error(`${label}.details.steps must be an array of strings`);
		if (!Array.isArray(task.progress)) throw new Error(`${label}.progress must be an array`);
		for (const p of task.progress) {
			if (!p || typeof p !== "object" || typeof p.detail !== "string") throw new Error(`${label}.progress entries must be objects with detail string`);
		}
		validateFiles(task, index);
		validateAgent(task, index);
	});
	phase.tasks.forEach((task, index) => validatePreRequest(task, index, ids));
	detectCycles(phase);
}

module.exports = {
	assertSafeSegment,
	projectRoot,
	readPhase,
	readPhaseFile,
	writePhase,
	validatePhase,
	phaseNumber,
	listPhaseNames,
	withFileLock,
	normalizeDetails,
	normalizeProgress,
	parseLegacyDetail,
	splitSteps,
	PLAN_PATTERN,
	PHASE_PATTERN,
};