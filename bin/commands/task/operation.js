"use strict";

const { createOperation } = require("../../createOperation");
const {
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
} = require("./helper");

const taskOptions = ["project", "plan", "phase", "task-id"];
const statusOptions = [...taskOptions, "force"];
const taskIdRequired = ["plan", "phase", "task-id"];

module.exports = [
	createOperation({
		name: "plan_validate",
		usage: "ppm plan_validate --plan <name> [--strict] [--project <path>]",
		handler: planValidateHandler,
		options: ["project", "plan", "strict"],
		required: ["plan"],
	}),

	createOperation({
		name: "plan_waves",
		usage: "ppm plan_waves --plan <name> [--project <path>]",
		handler: planWavesHandler,
		options: ["project", "plan"],
		required: ["plan"],
	}),

	createOperation({
		name: "plan_status",
		usage: "ppm plan_status --plan <name> [--project <path>]",
		handler: planStatusHandler,
		options: ["project", "plan"],
		required: ["plan"],
	}),

	createOperation({
		name: "task_list",
		usage: "ppm task_list --plan <name> --phase <phase_x> [--project <path>]",
		handler: taskListHandler,
		options: ["project", "plan", "phase"],
		required: ["plan", "phase"],
	}),

	createOperation({
		name: "task_ready",
		usage: "ppm task_ready --plan <name> --phase <phase_x> [--project <path>]",
		handler: taskReadyHandler,
		options: ["project", "plan", "phase"],
		required: ["plan", "phase"],
	}),

	createOperation({
		name: "task_blocked",
		usage: "ppm task_blocked --plan <name> --phase <phase_x> [--project <path>]",
		handler: taskBlockedHandler,
		options: ["project", "plan", "phase"],
		required: ["plan", "phase"],
	}),

	createOperation({
		name: "task_get",
		usage: "ppm task_get --plan <name> --phase <phase_x> --task-id <id> [--project <path>]",
		handler: taskGetHandler,
		options: taskOptions,
		required: taskIdRequired,
	}),

	createOperation({
		name: "task_upsert",
		usage: "ppm task_upsert --plan <name> --phase <phase_x> --task <json|-> [--title <phase title>] [--force] [--project <path>]",
		handler: taskUpsertHandler,
		options: ["project", "plan", "phase", "task", "title", "force"],
		required: ["plan", "phase", "task"],
	}),

	createOperation({
		name: "task_remove",
		usage: "ppm task_remove --plan <name> --phase <phase_x> --task-id <id> [--force] [--project <path>]",
		handler: taskRemoveHandler,
		options: statusOptions,
		required: taskIdRequired,
	}),

	createOperation({
		name: "task_in_progress",
		usage: "ppm task_in_progress --plan <name> --phase <phase_x> --task-id <id> [--force] [--project <path>]",
		handler: (options) => setTaskStatus(options, "in_progress"),
		options: statusOptions,
		required: taskIdRequired,
	}),

	createOperation({
		name: "task_completed",
		usage: "ppm task_completed --plan <name> --phase <phase_x> --task-id <id> [--force] [--project <path>]",
		handler: (options) => setTaskStatus(options, "completed"),
		options: statusOptions,
		required: taskIdRequired,
	}),

	createOperation({
		name: "task_fail",
		usage: "ppm task_fail --plan <name> --phase <phase_x> --task-id <id> [--force] [--project <path>]",
		handler: (options) => setTaskStatus(options, "fail"),
		options: statusOptions,
		required: taskIdRequired,
	}),

	createOperation({
		name: "task_reset",
		usage: "ppm task_reset --plan <name> --phase <phase_x> --task-id <id> [--force] [--project <path>]",
		handler: (options) => setTaskStatus(options, "todo"),
		options: statusOptions,
		required: taskIdRequired,
	}),

	createOperation({
		name: "task_write_progress",
		usage: "ppm task_write_progress --plan <name> --phase <phase_x> --task-id <id> --progress-text <text> [--replace] [--project <path>]",
		handler: taskWriteProgressHandler,
		options: ["project", "plan", "phase", "task-id", "progress-text", "replace"],
		required: ["plan", "phase", "task-id", "progress-text"],
		validators: { "progress-text": validateProgressText },
	}),
];