#!/usr/bin/env node
"use strict";

// Zero-dependency self-check: runs the real CLI against a throwaway project. Usage: node test/self-check.js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const CLI = path.resolve(__dirname, "../bin/ppm.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-check-"));
const env = { ...process.env, HOME: tmp }; // keep ~/.config writes inside tmp
const project = path.join(tmp, "proj");
const tasksDir = path.join(project, ".ppm", "demo", "tasks");

function ppm(...args) {
	const result = spawnSync(process.execPath, [CLI, ...args, "--project", project], { env, encoding: "utf8" });
	return { code: result.status, out: result.stdout + result.stderr };
}

function ok(...args) {
	const result = ppm(...args);
	assert.equal(result.code, 0, `expected success: ppm ${args.join(" ")}\n${result.out}`);
	return result.out;
}

function bad(pattern, ...args) {
	const result = ppm(...args);
	assert.notEqual(result.code, 0, `expected failure: ppm ${args.join(" ")}\n${result.out}`);
	assert.match(result.out, pattern);
}

const task = (id, extra = {}) => ({ id, title: id, detail: "d", status: "todo", progress: "", ...extra });
const writePhase = (name, tasks) => fs.writeFileSync(path.join(tasksDir, `${name}.json`), JSON.stringify({ phase: name, title: name, tasks }));
const readTasks = (name) => JSON.parse(fs.readFileSync(path.join(tasksDir, `${name}.json`), "utf8")).tasks;
const p0 = ["--plan", "demo", "--phase", "phase_0"];
const p1 = ["--plan", "demo", "--phase", "phase_1"];

