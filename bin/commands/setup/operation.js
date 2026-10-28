"use strict";

const { createOperation } = require("../../createOperation");
const {
	initHandler,
	migrateHandler,
	cleanRootsHandler,
	dashboardServeHandler,
	dashboardHealthHandler,
	validatePort,
} = require("./helper");
const { migrateFormatHandler } = require("./format");

module.exports = [
	createOperation({
		name: "init",
		usage: "ppm init [--plan <name>] [--project <path>]",
		handler: initHandler,
		options: ["plan", "project"],
	}),

	createOperation({
		name: "plan_init",
		usage: "ppm plan_init --plan <name> [--project <path>]",
		handler: initHandler,
		options: ["plan", "project"],
		required: ["plan"],
	}),

	createOperation({
		name: "migrate",
		usage: "ppm migrate [--project <path>] [--dry-run]",
		handler: migrateHandler,
		options: ["project", "dry-run"],
	}),

	createOperation({
		name: "clean_roots",
		usage: "ppm clean_roots [--dry-run]",
		handler: cleanRootsHandler,
		options: ["dry-run"],
	}),

	createOperation({
		name: "dashboard_serve",
		usage: "ppm dashboard_serve [--project <path>] [--port <port>]",
		handler: dashboardServeHandler,
		options: ["project", "port"],
		validators: { port: validatePort },
	}),

	createOperation({
		name: "check_dashboard",
		usage: "ppm check_dashboard [--port <port>]",
		handler: dashboardHealthHandler,
		options: ["port"],
		validators: { port: validatePort },
	}),

	createOperation({
		name: "migrate_format",
		usage: "ppm migrate_format --plan <name> [--dry-run] [--project <path>]",
		handler: migrateFormatHandler,
		options: ["project", "plan", "dry-run"],
		required: ["plan"],
	}),
];
