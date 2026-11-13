"use strict";

const PLAN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PHASE_PATTERN = /^phase_[A-Za-z0-9][A-Za-z0-9_-]*$/;
const VALID_STATUSES = new Set(["todo", "in_progress", "completed", "fail"]);
// Client-agnostic role hints; the orchestrator maps them to whatever sub agents exist.
const VALID_AGENTS = new Set(["explore", "implement", "review", "verify"]);

// plan.md holds metadata + changelog; each topic lives in its own file so agents read only what they need.
const PLAN_DOCS = ["plan.objective.md", "plan.constraint_invariant.md", "plan.approach.md", "plan.risk.md"];
// Pre-split plan.md carried every section inline ("## 1. Objective" ...).
const LEGACY_PLAN_MD = /^##\s*1\.\s*Objective/m;

module.exports = { PLAN_PATTERN, PHASE_PATTERN, VALID_STATUSES, VALID_AGENTS, PLAN_DOCS, LEGACY_PLAN_MD };