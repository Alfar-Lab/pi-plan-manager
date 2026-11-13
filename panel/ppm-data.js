/**
 * Browser data layer for the Pi Plan Manager pi-web panel.
 *
 * The panel is a static document served from this package, so it has no server
 * of its own. It reads `.ppm` files through pi-web's generic file API
 * (`/api/files/<path>?type=list|read`) and rebuilds the exact `/api/tasks`
 * payload that `ppm dashboard_serve` would return.
 *
 * Ported from:
 *   - bin/commands/setup/helper.js      (readDashboardData, readProjectData, readPlanData)
 *   - bin/commands/_shared/analysis.js  (waves, criticalPath, lintPhase, ...)
 *   - bin/commands/_shared/phase.js     (normalizeLegacy, validatePhase, listPhaseNames)
 *
 * Exposes `window.PpmData = { loadDashboard }`.
 */
(function () {
  "use strict";

  // ============== patterns ==============
  var PLAN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  var PHASE_PATTERN = /^phase_[A-Za-z0-9][A-Za-z0-9_-]*$/;
  var VALID_STATUSES = new Set(["todo", "in_progress", "completed", "fail"]);
  var VALID_AGENTS = new Set(["explore", "implement", "review", "verify"]);

  // ============== validate ==============
  function phaseNumber(name) {
    var match = /^phase_(\d+)$/.exec(name);
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
  }

  function normalizeDetails(task) {
    if (task.details && typeof task.details === "object" && !Array.isArray(task.details)) {
      if (typeof task.details.goal !== "string") task.details.goal = String(task.details.goal || "");
      if (typeof task.details.contract !== "string") task.details.contract = String(task.details.contract || "");
      if (!Array.isArray(task.details.steps)) {
        task.details.steps = typeof task.details.steps === "string" ? [task.details.steps] : [];
      } else {
        task.details.steps = task.details.steps.map(function(s) { return String(s || ""); });
      }
      if (FILES_LABEL.test(task.details.goal)) {
        var moved = parseLegacyDetail(task.details.goal);
        var join = function (a, b) { return [a, b].filter(Boolean).join("\n"); };
        task.details.goal = moved.goal;
        task.details.contract = join(moved.contract, task.details.contract);
        task.details.steps = moved.steps.concat(task.details.steps);
        task.details.verify = join(moved.verify, task.details.verify);
      }
      task.details.steps = splitSteps(task.details.steps);
      if (typeof task.details.verify !== "string") task.details.verify = String(task.details.verify || "");
      return;
    }
    task.details = parseLegacyDetail(typeof task.detail === "string" ? task.detail : "");
    delete task.detail;
  }

  // Mirror of parseLegacyDetail in bin/commands/_shared/phase.js (keep in sync).
  var DETAIL_LABEL = /^[ \t]*(Goal|Files|Contract|Steps|Verify|Done when)([ \t]*\([^)\n]*\))?[ \t]*:[ \t]*/gim;
  var FILES_LABEL = /^[ \t]*Files([ \t]*\([^)\n]*\))?[ \t]*:/im;
  function parseLegacyDetail(str) {
    var marks = Array.from(str.matchAll(DETAIL_LABEL));
    var sections = { goal: [str.slice(0, marks.length ? marks[0].index : str.length)], files: [], contract: [], steps: [], verify: [], "done when": [] };
    marks.forEach(function (mark, i) {
      var key = mark[1].toLowerCase();
      var body = str.slice(mark.index + mark[0].length, i + 1 < marks.length ? marks[i + 1].index : str.length).trim();
      var label = key === "files" ? "Scope" : mark[2] ? mark[1] : "";
      if (body) sections[key].push(label ? label + (mark[2] ? " " + mark[2].trim() : "") + ": " + body : body);
    });
    function text(key) { return sections[key].map(function (s) { return s.trim(); }).filter(Boolean).join("\n"); }
    var doneWhen = text("done when");
    return {
      goal: text("goal"),
      contract: [text("files"), text("contract")].filter(Boolean).join("\n"),
      steps: splitSteps(text("steps").split("\n").map(function (s) { return s.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim(); }).filter(Boolean)),
      verify: [text("verify"), doneWhen && "Done when: " + doneWhen].filter(Boolean).join("\n")
    };
  }

  // Mirror of splitSteps in bin/commands/_shared/phase.js (keep in sync).
  function splitSteps(steps) {
    if (steps.length !== 1) return steps;
    var parts = [], current = "", tick = false, depth = 0;
    for (var i = 0; i < steps[0].length; i += 1) {
      var ch = steps[0][i];
      if (ch === "`") tick = !tick;
      else if (!tick && "([{".indexOf(ch) >= 0) depth += 1;
      else if (!tick && ")]}".indexOf(ch) >= 0 && depth) depth -= 1;
      if (ch === ";" && !tick && !depth) { parts.push(current); current = ""; continue; }
      current += ch;
    }
    parts.push(current);
    var out = parts.map(function (part) { return part.trim(); }).filter(Boolean);
    return out.length > 1 ? out : steps;
  }

  var TIMESTAMP_REGEX = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]\s?/;

  function normalizeProgress(task) {
    if (Array.isArray(task.progress)) {
      task.progress = task.progress.map(function(item) {
        if (item && typeof item === "object") return { time: String(item.time || ""), detail: String(item.detail || "") };
        return { time: "", detail: String(item || "") };
      });
      return;
    }
    if (typeof task.progress === "string" && task.progress.trim()) {
      var entries = [];
      task.progress.split("\n").forEach(function(line) {
        var match = line.match(TIMESTAMP_REGEX);
        if (match) entries.push({ time: match[1], detail: line.slice(match[0].length) });
        else if (entries.length) entries[entries.length - 1].detail += "\n" + line;
        else entries.push({ time: "", detail: line });
      });
      task.progress = entries;
      return;
    }
    task.progress = [];
  }

  // fail_desc is folded into progress (not dropped) so no failure context is lost.
  function normalizeLegacy(phase) {
    var tasks = phase && phase.tasks;
    if (!Array.isArray(tasks)) return;
    tasks.forEach(function (item) {
      if (!item || typeof item !== "object") return;
      if (item.status === "start") item.status = "todo";
      if ("fail_desc" in item) {
        var legacy = typeof item.fail_desc === "string" ? item.fail_desc.trim() : "";
        if (legacy) {
          if (!Array.isArray(item.progress)) normalizeProgress(item);
          item.progress.push({ time: "", detail: "[legacy fail_desc] " + legacy });
        }
        delete item.fail_desc;
      }
      normalizeDetails(item);
      normalizeProgress(item);
    });
  }

  function validatePreRequest(task, index, ids) {
    if (!("pre_request" in task)) return;
    var label = "tasks[" + index + "].pre_request";
    if (!Array.isArray(task.pre_request)) throw new Error(label + " must be an array of task ids");
    var seen = new Set();
    task.pre_request.forEach(function (dep) {
      if (typeof dep !== "string" || !dep.trim()) throw new Error(label + " entries must be non-empty strings");
      if (dep === task.id) throw new Error(label + " cannot reference the task itself: " + dep);
      if (!ids.has(dep)) throw new Error(label + " references unknown task id in same phase: " + dep);
      if (seen.has(dep)) throw new Error(label + " contains duplicate entry: " + dep);
      seen.add(dep);
    });
  }

  function detectCycles(tasks) {
    var deps = new Map();
    tasks.forEach(function (task) {
      deps.set(task.id, Array.isArray(task.pre_request) ? task.pre_request : []);
    });
    var WHITE = 0, GRAY = 1, BLACK = 2;
    var color = new Map();
    var stack = [];
    function visit(id) {
      if (color.get(id) === GRAY) {
        var cycle = stack.slice(stack.indexOf(id)).concat(id).join(" -> ");
        throw new Error("pre_request cycle detected: " + cycle);
      }
      if (color.get(id) === BLACK) return;
      color.set(id, GRAY);
      stack.push(id);
      (deps.get(id) || []).forEach(visit);
      stack.pop();
      color.set(id, BLACK);
    }
    deps.forEach(function (_v, id) { color.set(id, WHITE); });
    deps.forEach(function (_v, id) { if (color.get(id) === WHITE) visit(id); });
  }

  function isAbsoluteRepoPath(entry) {
    return entry.charAt(0) === "/" || entry.charAt(0) === "\\" || /^[A-Za-z]:/.test(entry);
  }

  function validateFiles(task, index) {
    if (!("files" in task)) return;
    var label = "tasks[" + index + "].files";
    if (!Array.isArray(task.files)) throw new Error(label + " must be an array of repo-relative paths or globs");
    var seen = new Set();
    task.files.forEach(function (entry) {
      if (typeof entry !== "string" || !entry.trim()) throw new Error(label + " entries must be non-empty strings");
      if (isAbsoluteRepoPath(entry)) throw new Error(label + " must be repo-relative: " + entry);
      if (entry.split(/[\\/]/).indexOf("..") !== -1) throw new Error(label + ' must not contain "..": ' + entry);
      if (seen.has(entry)) throw new Error(label + " contains duplicate entry: " + entry);
      seen.add(entry);
    });
  }

  function validateAgent(task, index) {
    if (!("agent" in task)) return;
    if (!VALID_AGENTS.has(task.agent)) {
      throw new Error("tasks[" + index + "].agent must be one of " + Array.from(VALID_AGENTS).join("|") + ": " + task.agent);
    }
  }

  function validatePhase(phase, expectedPhase) {
    if (!phase || typeof phase !== "object" || Array.isArray(phase)) throw new Error("phase file root must be an object");
    if (phase.phase !== expectedPhase) throw new Error("phase field must equal " + expectedPhase);
    if (!Array.isArray(phase.tasks)) throw new Error("tasks must be an array");
    var tasks = phase.tasks;
    var ids = new Set();
    tasks.forEach(function (item, index) {
      var label = "tasks[" + index + "]";
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(label + " must be an object");
      ["id", "title", "status"].forEach(function (field) {
        if (typeof item[field] !== "string" || !item[field].trim()) throw new Error(label + "." + field + " must be a non-empty string");
      });
      if (ids.has(item.id)) throw new Error("duplicate task id: " + item.id);
      ids.add(item.id);
      if (!VALID_STATUSES.has(item.status)) throw new Error(label + ".status is invalid: " + item.status);
      if (!item.details || typeof item.details !== "object" || Array.isArray(item.details)) throw new Error(label + ".details must be an object");
      if (typeof item.details.goal !== "string") throw new Error(label + ".details.goal must be a string");
      if (!Array.isArray(item.details.steps)) throw new Error(label + ".details.steps must be an array");
      if (!Array.isArray(item.progress)) throw new Error(label + ".progress must be an array");
      item.progress.forEach(function (p) {
        if (!p || typeof p !== "object" || typeof p.detail !== "string") throw new Error(label + ".progress entries must be objects with detail string");
      });
      validateFiles(item, index);
      validateAgent(item, index);
    });
    tasks.forEach(function (item, index) { validatePreRequest(item, index, ids); });
    detectCycles(tasks);
  }

  // ============== analysis ==============
  function depsOf(task) {
    return Array.isArray(task.pre_request) ? task.pre_request : [];
  }

  function levels(phase) {
    var byId = new Map(phase.tasks.map(function (task) { return [task.id, task]; }));
    var memo = new Map();
    function level(id) {
      if (!memo.has(id)) {
        memo.set(id, depsOf(byId.get(id)).reduce(function (max, dep) { return Math.max(max, level(dep) + 1); }, 0));
      }
      return memo.get(id);
    }
    phase.tasks.forEach(function (task) { level(task.id); });
    return memo;
  }

  function waves(phase) {
    var level = levels(phase);
    var result = [];
    phase.tasks.forEach(function (task) {
      var index = level.get(task.id);
      if (!result[index]) result[index] = [];
      result[index].push(task);
    });
    return result;
  }

  function criticalPath(phase) {
    if (!phase.tasks.length) return [];
    var level = levels(phase);
    var byId = new Map(phase.tasks.map(function (task) { return [task.id, task]; }));
    var current = phase.tasks.reduce(function (best, task) { return level.get(task.id) > level.get(best.id) ? task : best; });
    var chain = [current.id];
    while (depsOf(current).length) {
      var nextId = depsOf(current).reduce(function (best, dep) { return level.get(dep) > level.get(best) ? dep : best; });
      current = byId.get(nextId);
      chain.unshift(current.id);
    }
    return chain;
  }

  function ancestors(phase) {
    var byId = new Map(phase.tasks.map(function (task) { return [task.id, task]; }));
    var memo = new Map();
    function walk(id) {
      if (memo.has(id)) return memo.get(id);
      var set = new Set();
      depsOf(byId.get(id)).forEach(function (dep) {
        set.add(dep);
        walk(dep).forEach(function (up) { set.add(up); });
      });
      memo.set(id, set);
      return set;
    }
    phase.tasks.forEach(function (task) { walk(task.id); });
    return memo;
  }

  function concurrentPairs(phase) {
    var up = ancestors(phase);
    var pairs = [];
    for (var i = 0; i < phase.tasks.length; i += 1) {
      for (var j = i + 1; j < phase.tasks.length; j += 1) {
        var a = phase.tasks[i], b = phase.tasks[j];
        if (!up.get(a.id).has(b.id) && !up.get(b.id).has(a.id)) pairs.push([a, b]);
      }
    }
    return pairs;
  }

  function normalizePattern(pattern) {
    var clean = pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    return clean.endsWith("/") ? clean + "**" : clean;
  }

  function globToRegex(pattern) {
    var source = "";
    for (var i = 0; i < pattern.length; i += 1) {
      var char = pattern[i];
      if (char === "*" && pattern[i + 1] === "*") {
        source += ".*";
        i += 1;
        if (pattern[i + 1] === "/") i += 1;
      } else if (char === "*") source += "[^/]*";
      else if (char === "?") source += "[^/]";
      else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp("^" + source + "$");
  }

  function staticPrefix(pattern) {
    return pattern.split(/[*?]/)[0];
  }

  function within(path, root) {
    return path === root || path.indexOf(root.replace(/\/\*\*$/, "") + "/") === 0;
  }

  function patternsOverlap(a, b) {
    var x = normalizePattern(a), y = normalizePattern(b);
    if (x === y) return true;
    var xGlob = /[*?]/.test(x), yGlob = /[*?]/.test(y);
    if (!xGlob && !yGlob) return within(x, y) || within(y, x);
    if (!xGlob) return globToRegex(y).test(x) || staticPrefix(y).indexOf(x + "/") === 0;
    if (!yGlob) return globToRegex(x).test(y) || staticPrefix(x).indexOf(y + "/") === 0;
    var px = staticPrefix(x), py = staticPrefix(y);
    return px.indexOf(py) === 0 || py.indexOf(px) === 0;
  }

  function fileConflicts(phase) {
    var conflicts = [];
    concurrentPairs(phase).forEach(function (pair) {
      var a = pair[0], b = pair[1];
      if (!Array.isArray(a.files) || !Array.isArray(b.files)) return;
      var shared = [];
      a.files.forEach(function (fa) {
        b.files.forEach(function (fb) {
          if (patternsOverlap(fa, fb)) shared.push(fa === fb ? fa : fa + " ~ " + fb);
        });
      });
      if (shared.length) conflicts.push({ a: a.id, b: b.id, shared: shared });
    });
    return conflicts;
  }

  // Mirror of FILES_IN_DETAILS in bin/commands/_shared/analysis.js.
  var FILES_IN_DETAILS = /^[ \t]*Files[ \t]*:/im;

  function lintPhase(phase) {
    var errors = [];
    var warnings = [];
    var tasks = phase.tasks;
    fileConflicts(phase).forEach(function (conflict) {
      errors.push(conflict.a + " and " + conflict.b + " can run concurrently but share files: " + conflict.shared.join(", ") + " (add pre_request or move shared files to one task)");
    });
    if (!tasks.length) return { errors: ["phase has no tasks (add tasks or delete the phase file)"], warnings: warnings };

    var phaseWaves = waves(phase);
    var width = Math.max.apply(null, phaseWaves.map(function (wave) { return wave.length; }));
    if (tasks.length >= 2 && width === 1) {
      warnings.push("fully serial (" + tasks.length + " tasks, width 1): drop unneeded pre_request, merge tasks, or split independent work");
    }

    var concurrent = concurrentPairs(phase);
    if (concurrent.length) {
      var racing = new Set();
      concurrent.forEach(function (pair) { racing.add(pair[0].id); racing.add(pair[1].id); });
      var unowned = tasks.filter(function (task) {
        return racing.has(task.id) && !(Array.isArray(task.files) && task.files.length);
      }).map(function (task) { return task.id; });
      if (unowned.length) warnings.push("parallel tasks without files ownership (conflicts cannot be checked): " + unowned.join(", "));
      var up = ancestors(phase);
      var sink = tasks.some(function (task) { return up.get(task.id).size === tasks.length - 1; });
      if (!sink) warnings.push("parallel work has no closing integration/verify task (one task whose pre_request covers all others)");
    }

    tasks.forEach(function (task) {
      var d = task.details || {};
      var missing = [];
      if (!d.goal || !String(d.goal).trim()) missing.push("goal");
      if (!Array.isArray(d.steps) || !d.steps.length) missing.push("steps");
      if (!d.verify || !String(d.verify).trim()) missing.push("verify");
      if (missing.length) warnings.push(task.id + ": details missing context-packet fields: " + missing.join(", "));
      if (FILES_IN_DETAILS.test([d.goal, d.contract].concat(d.steps || [], [d.verify]).join("\n"))) warnings.push(task.id + ': details contains a "Files:" section; list owned paths only in the files array');
      if (!task.agent) warnings.push(task.id + ": no agent role hint (explore|implement|review|verify)");
    });
    return { errors: errors, warnings: warnings };
  }

  // ============== pi-web file access ==============
  // Mirrors lib/file-paths.ts#encodeFilePathForApi so absolute paths survive the
  // /api/files/[...path] route (a raw "//" prefix is stripped by URL routing).
  function encodePath(filePath) {
    var normalized = String(filePath).replace(/\\/g, "/");
    var segments = normalized.split("/").filter(Boolean);
    if (normalized.indexOf("//") === 0 && segments.length) segments[0] = "//" + segments[0];
    return segments.map(encodeURIComponent).join("/");
  }

  function httpError(what, status) {
    var error = new Error(what + " (HTTP " + status + ")");
    error.status = status;
    return error;
  }

  async function listDir(dir) {
    var response = await fetch("/api/files/" + encodePath(dir) + "?type=list", { cache: "no-store" });
    if (!response.ok) throw httpError("Cannot list " + dir, response.status);
    var data = await response.json();
    return Array.isArray(data.entries) ? data.entries : [];
  }

  async function readTextFile(file) {
    var offset = 0;
    var out = "";
    // The API returns at most TEXT_PREVIEW_MAX_BYTES per call; plan files fit in
    // one, but loop so a large plan.md still reads fully.
    for (var i = 0; i < 64; i += 1) {
      var response = await fetch("/api/files/" + encodePath(file) + "?type=read&offset=" + offset, { cache: "no-store" });
      if (!response.ok) throw httpError("Cannot read " + file, response.status);
      var data = await response.json();
      out += data && typeof data.content === "string" ? data.content : "";
      if (!data || !data.truncated) return out;
      if (typeof data.nextOffset !== "number" || data.nextOffset <= offset) return out;
      offset = data.nextOffset;
    }
    return out;
  }

  // ============== reader ==============
  function parentOf(dir) {
    var normalized = String(dir).replace(/\/+$/, "");
    var index = normalized.lastIndexOf("/");
    if (index < 0) return normalized;
    if (index === 0) return "/";
    if (index === 2 && /^[A-Za-z]:/.test(normalized)) return normalized.slice(0, 3);
    return normalized.slice(0, index);
  }

  function basename(dir) {
    var normalized = String(dir).replace(/\/+$/, "");
    return normalized.split("/").pop() || normalized;
  }

  // Nearest ancestor of cwd whose `.ppm` directory exists and is readable
  // through pi-web's allowed roots.
  async function findWorkspaceProject(cwd) {
    var dir = String(cwd).replace(/\/+$/, "");
    for (var steps = 0; steps < 64 && dir; steps += 1) {
      var entries;
      try {
        entries = await listDir(dir);
      } catch (_error) {
        // Unreadable or outside the allowed roots: stop walking up.
        break;
      }
      if (entries.some(function (entry) { return entry.name === ".ppm" && entry.isDir; })) return dir;
      var parent = parentOf(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  }

  function planMetadata(content) {
    function read(label) {
      var match = new RegExp("^\\s*" + label + "\\s*:\\s*(.*?)\\s*$", "im").exec(content);
      return match && match[1] ? match[1].trim() : null;
    }
    return { createdAt: read("Created"), lastUpdated: read("Last updated") };
  }

  async function listPhaseNames(planRoot) {
    var entries;
    try {
      entries = await listDir(planRoot + "/tasks");
    } catch (error) {
      if (error.status === 404) return [];
      throw error;
    }
    return entries
      .filter(function (entry) { return !entry.isDir && entry.name.endsWith(".json") && PHASE_PATTERN.test(entry.name.slice(0, -5)); })
      .map(function (entry) { return entry.name.slice(0, -5); })
      .sort(function (a, b) { return phaseNumber(a) - phaseNumber(b) || a.localeCompare(b); });
  }

  async function readPhase(file, expectedPhase) {
    var content = await readTextFile(file);
    var phase;
    try {
      phase = JSON.parse(content);
    } catch (error) {
      throw new Error("invalid JSON in " + file + ": " + (error && error.message ? error.message : String(error)));
    }
    var before = Array.isArray(phase && phase.tasks) ? phase.tasks.map(function (task) { return JSON.stringify(task); }) : [];
    normalizeLegacy(phase);
    validatePhase(phase, expectedPhase);
    // legacyTasks = tasks `ppm migrate_format` would rewrite; drives the "Reformat Plan" button.
    return { phase: phase, legacyTasks: phase.tasks.filter(function (task, i) { return JSON.stringify(task) !== before[i]; }).length };
  }

  async function readPlanData(plansRoot, name) {
    var planRoot = plansRoot + "/" + name;
    var errors = [];
    var meta = "";
    // Modal shows plan.md then each topic file (mirrors bin/commands/setup/helper.js); metadata comes from plan.md only.
    var docs = ["plan.md", "plan.objective.md", "plan.constraint_invariant.md", "plan.approach.md", "plan.risk.md"];
    var parts = await Promise.all(docs.map(async function (file) {
      try {
        var text = await readTextFile(planRoot + "/" + file);
        if (file === "plan.md") meta = text;
        return file === "plan.md" ? text.trimEnd() : "\n---\n<!-- " + file + " -->\n\n" + text.trimEnd();
      } catch (error) {
        if (error.status !== 404) errors.push(file + ": " + error.message);
        return null;
      }
    }));
    parts = parts.filter(function (part) { return part !== null; });
    var content = parts.length ? parts.join("\n") + "\n" : "";

    var phases = [];
    var legacyTasks = 0;
    try {
      var names = await listPhaseNames(planRoot);
      var built = await Promise.all(names.map(async function (phaseName) {
        try {
          var read = await readPhase(planRoot + "/tasks/" + phaseName + ".json", phaseName);
          var phase = read.phase;
          legacyTasks += read.legacyTasks;
          var lint = lintPhase(phase);
          var wave = {};
          waves(phase).forEach(function (tasks, index) {
            tasks.forEach(function (task) { wave[task.id] = index + 1; });
          });
          return {
            name: phaseName,
            title: phase.title || phaseName,
            filePath: planRoot + "/tasks/" + phaseName + ".json",
            tasks: phase.tasks,
            errors: lint.errors,
            warnings: lint.warnings,
            wave: wave,
            criticalPath: criticalPath(phase),
          };
        } catch (error) {
          errors.push(phaseName + ": " + error.message);
          return null;
        }
      }));
      phases = built.filter(Boolean);
    } catch (error) {
      errors.push("tasks: " + error.message);
    }

    var metadata = planMetadata(meta);
    return { name: name, filePath: planRoot + "/plan.md", content: content, createdAt: metadata.createdAt, lastUpdated: metadata.lastUpdated, phases: phases, errors: errors, legacyTasks: legacyTasks };
  }

  async function readProjectData(root, name) {
    var plansRoot = root + "/.ppm";
    try {
      var entries = await listDir(plansRoot);
      var planNames = entries
        .filter(function (entry) { return entry.isDir && PLAN_PATTERN.test(entry.name); })
        .map(function (entry) { return entry.name; })
        .sort(function (a, b) { return a.localeCompare(b); });
      var plans = await Promise.all(planNames.map(function (planName) { return readPlanData(plansRoot, planName); }));
      return { id: root, name: name, path: root, plans: plans };
    } catch (error) {
      return { id: root, name: name, path: root, plans: [], error: error.message };
    }
  }

  // Workspace-only: the registered-project list lives in a config file outside
  // pi-web's allowed roots, so the panel shows the active workspace's `.ppm`.
  async function loadDashboard(cwd) {
    var root = await findWorkspaceProject(cwd);
    var projects = root ? [await readProjectData(root, basename(root))] : [];
    return { generatedAt: new Date().toISOString(), currentProjectId: root, projects: projects };
  }

  // Writes go through pi-web's upload API (atomic temp-file + rename on overwrite).
  async function uploadFile(dir, name, content, conflict) {
    var form = new FormData();
    form.append("files", new Blob([content], { type: "application/json" }), name);
    var response = await fetch("/api/files/" + encodePath(dir) + "?type=upload&conflict=" + conflict, { method: "POST", body: form });
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok || (data.errors && data.errors.length)) {
      throw new Error("Cannot write " + dir + "/" + name + ": " + (data.error || (data.errors && data.errors[0] && data.errors[0].error) || "HTTP " + response.status));
    }
  }

  // Browser port of `ppm migrate_format` (bin/commands/setup/format.js). pi-web has no mkdir API, so
  // each changed file is backed up beside itself as <phase>.json.bak-YYYYMMDD-HHMMSS (never overwritten).
  // ponytail: no cross-process lock here (pi-web has none); a task_* write racing this click can be lost.
  async function migrateFormat(projectPath, plan) {
    if (!PLAN_PATTERN.test(plan)) throw new Error("invalid plan name: " + plan);
    var tasksDir = projectPath + "/.ppm/" + plan + "/tasks";
    var names = await listPhaseNames(projectPath + "/.ppm/" + plan);
    // Parse + validate everything first so one broken file aborts before any write.
    var pending = (await Promise.all(names.map(async function (name) {
      var file = tasksDir + "/" + name + ".json";
      var raw = await readTextFile(file);
      var read = await readPhase(file, name);
      return { name: name, raw: raw, phase: read.phase, legacyTasks: read.legacyTasks };
    }))).filter(function (entry) { return entry.legacyTasks; });
    var stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    for (var i = 0; i < pending.length; i += 1) {
      var entry = pending[i];
      await uploadFile(tasksDir, entry.name + ".json.bak-" + stamp, entry.raw, "error");
      await uploadFile(tasksDir, entry.name + ".json", JSON.stringify(entry.phase, null, 2) + "\n", "overwrite");
    }
    return {
      plan: plan,
      phases: pending.map(function (entry) { return entry.name; }),
      tasks: pending.reduce(function (sum, entry) { return sum + entry.legacyTasks; }, 0),
      backup: pending.length ? tasksDir + "/<phase>.json.bak-" + stamp : null
    };
  }

  window.PpmData = { loadDashboard: loadDashboard, migrateFormat: migrateFormat, encodePath: encodePath };
})();
