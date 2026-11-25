"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { PLAN_PATTERN, assertSafeSegment, projectRoot } = require("../_shared/phase");
const { PLAN_DOCS } = require("../_shared/patterns");
const { validateMetadata, metadataTimestamp, formatMetadataTimestamp } = require("../../../panel/metadata.js");

const METADATA_FILE = "metadata.json";
const LEGACY_FILE = "plan.md";

// Canonical metadata on disk. null only when metadata.json is missing; invalid JSON or invalid content throws.
function readMetadata(planRoot) {
	const file = path.join(planRoot, METADATA_FILE);
	let text;
	try { text = fs.readFileSync(file, "utf8"); } catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
	let metadata;
	try { metadata = JSON.parse(text); } catch (error) { throw new Error(`metadata.json: invalid JSON [${file}]: ${error.message}`); }
	try { return validateMetadata(metadata); } catch (error) { throw new Error(`${error.message} [${file}]`); }
}

// Exclusive create: hard-linking onto an existing metadata.json fails, so canonical is never overwritten.
function createMetadata(planRoot, metadata) {
	validateMetadata(metadata);
	const file = path.join(planRoot, METADATA_FILE);
	const temporary = `${file}.${process.pid}.tmp`;
	try {
		fs.writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		fs.linkSync(temporary, file);
	} catch (error) {
		if (error.code === "EEXIST") throw new Error(`metadata.json already exists, not overwritten: ${file}`);
		throw error;
	} finally {
		fs.rmSync(temporary, { force: true });
	}
}

// Fresh plans only (called from ppm init --plan). Skipped when metadata.json or a legacy plan.md already exists.
function seedMetadata(planRoot, plan, now = Date.now()) {
	if (fs.existsSync(path.join(planRoot, METADATA_FILE)) || fs.existsSync(path.join(planRoot, LEGACY_FILE))) return false;
	const stamp = formatMetadataTimestamp(now);
	createMetadata(planRoot, {
		title: plan,
		"created-at": stamp,
		"updated-at": stamp,
		files: Object.fromEntries(PLAN_DOCS.map((doc) => [doc, doc])),
		"change-log": { [stamp]: "created" },
	});
	return true;
}

const DATE_TOKEN = "\\d{4}-\\d{2}-\\d{2}(?:[T ]\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?(?:Z|[+-]\\d{2}:?\\d{2})?)?";
const CHANGELOG_ENTRY = new RegExp(`^\\s*[-*]\\s+(${DATE_TOKEN})\\s*:\\s*(.*)$`);
const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/;
const FILE_ENTRY = /^[ \t]*[-*][ \t]+(.+?)[ \t]*:[ \t]*(\S.*?)[ \t]*$/;
// A bare path can be extensionless. Paths with whitespace must be backtick-quoted.
const PATH_LIKE = /^[^\s:]+$/;

function headerValue(content, label) {
	const match = new RegExp(`^[ \\t]*${label}[ \\t]*:[ \\t]*(.*?)[ \\t]*$`, "im").exec(content);
	return match && match[1] ? match[1] : null;
}

function headerEpoch(raw, label) {
	if (raw === null) return null;
	const epoch = metadataTimestamp(raw);
	if (epoch === null) throw new Error(`plan.md: invalid ${label} value: ${raw}`);
	return epoch;
}

