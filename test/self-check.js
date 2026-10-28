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

function get(port, host) {
	return new Promise((resolve, reject) => {
		const request = http.get({ host: "127.0.0.1", port, path: "/api/tasks", headers: { host } }, (response) => {
			let body = "";
			response.on("data", (chunk) => { body += chunk; });
			response.on("end", () => resolve({ status: response.statusCode, body }));
		});
		request.on("error", reject);
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
	const server = spawn(process.execPath, [CLI, "dashboard_serve", "--project", project, "--port", port], { env });
	try {
		const okResponse = await waitFor(() => get(port, `127.0.0.1:${port}`));
		assert.equal(okResponse.status, 200);
		const phase = JSON.parse(okResponse.body).projects[0].plans[0].phases.find((p) => p.name === "phase_0");
		assert.ok(Array.isArray(phase.errors) && Array.isArray(phase.warnings), "api lint fields");
		assert.equal(typeof phase.wave.A, "number");
		assert.ok(Array.isArray(phase.criticalPath));
		assert.equal((await get(port, `localhost:${port}`)).status, 200);
		assert.equal((await get(port, `evil.example:${port}`)).status, 403);
		const clash = spawnSync(process.execPath, [CLI, "dashboard_serve", "--project", project, "--port", port], { env, encoding: "utf8", timeout: 5000 });
		assert.equal(clash.status, 1);
		assert.match(clash.stderr, /^Error: dashboard failed to start: port \d+ is already in use/);
		assert.match(spawnSync(process.execPath, [CLI, "check_dashboard", "--port", port], { env, encoding: "utf8" }).stdout, /^Dashboard running: /);
	} finally {
		server.kill();
	}
}

main()
	.catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; })
	.finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
