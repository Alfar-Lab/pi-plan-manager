# Installation and automatic-use flow

Use this flow for installing `ppm`, fixing PATH exposure, enabling automatic skill use, or integrating with `AGENTS.md`. Do not modify shell profiles or `AGENTS.md` without explicit user consent.

## 1. Check prerequisites

Verify Node.js is version 18 or newer:

```bash
node --version
```

If Node.js is missing or older than 18, stop and ask the user to install or select a supported version.

## 2. Install the CLI shim

From the pi-plan-manager skill package root, run or instruct:

```bash
npm link
```

Verify that the command resolves without a full path:

```bash
command -v ppm
npm prefix -g
```

On Windows, use:

```powershell
where ppm
npm prefix -g
```

If the command does not resolve, explain that npm's global executable directory must be on `PATH`. On Unix/macOS, it is usually `<prefix>/bin`, where `<prefix>` is the output of `npm prefix -g`:

```bash
export PATH="<prefix>/bin:$PATH"
```

Ask before editing any shell profile. Never silently modify `.profile`, `.bashrc`, `.zshrc`, PowerShell profiles, or equivalent configuration. On Windows, ask before changing the relevant user `PATH`; do not assume or invent a prefix location. Do not recommend invoking `bin/ppm.js` by full path as a routine workaround.

Restart the shell and agent client after a PATH change or installation so both reload the command and skill.

## 3. Ask before automatic-use setup

Ask this exact question:

> Apakah Anda ingin skill Pi Plan Manager otomatis digunakan untuk permintaan planning, execution, dan plan audit?

If the answer is no, stop. Do not inspect for the purpose of editing, create, or modify any `AGENTS.md`.

If the answer is yes, continue.

## 4. Resolve the correct user-level AGENTS.md

Identify the actual user-level `AGENTS.md` loaded by the current client and environment. Do not assume one universal path. Distinguish it from a project-level `AGENTS.md`; the requested target is user-level configuration. If the client, environment, or path is ambiguous, ask the user which file is authoritative and stop until clarified.

Inspect the existing target file before editing. Preserve all existing content. Never overwrite the file. The only permitted change is one bounded, idempotent section:

```markdown
<!-- pi-plan-manager:start -->
For planning, executing/resuming, auditing, or adjusting plans, load and use the `pi-plan-manager` skill. Follow its routed prompt files and use the `ppm` CLI.
<!-- pi-plan-manager:end -->
```

If the bounded section already exists, update that section in place only when needed; do not add a duplicate. If markers are malformed or overlap unrelated content, ask the user before changing it.

## 5. Preview and confirm the external change

Show the user the target path and exact bounded diff. Immediately before writing, ask for confirmation to update that user-level `AGENTS.md`. If denied, stop without writing.

After confirmation, append or update only the bounded section. Verify that the markers occur exactly once, the surrounding content remains intact, and report the path plus the change. On rerun, make no change when the section is already correct.