async function main() {
	fs.mkdirSync(project);
	ok("init", "--plan", "demo");
	fs.writeFileSync(path.join(project, ".ppm", "demo", "plan.md"), "# Demo\n");

	// plan_validate: cycle and unknown dependency are reported, valid plan passes.
	writePhase("phase_0", [task("A", { pre_request: ["B"] }), task("B", { pre_request: ["A"] })]);
	bad(/cycle detected/, "plan_validate", "--plan", "demo");
	writePhase("phase_0", [task("A", { pre_request: ["Z"] })]);
	bad(/unknown task id/, "plan_validate", "--plan", "demo");

	writePhase("phase_0", [task("A"), task("B"), task("C", { pre_request: ["A", "B"] })]);
	writePhase("phase_1", [task("D")]);
	assert.match(ok("plan_validate", "--plan", "demo"), /Plan valid: demo; phases: 2; tasks: 4/);

	// ready / blocked.
	const ready = ok("task_ready", ...p0);
	assert.match(ready, /^Ready 2:\nA A\nB B\n$/);
	assert.doesNotMatch(ready, /## C/);
	assert.match(ok("task_blocked", ...p0), /^C C \| waiting: A, B\n$/);

	// Transition guards.
	bad(/invalid transition/, "task_completed", ...p0, "--task-id", "A");
	bad(/blocked by unmet pre_request: A, B/, "task_in_progress", ...p0, "--task-id", "C");
	bad(/earlier phase not completed: phase_0/, "task_in_progress", ...p1, "--task-id", "D");
	assert.equal(ok("task_in_progress", ...p0, "--task-id", "A"), "A: todo -> in_progress.\n");
	bad(/already in_progress/, "task_in_progress", ...p0, "--task-id", "A");
	assert.equal(ok("task_ready", ...p0), "Ready 1:\nB B\n");
	assert.equal(ok("task_completed", ...p0, "--task-id", "A"), "A: in_progress -> completed.\n");
	assert.equal(ok("task_completed", ...p0, "--task-id", "B", "--force"), "B: todo -> completed. Unblocked: C.\n");
	assert.match(ok("task_list", ...p0), /^A \[completed\] A\nB \[completed\] B\nC \[todo\] C \(after A, B\)\n$/);

	// Scoped usage on bad invocation.
	const missing = ppm("task_get", "--plan", "demo");
	assert.equal(missing.out, "Error: missing --phase\nUsage: ppm task_get --plan <name> --phase <phase_x> --task-id <id> [--project <path>]\n");

	// Progress appends with timestamps; --replace overwrites; values may start with "--".
	ok("task_write_progress", ...p0, "--task-id", "C", "--progress-text", "first");
	ok("task_write_progress", ...p0, "--task-id", "C", "--progress-text", "--second");
	const progress = readTasks("phase_0").find((t) => t.id === "C").progress;
	assert.equal(progress.length, 2);
	assert.match(progress[0].detail, /^first$/);
	assert.match(progress[0].time, /^\d{4}-\d\d-\d\dT[\d:]+Z$/);
	assert.match(progress[1].detail, /^--second$/);
	assert.match(progress[1].time, /^\d{4}-\d\d-\d\dT[\d:]+Z$/);
	ok("task_write_progress", ...p0, "--task-id", "C", "--progress-text", "only", "--replace");
	const replaced = readTasks("phase_0").find((t) => t.id === "C").progress;
	assert.equal(replaced.length, 1);
	assert.equal(replaced[0].detail, "only");

	// plan_status reports current phase.
	assert.equal(ok("plan_status", "--plan", "demo"), "phase_0 phase_0: 2/3 done\nphase_1 phase_1: 0/1 done\nCurrent: phase_0\n");
	ok("task_in_progress", ...p0, "--task-id", "C");
	assert.equal(ok("task_ready", ...p0), "No ready tasks. In progress: C.\n");
	assert.equal(ok("task_completed", ...p0, "--task-id", "C"), "C: in_progress -> completed. Phase phase_0 complete. Next: phase_1\n");
	assert.equal(ok("task_ready", ...p0), "No ready tasks. Phase phase_0 complete. Next: phase_1\n");
	ok("task_reset", ...p0, "--task-id", "C");

	// Legacy fail_desc is folded into progress, not dropped.
	writePhase("phase_1", [task("D", { status: "fail", fail_desc: "boom" })]);
	ok("task_write_progress", ...p1, "--task-id", "D", "--progress-text", "retry");
	assert.equal(readTasks("phase_1")[0].progress[0].detail, "[legacy fail_desc] boom");
	assert.match(readTasks("phase_1")[0].progress[1].detail, /retry/);
	assert.equal("fail_desc" in readTasks("phase_1")[0], false);

	// Legacy detail parser: labels only at line start, preamble/Files stay in goal, Done when kept in verify.
	const { parseLegacyDetail } = require("../bin/commands/_shared/phase");
	assert.deepEqual(parseLegacyDetail("Goal: g\nFiles: a.ts\nContract: see Steps: below\nSteps:\n1. one\n2) two\n- three\n   a. sub\nVerify: npm test\nDone when: green"), {
		goal: "g\nFiles: a.ts",
		contract: "see Steps: below",
		steps: ["one", "two", "three", "a. sub"],
		verify: "npm test\nDone when: green",
	});
	assert.deepEqual(parseLegacyDetail("free text, no labels"), { goal: "free text, no labels", contract: "", steps: [], verify: "" });

	// A lone "a; b" step is split; ";" inside `code` or brackets is kept; multi-step lists untouched.
	const { splitSteps } = require("../bin/commands/_shared/phase");
	assert.deepEqual(splitSteps(["Use CRG; inspect diff. Run `a; b` (x; y);"]), ["Use CRG", "inspect diff. Run `a; b` (x; y)"]);
	assert.deepEqual(splitSteps(["a; b", "c"]), ["a; b", "c"]);
	assert.deepEqual(splitSteps(["no separator"]), ["no separator"]);

	// migrate_format: dry-run writes nothing; real run backs up, rewrites legacy tasks only, is idempotent.
	writePhase("phase_1", [task("D", { status: "start", detail: "Goal: g\nSteps:\n1. s\nVerify: v", progress: "[2026-01-01T00:00:00Z] did", fail_desc: "boom" })]);
	const rawBefore = fs.readFileSync(path.join(tasksDir, "phase_1.json"), "utf8");
	assert.match(ok("migrate_format", "--plan", "demo", "--dry-run"), /^Would migrate 1 phase file\(s\), 1 task\(s\) in plan demo\.\nphase_1\n$/);
	assert.equal(fs.readFileSync(path.join(tasksDir, "phase_1.json"), "utf8"), rawBefore);
	const migrated = ok("migrate_format", "--plan", "demo");
	assert.match(migrated, /^Migrated 1 phase file\(s\), 1 task\(s\) in plan demo\. Backup: .*tasks\.bak-\d{8}\nphase_1\n$/);
	const backupDir = /Backup: (.*)\n/.exec(migrated)[1];
	assert.equal(fs.readFileSync(path.join(backupDir, "phase_1.json"), "utf8"), rawBefore);
	const [d] = readTasks("phase_1");
	assert.deepEqual(d.details, { goal: "g", contract: "", steps: ["s"], verify: "v" });
	assert.deepEqual(d.progress, [{ time: "2026-01-01T00:00:00Z", detail: "did" }, { time: "", detail: "[legacy fail_desc] boom" }]);
	assert.equal(d.status, "todo");
	assert.equal("detail" in d || "fail_desc" in d, false);
	assert.match(ok("migrate_format", "--plan", "demo"), /^Migrated 0 phase file\(s\), 0 task\(s\)/);
	// Already-new-format task with one packed step also counts as needing reformat.
	const packed = readTasks("phase_1");
	packed[0].details.steps = ["x; y"];
	writePhase("phase_1", packed);
	assert.match(ok("migrate_format", "--plan", "demo"), /^Migrated 1 phase file\(s\), 1 task\(s\)/);
	assert.deepEqual(readTasks("phase_1")[0].details.steps, ["x", "y"]);
	for (const name of fs.readdirSync(path.dirname(tasksDir))) if (name.startsWith("tasks.bak-")) fs.rmSync(path.join(path.dirname(tasksDir), name), { recursive: true });

	// Pure analysis: glob overlap, waves, critical path.
	const { patternsOverlap, waves, criticalPath } = require("../bin/commands/_shared/analysis");
	assert.equal(patternsOverlap("src/a.ts", "src/**"), true);
	assert.equal(patternsOverlap("src/api/", "src/api/x.ts"), true);
	assert.equal(patternsOverlap("src/*.ts", "src/x/y.ts"), false);
	assert.equal(patternsOverlap("src/a/**", "src/b/**"), false);
	assert.equal(patternsOverlap("src/a.ts", "src/b.ts"), false);
	assert.equal(patternsOverlap("src/users", "src/users/x.ts"), true); // literal dir without trailing "/"
	assert.equal(patternsOverlap("src/user", "src/users/x.ts"), false);
	assert.equal(patternsOverlap("src", "src/**/*.ts"), true);
	const diamond = { tasks: [task("A"), task("B", { pre_request: ["A"] }), task("C", { pre_request: ["A"] }), task("D", { pre_request: ["B", "C"] })] };
	assert.deepEqual(waves(diamond).map((wave) => wave.map((t) => t.id)), [["A"], ["B", "C"], ["D"]]);
	assert.equal(criticalPath(diamond).length, 3);

	// files/agent schema.
	writePhase("phase_1", [task("D", { files: ["/abs"] })]);
	bad(/must be repo-relative/, "plan_validate", "--plan", "demo");
	writePhase("phase_1", [task("D", { agent: "wizard" })]);
	bad(/agent must be one of/, "plan_validate", "--plan", "demo");

	// Concurrent file overlap is an error; ordering via pre_request resolves it.
	const packet = "Goal: g\nFiles: f\nSteps: s\nVerify: v\nDone when: d";
	const t = (id, extra) => task(id, { detail: packet, agent: "implement", ...extra });
	writePhase("phase_1", [t("E", { files: ["src/shared.ts"] }), t("F", { files: ["src/**"] })]);
	bad(/E and F can run concurrently but share files/, "plan_validate", "--plan", "demo");
	writePhase("phase_1", [t("E", { files: ["src/shared.ts"] }), t("F", { files: ["src/**"], pre_request: ["E"] })]);
	assert.doesNotMatch(ok("plan_validate", "--plan", "demo"), /share files/);

	// Warnings: serial phase; --strict fails on warnings; well-formed fan-out has none for that phase.
	assert.match(ok("plan_validate", "--plan", "demo"), /phase_1: fully serial/);
	bad(/Plan invalid/, "plan_validate", "--plan", "demo", "--strict");
	writePhase("phase_1", [
		t("E", { files: ["src/a.ts"] }),
		t("F", { files: ["src/b.ts"] }),
		t("G", { files: ["src/index.ts"], agent: "verify", pre_request: ["E", "F"] }),
	]);
	assert.doesNotMatch(ok("plan_validate", "--plan", "demo"), /phase_1:/);
	const wavesOut = ok("plan_waves", "--plan", "demo");
	assert.match(wavesOut, /## phase_1[^]*Wave 1 \(2\): E \[implement\], F \[implement\]\nWave 2 \(1\): G \[verify\]/);
	assert.match(wavesOut, /Critical path \(2\): (E|F) -> G/);
	assert.match(ok("task_get", ...p1, "--task-id", "E"), /^E \[todo, ready\] E\nPhase: phase_1 \| Agent: implement \| Files: src\/a.ts\n## Detail\n/);

	// Parallel writers on one phase file: no lost updates.
	const ids = Array.from({ length: 12 }, (_, i) => `P${i}`);
	writePhase("phase_1", ids.map((id) => task(id)));
	await Promise.all(ids.map((id) => new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [CLI, "task_write_progress", ...p1, "--task-id", id, "--progress-text", `done ${id}`, "--project", project], { env });
		child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`writer ${id} exited ${code}`))));
	})));
	for (const t of readTasks("phase_1")) assert.match(t.progress[t.progress.length - 1].detail, new RegExp(`done ${t.id}$`), `lost update for ${t.id}`);
	assert.equal(fs.readdirSync(tasksDir).some((name) => name.endsWith(".lock")), false, "stale lock left behind");

	// Empty phase is an error (would otherwise read as complete).
	writePhase("phase_2", []);
	bad(/phase_2: phase has no tasks/, "plan_validate", "--plan", "demo");
	fs.unlinkSync(path.join(tasksDir, "phase_2.json"));

	// Missing plan is an error, not an empty status.
	bad(/plan not found/, "plan_status", "--plan", "nope");

	// Dashboard: API carries lint/waves, Host guard, port conflict is a clean error.
	await dashboardChecks();

	process.stdout.write("self-check passed\n");
}

