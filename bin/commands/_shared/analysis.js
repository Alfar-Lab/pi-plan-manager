"use strict";

// Pure plan-structure analysis: waves, critical path, concurrency, file-ownership conflicts, lint warnings.

const depsOf = (task) => (Array.isArray(task.pre_request) ? task.pre_request : []);

// Wave (topological level) per task id: 0 when no deps, else 1 + max(dep wave). Assumes acyclic (validated).
function levels(phase) {
	const byId = new Map(phase.tasks.map((task) => [task.id, task]));
	const memo = new Map();
	const level = (id) => {
		if (!memo.has(id)) memo.set(id, depsOf(byId.get(id)).reduce((max, dep) => Math.max(max, level(dep) + 1), 0));
		return memo.get(id);
	};
	for (const task of phase.tasks) level(task.id);
	return memo;
}

function waves(phase) {
	const level = levels(phase);
	const result = [];
	for (const task of phase.tasks) (result[level.get(task.id)] ||= []).push(task);
	return result;
}

function criticalPath(phase) {
	if (!phase.tasks.length) return [];
	const level = levels(phase);
	const byId = new Map(phase.tasks.map((task) => [task.id, task]));
	let current = phase.tasks.reduce((best, task) => (level.get(task.id) > level.get(best.id) ? task : best));
	const chain = [current.id];
	while (depsOf(current).length) {
		current = byId.get(depsOf(current).reduce((best, dep) => (level.get(dep) > level.get(best) ? dep : best)));
		chain.unshift(current.id);
	}
	return chain;
}

// Transitive ancestors per task id.
function ancestors(phase) {
	const byId = new Map(phase.tasks.map((task) => [task.id, task]));
	const memo = new Map();
	const walk = (id) => {
		if (memo.has(id)) return memo.get(id);
		const set = new Set();
		for (const dep of depsOf(byId.get(id))) {
			set.add(dep);
			for (const up of walk(dep)) set.add(up);
		}
		memo.set(id, set);
		return set;
	};
	for (const task of phase.tasks) walk(task.id);
	return memo;
}

// Pairs of tasks with no ordering between them: they may run at the same time.
function concurrentPairs(phase) {
	const up = ancestors(phase);
	const pairs = [];
	for (let i = 0; i < phase.tasks.length; i += 1)
		for (let j = i + 1; j < phase.tasks.length; j += 1) {
			const a = phase.tasks[i], b = phase.tasks[j];
			if (!up.get(a.id).has(b.id) && !up.get(b.id).has(a.id)) pairs.push([a, b]);
		}
	return pairs;
}

const normalize = (pattern) => {
	const clean = pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "");
	return clean.endsWith("/") ? `${clean}**` : clean;
};

function globToRegex(pattern) {
	let source = "";
	for (let i = 0; i < pattern.length; i += 1) {
		const char = pattern[i];
		if (char === "*" && pattern[i + 1] === "*") {
			source += ".*";
			i += 1;
			if (pattern[i + 1] === "/") i += 1;
		} else if (char === "*") source += "[^/]*";
		else if (char === "?") source += "[^/]";
		else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${source}$`);
}

const staticPrefix = (pattern) => pattern.split(/[*?]/)[0];

// Could two ownership patterns refer to the same file?
// ponytail: glob-vs-glob is approximated by static-prefix containment (conservative, may over-report); use a real glob-intersection lib if false positives hurt.
// A literal path may be a file or a directory (trailing "/" is optional), so it also owns everything under it.
const within = (path, root) => path === root || path.startsWith(`${root.replace(/\/\*\*$/, "")}/`);

function patternsOverlap(a, b) {
	const x = normalize(a), y = normalize(b);
	if (x === y) return true;
	const xGlob = /[*?]/.test(x), yGlob = /[*?]/.test(y);
	if (!xGlob && !yGlob) return within(x, y) || within(y, x);
	if (!xGlob) return globToRegex(y).test(x) || staticPrefix(y).startsWith(`${x}/`);
	if (!yGlob) return globToRegex(x).test(y) || staticPrefix(x).startsWith(`${y}/`);
	const px = staticPrefix(x), py = staticPrefix(y);
	return px.startsWith(py) || py.startsWith(px);
}

function fileConflicts(phase) {
	const conflicts = [];
	for (const [a, b] of concurrentPairs(phase)) {
		if (!Array.isArray(a.files) || !Array.isArray(b.files)) continue;
		const shared = [];
		for (const fa of a.files) for (const fb of b.files) if (patternsOverlap(fa, fb)) shared.push(fa === fb ? fa : `${fa} ~ ${fb}`);
		if (shared.length) conflicts.push({ a: a.id, b: b.id, shared });
	}
	return conflicts;
}

const DETAIL_SECTIONS = ["Goal", "Files", "Steps", "Verify", "Done when"];

function missingSections(detail) {
	return DETAIL_SECTIONS.filter((section) => !new RegExp(`^\\s*(?:#+\\s*)?${section}\\s*:?`, "im").test(detail));
}

// Advisory findings for one phase. Errors = defects that break parallel execution; warnings = efficiency/clarity smells.
function lintPhase(phase) {
	const errors = [];
	const warnings = [];
	const tasks = phase.tasks;
	for (const { a, b, shared } of fileConflicts(phase))
		errors.push(`${a} and ${b} can run concurrently but share files: ${shared.join(", ")} (add pre_request or move shared files to one task)`);
	// An empty phase would read as "0/0 done" and let a hollow plan look complete.
	if (!tasks.length) return { errors: ["phase has no tasks (add tasks or delete the phase file)"], warnings };

	const phaseWaves = waves(phase);
	const width = Math.max(...phaseWaves.map((wave) => wave.length));
	if (tasks.length >= 2 && width === 1)
		warnings.push(`fully serial (${tasks.length} tasks, width 1): drop unneeded pre_request, merge tasks, or split independent work`);

	const concurrent = concurrentPairs(phase);
	if (concurrent.length) {
		const racing = new Set(concurrent.flatMap(([a, b]) => [a.id, b.id]));
		const unowned = tasks.filter((task) => racing.has(task.id) && !(Array.isArray(task.files) && task.files.length)).map((task) => task.id);
		if (unowned.length) warnings.push(`parallel tasks without files ownership (conflicts cannot be checked): ${unowned.join(", ")}`);
		const up = ancestors(phase);
		const sink = tasks.some((task) => up.get(task.id).size === tasks.length - 1);
		if (!sink) warnings.push("parallel work has no closing integration/verify task (one task whose pre_request covers all others)");
	}

	for (const task of tasks) {
		const d = task.details || {};
		const missing = [];
		if (!d.goal?.trim()) missing.push("goal");
		if (!d.steps?.length) missing.push("steps");
		if (!d.verify?.trim()) missing.push("verify");
		if (missing.length) warnings.push(`${task.id}: details missing context-packet fields: ${missing.join(", ")}`);
		if (!task.agent) warnings.push(`${task.id}: no agent role hint (explore|implement|review|verify)`);
	}
	return { errors, warnings };
}

module.exports = { waves, criticalPath, concurrentPairs, patternsOverlap, fileConflicts, lintPhase, DETAIL_SECTIONS };
