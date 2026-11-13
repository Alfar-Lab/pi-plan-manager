#!/usr/bin/env bash
# install.sh - install pi-plan-manager skill and link the `ppm` CLI
#
# Usage:
#   ./install.sh [--client opencode|claude|codex|pi|all] [--mode copy|link]
#   ./install.sh --uninstall [--client opencode|claude|codex|pi|all]
#
# Modes:
#   copy - copy skill files into the agent's skills directory (default, frozen install)
#   link - symlink the source repo into the agent's skills directory (development)
#
# Always runs `npm link` so `ppm` is exposed on PATH for the chosen client(s).
# Requires Node.js >=18 and npm on PATH. Runs on POSIX shells; on Windows use WSL or Git Bash.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_NAME="pi-plan-manager"
PACKAGE_NAME="pi-plan-manager"

CLIENT="opencode"
MODE="copy"
ACTION="install"

need_value() { [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || { echo "missing value for $1" >&2; exit 2; }; }

while [[ $# -gt 0 ]]; do
	case "$1" in
		--client) need_value "$@"; CLIENT="$2"; shift 2 ;;
		--mode) need_value "$@"; MODE="$2"; shift 2 ;;
		--uninstall) ACTION="uninstall"; shift ;;
		-h|--help)
			sed -n '2,14p' "$0"
			exit 0
			;;
		*) echo "unknown argument: $1" >&2; exit 2 ;;
	esac
done

log()  { printf '\033[1;36m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m⚠\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }

client_dir() {
	case "$1" in
		opencode) echo "$HOME/.config/opencode/skills" ;;
		claude) echo "$HOME/.claude/skills" ;;
		codex) echo "$HOME/.agents/skills" ;;
		pi) echo "$HOME/.pi/agent/skills" ;;
		*) fail "unknown client: $1" ;;
	esac
}

clients() {
	case "$1" in
		opencode) echo "opencode" ;;
		claude) echo "claude" ;;
		codex) echo "codex" ;;
		pi) echo "pi" ;;
		all) echo "opencode claude codex pi" ;;
		*) fail "unknown --client: $1 (expected opencode|claude|codex|pi|all)" ;;
	esac
}

case "$MODE" in copy|link) ;; *) echo "unknown --mode: $MODE (expected copy|link)" >&2; exit 2 ;; esac
# Validate here: clients() runs inside $(...), where its `fail` would only exit the subshell.
case "$CLIENT" in opencode|claude|codex|pi|all) ;; *) echo "unknown --client: $CLIENT (expected opencode|claude|codex|pi|all)" >&2; exit 2 ;; esac

# Absolute physical path, or empty when it does not exist.
real_dir() { (cd "$1" 2>/dev/null && pwd -P) || true; }

# True when the target skill dir IS this source checkout (cloned in place), so deleting it would delete the repo.
is_source() { [[ "$(real_dir "$1")" == "$(real_dir "$REPO_ROOT")" ]]; }

copy_tree() {
	local dest="$1"
	mkdir -p "$dest"
	if is_source "$dest/$SKILL_NAME"; then
		warn "$dest/$SKILL_NAME is this source checkout; using it in place"
		return 0
	fi
	rm -rf "$dest/$SKILL_NAME"
	if [[ "$MODE" == "link" ]]; then
		ln -s "$REPO_ROOT" "$dest/$SKILL_NAME"
		ok "linked skill -> $dest/$SKILL_NAME"
	else
		mkdir -p "$dest/$SKILL_NAME"
		# Copy only what package.json "files" publishes (+ package.json itself).
		local item
		local files
		files="$(node -p 'require(process.argv[1]).files.join(" ")' "$REPO_ROOT/package.json")" || fail "cannot read package.json files"
		for item in package.json $files; do
			[[ -e "$REPO_ROOT/$item" ]] || continue
			mkdir -p "$dest/$SKILL_NAME/$(dirname "$item")"
			cp -R "$REPO_ROOT/$item" "$dest/$SKILL_NAME/$item"
		done
		ok "copied skill -> $dest/$SKILL_NAME"
	fi
}

# First installed client dir, used as the single `npm link` source.
first_installed() {
	local c
	for c in opencode claude codex pi; do
		if [[ -f "$(client_dir "$c")/$SKILL_NAME/package.json" ]]; then
			echo "$(client_dir "$c")/$SKILL_NAME"
			return 0
		fi
	done
	return 1
}

link_bin() {
	local pkg_dir="$1"
	[[ -d "$pkg_dir" ]] || return 0
	( cd "$pkg_dir" && npm link --no-audit --no-fund >/dev/null ) || fail "npm link failed in $pkg_dir"
}

unlink_bin() {
	npm uninstall -g "$PACKAGE_NAME" --no-audit --no-fund >/dev/null 2>&1 || true
}

remove_skill() {
	local dir="$1"
	if is_source "$dir/$SKILL_NAME"; then
		warn "skipping $dir/$SKILL_NAME: it is this source checkout (delete it manually if intended)"
		return 0
	fi
	rm -rf "$dir/$SKILL_NAME"
	ok "removed skill from $dir/$SKILL_NAME"
}

command -v node >/dev/null || fail "node not found in PATH"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 18 ]] || fail "node >=18 required (found $NODE_MAJOR)"
command -v npm >/dev/null || fail "npm not found in PATH"

if [[ "$ACTION" == "uninstall" ]]; then
	log "uninstalling $SKILL_NAME"
	# Unlink before deleting dirs: npm leaves a dangling shim if the link target is already gone.
	unlink_bin
	for c in $(clients "$CLIENT"); do
		d="$(client_dir "$c")"
		remove_skill "$d"
	done
	# Keep `ppm` alive while any client still has the skill; repoint it there.
	if remaining="$(first_installed)"; then
		link_bin "$remaining"
		ok "ppm relinked to $remaining"
	else
		ok "ppm unlinked"
	fi
	ok "uninstall complete"
	exit 0
fi

log "installing $SKILL_NAME"
log "  source : $REPO_ROOT"
log "  client : $CLIENT"
log "  mode   : $MODE"

for c in $(clients "$CLIENT"); do
	d="$(client_dir "$c")"
	copy_tree "$d"
done

# Single global `ppm`: link once (source repo in link mode, first installed copy otherwise).
if [[ "$MODE" == "link" ]]; then
	link_bin "$REPO_ROOT"
	ok "ppm linked to $REPO_ROOT"
else
	pkg="$(first_installed)" || fail "no installed copy found to link"
	link_bin "$pkg"
	ok "ppm linked to $pkg"
fi

if command -v ppm >/dev/null 2>&1; then
	ok "ppm available at $(command -v ppm)"
	ok "install complete"
	exit 0
fi

NPM_GLOBAL_BIN="$(npm prefix -g 2>/dev/null)/bin"
warn "ppm is not on PATH"
echo "Add this to your shell profile (~/.bashrc, ~/.zshrc, etc.) and reload:"
echo "    export PATH=\"$NPM_GLOBAL_BIN:\$PATH\""
echo "Then verify: command -v ppm && ppm"
exit 1
