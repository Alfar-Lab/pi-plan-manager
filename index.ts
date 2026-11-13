import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// Thin wrapper over bin/ppm.js: same operations, same validation, same output as the CLI.
const require = createRequire(import.meta.url);
const CLI = require.resolve("./bin/ppm.js");
const ops: { name: string; usage: string }[] = [
	...require("./bin/commands/setup/operation.js"),
	...require("./bin/commands/task/operation.js"),
];

const str = (description: string) => Type.Optional(Type.String({ description }));
const flag = (description: string) => Type.Optional(Type.Boolean({ description }));

const Params = Type.Object({
	op: Type.Union(ops.map((o) => Type.Literal(o.name)), { description: "ppm operation" }),
	plan: str("--plan <name>"),
	phase: str("--phase <phase_x>"),
	task_id: str("--task-id <id>"),
	progress_text: str("--progress-text <text>"),
	task: Type.Optional(Type.Unknown({ description: "task_upsert: one task object or an array of them (JSON merge patch by id; null deletes a field)" })),
	title: str("task_upsert: --title <phase title>"),
	project: str("--project <path> (default: cwd)"),
	port: str("--port <port>"),
	force: flag("--force"),
	replace: flag("--replace"),
	strict: flag("--strict"),
	dry_run: flag("--dry-run"),
});

const PHASE_FILE = /[\\/]\.ppm[\\/][^\\/]+[\\/]tasks[\\/][^\\/]+\.json$/;

export default function (pi: ExtensionAPI) {
	// Whole-file writes of phase JSON are the token sink (8-40 KB rewritten per mistake) and skip status guards.
	// ponytail: bash writes (heredoc, sed -i) are not caught; prompts cover those.
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		const file = (event.input as { path?: string }).path;
		if (!file || !PHASE_FILE.test(resolve(ctx.cwd, file.replace(/^@/, "")))) return;
		return {
			block: true,
			reason: "Phase task files are managed by the ppm tool. Use op task_upsert (task: one task object or a few; only changed fields when updating), task_remove, task_* status ops, or task_write_progress.",
		};
	});

	pi.registerTool({
		name: "ppm",
		label: "ppm",
		description: [
			"Project Plan Manager CLI as a tool. Use wherever the project-plan-manager skill says `ppm <op> --flag value`:",
			"pass op plus flags as params (--task-id -> task_id, --progress-text -> progress_text, --dry-run -> dry_run, boolean flags -> true).",
			...ops.map((o) => o.usage),
			"dashboard_serve starts the dashboard in the background; confirm with op check_dashboard.",
		].join("\n"),
		promptSnippet: "Project Plan Manager (ppm) operations for .ppm plans, phases, and tasks",
		promptGuidelines: [
			"Change .ppm phase task files only through the ppm tool: task_upsert/task_remove for plan content (a few tasks per call; fix one failing task, never rewrite the phase), task_* status ops and task_write_progress during execution. Never write or edit .ppm/*/tasks/*.json directly.",
		],
		parameters: Params,
		async execute(_id, p, signal, _onUpdate, ctx) {
			const args: string[] = [p.op];
			for (const [key, value] of Object.entries(p)) {
				if (key === "op" || value === undefined || value === false) continue;
				args.push(`--${key.replace(/_/g, "-")}`);
				if (value !== true) args.push(typeof value === "string" ? value : JSON.stringify(value));
			}

			if (p.op === "dashboard_serve") {
				// Long-lived server: detach so the tool returns. ponytail: startup errors (e.g. port in use) surface only via check_dashboard.
				spawn(process.execPath, [CLI, ...args], { cwd: ctx.cwd, detached: true, stdio: "ignore" }).unref();
				return { content: [{ type: "text", text: `Dashboard starting on port ${p.port ?? "4173"}. Run op check_dashboard to confirm.` }], details: undefined };
			}

			const r = await pi.exec(process.execPath, [CLI, ...args], { cwd: ctx.cwd, signal });
			const t = truncateHead(`${r.stdout}${r.stderr}`.trim() || "(no output)", { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
			const text = t.truncated ? `${t.content}\n[truncated: ${t.outputLines} of ${t.totalLines} lines]` : t.content;
			if (r.code !== 0) throw new Error(`exit ${r.code}\n${text}`);
			return { content: [{ type: "text", text }], details: undefined };
		},
	});
}