// Body lines of each "## <name>" section whose heading matches pattern, up to the next heading.
function sectionsOf(content, pattern) {
	const bodies = [];
	let current = null;
	for (const line of content.split(/\r?\n/)) {
		const heading = /^##[ \t]+(.+?)[ \t]*$/.exec(line);
		if (heading) {
			current = pattern.test(heading[1]) ? [] : null;
			if (current) bodies.push(current);
			continue;
		}
		if (/^#[ \t]/.test(line)) current = null;
		else if (current) current.push(line);
	}
	return bodies;
}

// Standard docs map to themselves when present. Explicit "[text](target)" or "name: path" entries add keys;
// standard-doc descriptions ("plan.objective.md: objective, scope") and prose are not paths and are skipped.
function filesFromLegacy(planRoot, content) {
	const files = new Map();
	for (const lines of sectionsOf(content, /^files$/i)) {
		for (const line of lines) {
			const link = LINK.exec(line);
			let key;
			let value;
			if (link) {
				key = link[1].trim();
				value = link[2];
			} else {
				const entry = FILE_ENTRY.exec(line);
				if (!entry) continue;
				key = entry[1].replace(/`/g, "").trim();
				const quoted = /^`(.+)`$/.exec(entry[2]);
				value = quoted ? quoted[1].trim() : entry[2];
				if (!quoted && !PATH_LIKE.test(value)) continue;
			}
			if (!key || !value) continue;
			if (files.has(key) && files.get(key) !== value) throw new Error(`plan.md Files: duplicate entry "${key}"`);
			files.set(key, value);
		}
	}
	for (const doc of PLAN_DOCS) if (!files.has(doc) && fs.existsSync(path.join(planRoot, doc))) files.set(doc, doc);
	return Object.fromEntries(files);
}

// Dated Changelog / Adjustment log lines -> "DD-MM-YYYY HH:MM" keys. Duplicate minutes join with newline.
function changelogFromLegacy(content) {
	const changelog = {};
	for (const lines of sectionsOf(content, /^(changelog|adjustment log)$/i)) {
		let last = null;
		for (const line of lines) {
			if (!line.trim()) continue;
			const entry = CHANGELOG_ENTRY.exec(line);
			if (entry) {
				const stamp = formatMetadataTimestamp(entry[1]);
				if (stamp === null) throw new Error(`plan.md changelog: invalid date: ${entry[1]}`);
				const text = entry[2].trim();
				if (!text) throw new Error(`plan.md changelog: empty description for ${entry[1]}`);
				changelog[stamp] = changelog[stamp] === undefined ? text : `${changelog[stamp]}\n${text}`;
				last = stamp;
				continue;
			}
			// Non-empty text before the first dated entry has no key to attach to: fail rather than drop it.
			if (last === null) throw new Error(`plan.md changelog: text before first dated entry: ${line.trim()}`);
			changelog[last] += `\n${line.trim()}`;
		}
	}
	return changelog;
}

// Legacy plan.md -> canonical metadata object. Absent dates fall back to plan.md birth/mtime; invalid values throw.
function metadataFromLegacy(planRoot, content, stat, plan) {
	const heading = /^#[ \t]+(.+?)[ \t]*$/m.exec(content);
	const updated = headerEpoch(headerValue(content, "Last updated"), "Last updated") ?? stat.mtimeMs;
	const created = headerEpoch(headerValue(content, "Created"), "Created") ?? Math.min(stat.birthtimeMs || stat.mtimeMs, updated);
	const metadata = {
		title: heading ? heading[1] : plan,
		"created-at": formatMetadataTimestamp(created),
		"updated-at": formatMetadataTimestamp(updated),
	};
	const base = headerValue(content, "Base commit");
	if (base !== null) metadata["base-commit"] = base;
	metadata.files = filesFromLegacy(planRoot, content);
	metadata["change-log"] = changelogFromLegacy(content);
	return validateMetadata(metadata);
}

function planRootOf(options) {
	assertSafeSegment(options.plan, "plan name", PLAN_PATTERN);
	const planRoot = path.join(projectRoot(options), ".ppm", options.plan);
	if (!fs.existsSync(planRoot)) throw new Error(`plan not found: ${planRoot}`);
	return planRoot;
}

// Prints canonical JSON only. Read-only.
function metadataHandler(options) {
	const planRoot = planRootOf(options);
	const metadata = readMetadata(planRoot);
	if (!metadata) {
		if (fs.existsSync(path.join(planRoot, LEGACY_FILE))) {
			const project = path.dirname(path.dirname(planRoot)).replace(/'/g, `'"'"'`);
			throw new Error(`metadata.json not found for plan ${options.plan}; legacy plan.md present. Run: ppm migrate_metadata --plan ${options.plan} --project '${project}'`);
		}
		throw new Error(`metadata.json not found: ${path.join(planRoot, METADATA_FILE)}`);
	}
	process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`);
}

// Explicit only. Never overwrites metadata.json; plan.md is left untouched as rollback backup.
function migrateMetadataHandler(options) {
	const planRoot = planRootOf(options);
	const file = path.join(planRoot, METADATA_FILE);
	if (readMetadata(planRoot)) {
		process.stdout.write(`Metadata already present and valid: ${file}. Nothing to migrate.\n`);
		return;
	}
	const legacy = path.join(planRoot, LEGACY_FILE);
	if (!fs.existsSync(legacy)) throw new Error(`legacy plan.md not found: ${legacy}`);
	const metadata = metadataFromLegacy(planRoot, fs.readFileSync(legacy, "utf8"), fs.statSync(legacy), options.plan);
	if (options["dry-run"]) {
		process.stdout.write(`Would write ${file}:\n${JSON.stringify(metadata, null, 2)}\n`);
		return;
	}
	createMetadata(planRoot, metadata);
	process.stdout.write(`Migrated: ${legacy} -> ${file} (plan.md kept as rollback backup)\n`);
}

module.exports = { readMetadata, seedMetadata, metadataHandler, migrateMetadataHandler };