function get(port, host, urlPath = "/api/tasks", method = "GET", headers = {}) {
	return new Promise((resolve, reject) => {
		const request = http.request({ host: "127.0.0.1", port, path: urlPath, method, headers: { host, ...headers } }, (response) => {
			let body = "";
			response.on("data", (chunk) => { body += chunk; });
			response.on("end", () => resolve({ status: response.statusCode, body }));
		});
		request.on("error", reject);
		request.end();
	});
}

async function waitFor(fn, ms = 5000) {
	const deadline = Date.now() + ms;
	for (;;) {
		try { return await fn(); } catch (error) {
			if (Date.now() > deadline) throw error;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
}

async function dashboardChecks() {
	const port = String(40000 + Math.floor(Math.random() * 20000));
	writePhase("phase_2", [task("X")]);
	const server = spawn(process.execPath, [CLI, "dashboard_serve", "--project", project, "--port", port], { env });
	try {
		const okResponse = await waitFor(() => get(port, `127.0.0.1:${port}`));
		assert.equal(okResponse.status, 200);
		const phase = JSON.parse(okResponse.body).projects[0].plans[0].phases.find((p) => p.name === "phase_0");
		assert.ok(Array.isArray(phase.errors) && Array.isArray(phase.warnings), "api lint fields");
		assert.equal(typeof phase.wave.A, "number");
		assert.ok(Array.isArray(phase.criticalPath));
		// phase_2 holds one legacy-format task, so the Reformat button must show.
		assert.equal(JSON.parse(okResponse.body).projects[0].plans[0].legacyTasks, 1);
		// Reformat button endpoint: CSRF header required, then migrates in code and the count drops to 0.
		const host = `127.0.0.1:${port}`;
		const migrateUrl = `/api/migrate_format?project=${encodeURIComponent(fs.realpathSync(project))}&plan=demo`;
		assert.equal((await get(port, host, migrateUrl, "POST")).status, 403);
		assert.equal((await get(port, host, "/api/migrate_format?project=/etc&plan=demo", "POST", { "x-ppm-action": "1" })).status, 404);
		const migratedRes = await get(port, host, migrateUrl, "POST", { "x-ppm-action": "1" });
		assert.equal(migratedRes.status, 200, migratedRes.body);
		const migratedBody = JSON.parse(migratedRes.body);
		assert.deepEqual([migratedBody.phases, migratedBody.tasks], [["phase_2"], 1]);
		fs.rmSync(migratedBody.backup, { recursive: true });
		assert.equal(JSON.parse((await get(port, host)).body).projects[0].plans[0].legacyTasks, 0);
		assert.equal((await get(port, `localhost:${port}`)).status, 200);
		assert.equal((await get(port, `evil.example:${port}`)).status, 403);
		// Standalone flag lets panel/app.js load without a pi-web cwd (else stuck on "Waiting for a workspace…").
		assert.match((await get(port, `127.0.0.1:${port}`, "/ppm-data.js")).body, /window\.PpmStandalone = true/);
		const clash = spawnSync(process.execPath, [CLI, "dashboard_serve", "--project", project, "--port", port], { env, encoding: "utf8", timeout: 5000 });
		assert.equal(clash.status, 1);
		assert.match(clash.stderr, /^Error: dashboard failed to start: port \d+ is already in use/);
		assert.match(spawnSync(process.execPath, [CLI, "check_dashboard", "--port", port], { env, encoding: "utf8" }).stdout, /^Dashboard running: /);
	} finally {
		server.kill();
		fs.unlinkSync(path.join(tasksDir, "phase_2.json"));
	}
}

main()
	.catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; })
	.finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
