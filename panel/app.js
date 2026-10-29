/**
 * Project Plan Manager — view layer, shared by the pi-web panel and the CLI
 * standalone dashboard (`ppm dashboard_serve`).
 *
 * This is the single source of truth for the dashboard UI. The two entry
 * points differ only in how they supply data and where action prompts go:
 *   - pi-web panel: `panel/index.html` loads `./ppm-data.js` (pi-web file API)
 *     and posts `pi-web:insert-prompt` / `pi-web:open-file` to the host.
 *   - CLI dashboard: `panel/index.html` via `ppm dashboard_serve`, which serves
 *     a thin `/ppm-data.js` shim over `/api/tasks` and falls back to clipboard
 *     copy + the on-page modal.
 * Set `window.PpmStandalone` and `window.PpmData` before loading this file.
 */
(function () {
  "use strict";

  var params = new URLSearchParams(location.search);
  var host = window.parent !== window;

  // ============== state ==============
  var state = { data: null, project: "", query: "", filter: "all", open: new Map(), waveTab: new Map(), cwd: params.get("cwd") || "" };

  // ============== host bridge ==============
  function sendHost(message) {
    if (host) window.parent.postMessage(message, "*");
  }
  // Execute/Audit go to the composer (pi-web) or the clipboard (standalone).
  function dispatchPrompt(button) {
    var prompt = button.dataset.prompt;
    if (!prompt) return;
    var label = button.textContent;
    if (host) {
      sendHost({ type: "pi-web:insert-prompt", text: prompt });
      button.textContent = "Inserted";
    } else {
      navigator.clipboard.writeText(prompt).then(function () {
        button.textContent = "Copied";
      }).catch(function () {
        window.prompt("Copy prompt:", prompt);
      });
    }
    setTimeout(function () { button.textContent = label; }, 1200);
  }

  // ============== design tokens ==============
  var TASK_BORDER = {
    completed: "border-l-emerald-500",
    in_progress: "border-l-sky-400",
    fail: "border-l-rose-500",
    todo: "border-l-amber-400",
  };
  var TASK_DOT = {
    completed: "bg-emerald-500",
    in_progress: "bg-sky-400",
    fail: "bg-rose-500",
    todo: "bg-amber-400",
  };
  var TASK_BASE = "border-l-2 bg-[#111720] hover:bg-[#141b26] rounded-r-lg px-2.5 sm:px-3.5 py-1 my-1.5 sm:my-2 transition-colors";
  var BADGE_BASE = "inline-flex items-center gap-1 text-[10px] leading-4 font-semibold tracking-wide px-1.5 rounded-full border font-mono whitespace-nowrap";
  var BADGE_VARIANT = {
    ready: "text-emerald-300 bg-emerald-950/60 border-emerald-800/70",
    blocked: "text-amber-300 bg-amber-950/60 border-amber-800/70",
    stuck: "text-rose-300 bg-rose-950/60 border-rose-800/70",
    parallel: "text-sky-300 bg-sky-950/60 border-sky-800/70",
    waiting: "text-[#8996a8] bg-[#161d27] border-[#2d3747]",
    current: "text-teal-300 bg-teal-950/60 border-teal-800/70",
    agent: "text-violet-300 bg-violet-950/50 border-violet-800/60",
  };
  var COMPLETION_VARIANT = {
    zero: { text: "text-[#8996a8]", bar: "bg-[#39424f]" },
    partial: { text: "text-amber-300", bar: "bg-amber-400" },
    complete: { text: "text-emerald-300", bar: "bg-emerald-500" },
  };
  var TITLE_VARIANT = {
    zero: "text-[#c3ccd9]",
    partial: "text-amber-100",
    complete: "text-emerald-100",
  };
  var MUTED = "text-[#8996a8] text-[12px] sm:text-[13px]";
  var TAB_BASE = "font-mono text-[11px] px-2.5 py-1 -mb-px border-b-2 cursor-pointer transition-colors";
  var TAB_ACTIVE = "text-teal-300 border-teal-400";
  var TAB_IDLE = "text-[#8996a8] border-transparent hover:text-[#c3ccd9]";
  var META = "font-mono text-[10.5px] sm:text-[11px] text-[#6d7889]";
  var BUTTON = "text-[#c3ccd9] bg-[#161d27] border border-[#232b38] rounded-md px-2.5 sm:px-3 py-1.5 text-[11px] sm:text-xs font-medium cursor-pointer hover:border-teal-500/50 hover:text-teal-300 transition-colors";
  var BUTTON_PRIMARY = "text-[#0a0e14] bg-teal-400 border border-teal-400 rounded-md px-2.5 sm:px-3 py-1.5 text-[11px] sm:text-xs font-semibold cursor-pointer hover:bg-teal-300 transition-colors";
  var CHEVRON = '<svg class="chev w-3.5 h-3.5 mt-1 shrink-0 text-[#6d7889]" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // ============== helpers ==============
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function cls() {
    return Array.prototype.filter.call(arguments, Boolean).join(" ");
  }
  var list = function (value) { return Array.isArray(value) ? value : []; };
  function rememberAccordions() {
    document.querySelectorAll("#content details[data-key]").forEach(function (item) {
      state.open.set(item.dataset.key, item.open);
    });
  }
  function stats(phases) {
    var tasks = phases.flatMap(function (phase) { return phase.tasks; });
    var completed = tasks.filter(function (task) { return task.status === "completed"; }).length;
    return { completed: completed, total: tasks.length, percent: tasks.length ? Math.round(completed * 100 / tasks.length) : 0 };
  }
  function completionClass(value) {
    return value === 100 ? "complete" : value === 0 ? "zero" : "partial";
  }
  function titleClass(percent) {
    return TITLE_VARIANT[completionClass(percent)];
  }
  // Mirrors ppm plan_status: first phase that is not fully completed.
  function currentPhaseName(plan) {
    return (plan.phases.find(function (phase) {
      return phase.tasks.some(function (task) { return task.status !== "completed"; });
    }) || {}).name || null;
  }
  function byCompletion(a, b) {
    return a.percent - b.percent;
  }
  function isOpen(key, fallback) {
    return state.open.has(key) ? state.open.get(key) : fallback;
  }
  // Progress entries are appended as "[<ISO timestamp>] <text>" lines (ppm task_write_progress).
  var PROGRESS_ENTRY = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]\s?/;
  var PROGRESS_LEGACY = /^\[legacy fail_desc\]/;
  function progressEntries(text) {
    var entries = [];
    String(text || "").split("\n").forEach(function (line) {
      var match = line.match(PROGRESS_ENTRY);
      if (match) entries.push({ stamp: match[1], text: line.slice(match[0].length) });
      else if (PROGRESS_LEGACY.test(line)) entries.push({ stamp: "", text: line });
      else if (entries.length) entries[entries.length - 1].text += "\n" + line;
      else entries.push({ stamp: "", text: line });
    });
    return entries.filter(function (entry) { return entry.stamp || entry.text.trim(); });
  }

  // ============== primitive components ==============
  function Badge(variant, text, title) {
    var t = title ? ' title="' + esc(title) + '"' : "";
    return '<span class="' + cls(BADGE_BASE, BADGE_VARIANT[variant]) + '"' + t + ">" + esc(text) + "</span>";
  }
  function ProgressBar(percent, variant) {
    var v = COMPLETION_VARIANT[variant];
    return '<div class="h-1 w-full rounded-full bg-[#1c2431] overflow-hidden" role="progressbar" aria-valuenow="' + percent + '" aria-valuemin="0" aria-valuemax="100"><div class="' + cls("h-full rounded-full transition-[width]", v.bar) + '" style="width:' + percent + '%"></div></div>';
  }
  function CompletionBadge(statsValue) {
    var variant = completionClass(statsValue.percent);
    var v = COMPLETION_VARIANT[variant];
    return '<span class="flex items-center gap-2 shrink-0"><span class="' + cls("font-mono text-xs font-semibold tabular-nums", v.text) + '">' + statsValue.percent + '%</span><span class="' + MUTED + ' font-mono text-[11px]">' + statsValue.completed + "/" + statsValue.total + "</span></span>";
  }
  function Button(options) {
    var dataset = options.dataset || {};
    var className = options.className || BUTTON;
    var attrs = Object.entries(dataset).map(function (entry) {
      return " data-" + esc(entry[0]) + '="' + esc(entry[1]) + '"';
    }).join("");
    return '<button type="button" class="' + esc(className) + '"' + attrs + ">" + esc(options.label) + "</button>";
  }
  function Notice(kind, items) {
    if (!items.length) return "";
    var tone = kind === "error" ? "text-rose-300 border-rose-900/50 bg-rose-950/30" : "text-amber-200/90 border-amber-900/50 bg-amber-950/20";
    var label = kind === "error" ? "Errors (" + items.length + ")" : "Warnings (" + items.length + ")";
    return '<div class="' + cls("text-[11px] sm:text-[12px] font-mono border rounded-lg px-2.5 py-2 my-2 break-words", tone) + '"><div class="font-semibold mb-0.5">' + label + "</div>" + items.map(function (item) { return "<div>• " + esc(item) + "</div>"; }).join("") + "</div>";
  }

  // ============== task components ==============
  function TaskBadge(task, ctx) {
    if (task.status !== "todo") return "";
    if (ctx.phaseState === "waiting") return Badge("waiting", "waiting phase", "Starts after " + ctx.current + " is completed");
    var unmet = list(task.pre_request).filter(function (id) { return ctx.statusById.get(id) !== "completed"; });
    if (!unmet.length) {
      return list(task.pre_request).length
        ? Badge("ready", "ready", "All pre_request deps completed")
        : Badge("parallel", "parallel", "No pre_request dependencies");
    }
    var failed = unmet.filter(function (id) { return ctx.statusById.get(id) === "fail"; });
    if (failed.length) return Badge("stuck", "stuck: " + failed.join(", ") + " failed", "Blocked by failed task(s): " + failed.join(", ") + ". Reset or retry them.");
    return Badge("blocked", "waiting " + unmet.join(", "), "Waiting on pre_request: " + unmet.join(", "));
  }
  function TaskSummary(task, ctx) {
    var dot = '<span class="' + cls("inline-block w-1.5 h-1.5 rounded-full shrink-0", TASK_DOT[task.status]) + '"></span>';
    var agent = task.agent ? Badge("agent", task.agent, "Agent role hint") : "";
    return '<span class="flex items-center gap-2 min-w-0 w-full"><span class="font-mono text-[10.5px] sm:text-[11px] text-[#5b6577] shrink-0">' + esc(task.id) + '</span><span class="truncate text-[13px] sm:text-[13.5px] text-[#dde3ec]">' + esc(task.title) + '</span></span><span class="flex flex-wrap items-center gap-1.5 mt-1 sm:mt-0 sm:justify-end">' + dot + '<span class="' + cls(MUTED, "font-mono text-[11px]") + '">' + esc(task.status) + "</span>" + agent + TaskBadge(task, ctx) + "</span>";
  }
  function TaskBody(task) {
    var deps = list(task.pre_request);
    var files = list(task.files);
    var meta = [
      deps.length ? '<div class="' + META + '">pre_request: ' + deps.map(esc).join(", ") + "</div>" : "",
      task.agent ? '<div class="' + META + '">agent: ' + esc(task.agent) + "</div>" : "",
      files.length ? '<div class="' + META + ' break-all"><span>files:</span><ul class="mt-0.5 pl-3 list-disc marker:text-[#3d4757] space-y-0.5">' + files.map(function (file) { return "<li>" + esc(file) + "</li>"; }).join("") + "</ul></div>" : "",
    ].join("");
    var section = function (label, body) {
      return '<section class="mt-2"><div class="text-[#6d7889] text-[10.5px] font-semibold tracking-wide">' + label + '</div><div class="text-[12px] sm:text-[13px] text-[#b7c0cc] leading-snug mt-1 whitespace-pre-wrap break-words">' + esc(body) + "</div></section>";
    };
    var d = task.details || {};
    var detailText = [
      d.goal ? "Goal: " + d.goal : "",
      d.contract ? "Contract: " + d.contract : "",
      Array.isArray(d.steps) && d.steps.length ? "Steps:\n" + d.steps.map(function(s, i) { return (i + 1) + ". " + s; }).join("\n") : "",
      d.verify ? "Verify: " + d.verify : ""
    ].filter(Boolean).join("\n\n");
    return '<div class="task-body pt-2 pl-[1px]">' + meta + section("Detail", detailText) + ProgressSection(task.progress) + "</div>";
  }
  function ProgressSection(progress) {
    var entries = Array.isArray(progress) ? progress : [];
    if (!entries.length) return "";
    var items = entries.map(function (entry) {
      return '<li class="pl-0.5">' + (entry.time ? '<div class="' + META + ' break-all">[' + esc(entry.time) + "]</div>" : "") + '<div class="text-[12px] sm:text-[13px] text-[#b7c0cc] leading-snug whitespace-pre-wrap break-words">' + esc(entry.detail) + "</div></li>";
    }).join("");
    return '<section class="mt-2"><div class="text-[#6d7889] text-[10.5px] font-semibold tracking-wide">Progress</div><ul class="mt-1 list-disc pl-4 space-y-1.5 marker:text-[#3d4757]">' + items + "</ul></section>";
  }
  function TaskRow(options) {
    var task = options.task, ctx = options.ctx, key = options.key;
    var openAttr = isOpen(key, false) ? " open" : "";
    return '<details class="' + cls(TASK_BASE, TASK_BORDER[task.status]) + '" data-key="' + esc(key) + '"' + openAttr + '><summary class="cursor-pointer flex flex-col sm:flex-row sm:items-center justify-between gap-0.5 sm:gap-2 py-0.5">' + TaskSummary(task, ctx) + "</summary>" + TaskBody(task) + "</details>";
  }

  // ============== phase components ==============
  function PhaseExecPrompt(planName, phaseName) {
    return "Execute " + planName + " only Phase " + phaseName + " using Project-Plan-Manager skill. Phases are sequential; tasks with empty pre_request are parallel-eligible. Act as orchestrator: dispatch each ppm task_ready task to a sub agent matching its agent hint, verify, then mark status.";
  }
  function PhaseAuditPrompt(planName, phaseName) {
    return "Audit " + planName + " only Phase " + phaseName + " using Project-Plan-Manager skill. Report briefly";
  }
  function PhaseActions(plan, phase) {
    return '<div class="flex flex-wrap gap-2 items-center my-2">' + Button({ label: "Execute Phase", className: BUTTON_PRIMARY, dataset: { prompt: PhaseExecPrompt(plan.name, phase.name) } }) + Button({ label: "Audit Phase", dataset: { prompt: PhaseAuditPrompt(plan.name, phase.name) } }) + "</div>";
  }
  function matches(task, query) {
    var d = task.details || {};
    var stepText = Array.isArray(d.steps) ? d.steps.join(" ") : "";
    var progText = Array.isArray(task.progress) ? task.progress.map(function(p) { return p.detail; }).join(" ") : "";
    return [task.id, task.title, d.goal, d.contract, stepText, d.verify, progText, task.status, task.agent].concat(list(task.files))
      .some(function (value) { return String(value || "").toLowerCase().includes(query); });
  }
  function waveOf(ctx, task) {
    return ctx.wave[task.id] || 1;
  }
  // One tab per wave that has visible tasks; counts cover the whole wave, not just search matches.
  function WaveTabs(key, waveNums, active, phaseTasks, ctx) {
    return '<div role="tablist" class="flex flex-wrap gap-1 mt-2 border-b border-[#1c2431]">' + waveNums.map(function (n) {
      var waveTasks = phaseTasks.filter(function (task) { return waveOf(ctx, task) === n; });
      var done = waveTasks.filter(function (task) { return task.status === "completed"; }).length;
      var selected = n === active;
      var count = '<span class="' + (done === waveTasks.length ? "text-emerald-400" : "text-[#5b6577]") + '">' + done + "/" + waveTasks.length + "</span>";
      return '<button type="button" role="tab" aria-selected="' + selected + '" data-wave-tab="' + esc(key) + '" data-wave="' + n + '" title="Wave ' + n + ": " + done + "/" + waveTasks.length + ' completed" class="' + cls(TAB_BASE, selected ? TAB_ACTIVE : TAB_IDLE) + '">W' + n + " " + count + "</button>";
    }).join("") + "</div>";
  }
  function PhaseSection(options) {
    var plan = options.plan, phase = options.phase, query = options.query, projectId = options.projectId, current = options.current;
    var tasks = phase.tasks.filter(function (task) { return !query || matches(task, query); });
    if (query && !tasks.length) return "";
    var phaseStats = stats([phase]);
    var variant = completionClass(phaseStats.percent);
    var names = plan.phases.map(function (item) { return item.name; });
    var phaseState = phase.name === current ? "current" : (current && names.indexOf(phase.name) > names.indexOf(current) ? "waiting" : "done");
    var ctx = { statusById: new Map(phase.tasks.map(function (task) { return [task.id, task.status]; })), wave: phase.wave || {}, phaseState: phaseState, current: current };
    var key = projectId + "/" + plan.name + "/" + phase.name;
    var openAttr = (query || isOpen(key, phaseState === "current")) ? " open" : "";
    var errors = list(phase.errors), warnings = list(phase.warnings);
    var issueBadges = (errors.length ? Badge("stuck", errors.length + " error" + (errors.length === 1 ? "" : "s")) : "") + (warnings.length ? Badge("blocked", warnings.length + " warn") : "");
    var stateBadge = phaseState === "current" ? Badge("current", "current") : phaseState === "waiting" ? Badge("waiting", "waiting") : "";
    var waveCount = Math.max(0, Math.max.apply(null, Object.values(ctx.wave).concat([0])));
    var critical = list(phase.criticalPath);
    var schedule = phase.tasks.length ? '<div class="' + META + ' mt-1 break-words">' + waveCount + " wave" + (waveCount === 1 ? "" : "s") + " · critical path: " + (critical.map(esc).join(" → ") || "—") + "</div>" : "";
    var summary = '<summary class="cursor-pointer flex gap-2 items-start">' + CHEVRON + '<div class="min-w-0 mr-auto"><strong class="block text-[13px] sm:text-[14px] font-semibold ' + titleClass(phaseStats.percent) + ' truncate">' + esc(phase.title) + '</strong><div class="flex flex-wrap items-center gap-1.5 mt-0.5"><span class="' + META + '">' + esc(phase.name) + "</span>" + stateBadge + issueBadges + "</div></div>" + CompletionBadge(phaseStats) + "</summary>";
    var waveNums = tasks.map(function (task) { return waveOf(ctx, task); })
      .filter(function (n, i, all) { return all.indexOf(n) === i; })
      .sort(function (a, b) { return a - b; });
    // Default tab: first wave with unfinished work, else first wave.
    var active = state.waveTab.get(key);
    if (waveNums.indexOf(active) < 0) {
      active = waveNums.find(function (n) {
        return tasks.some(function (task) { return waveOf(ctx, task) === n && task.status !== "completed"; });
      }) || waveNums[0];
    }
    var shown = tasks.filter(function (task) { return waveOf(ctx, task) === active; });
    var taskList = shown.length
      ? WaveTabs(key, waveNums, active, phase.tasks, ctx) + '<div role="tabpanel">' + shown.map(function (task) { return TaskRow({ task: task, ctx: ctx, key: key + "/" + task.id }); }).join("") + "</div>"
      : '<span class="' + MUTED + '">No tasks</span>';
    var body = '<div class="pt-2">' + ProgressBar(phaseStats.percent, variant) + schedule + Notice("error", errors) + Notice("warning", warnings) + PhaseActions(plan, phase) + taskList + "</div>";
    return '<details data-key="' + esc(key) + '"' + openAttr + ' class="bg-[#0d1218] border border-[#1c2431] rounded-lg p-2.5 sm:p-3.5 min-w-0">' + summary + body + "</details>";
  }

  // ============== plan components ==============
  function PlanExecPrompt(planName) {
    return "Execute " + planName + " using Project-Plan-Manager skill";
  }
  function PlanAuditPrompt(planName) {
    return "Audit " + planName + " using Project-Plan-Manager skill";
  }
  function PlanActions(plan) {
    var armed = state.armed && state.armed.plan === plan.name && state.armed.until > Date.now();
    var reformat = plan.legacyTasks ? Button({ label: armed ? "Click again to rewrite " + plan.legacyTasks + " task(s)" : "Reformat Plan (" + plan.legacyTasks + ")", className: armed ? BUTTON_PRIMARY : BUTTON, dataset: { reformat: plan.name } }) : "";
    return '<div class="flex flex-wrap gap-2 items-center my-2.5 sm:my-3">' + Button({ label: "Execute Plan", className: BUTTON_PRIMARY, dataset: { prompt: PlanExecPrompt(plan.name) } }) + Button({ label: "Audit Plan", dataset: { prompt: PlanAuditPrompt(plan.name) } }) + reformat + Button({ label: "Open plan.md", dataset: { plan: plan.name, path: plan.filePath || "" } }) + "</div>";
  }
  function PlanHeading(plan, percent) {
    return '<span class="flex flex-col gap-0.5 min-w-0 mr-auto"><span class="text-[14px] sm:text-[15px] font-semibold ' + titleClass(percent) + ' truncate">' + esc(plan.name) + '</span><span class="text-[#6d7889] text-[10.5px] sm:text-[11.5px] font-normal font-mono">created ' + esc(plan.createdAt || "—") + " · updated " + esc(plan.lastUpdated || "—") + "</span></span>";
  }
  function Plan(options) {
    var plan = options.plan, planStats = options.planStats, projectId = options.projectId, query = options.query;
    var current = currentPhaseName(plan);
    var phaseSections = plan.phases
      .map(function (phase) { return PhaseSection({ plan: plan, phase: phase, query: query, projectId: projectId, current: current }); })
      .filter(Boolean);
    if (query && !phaseSections.length) return "";
    var variant = completionClass(planStats.percent);
    var planKey = projectId + "/" + plan.name;
    var openAttr = (query || isOpen(planKey, false)) ? " open" : "";
    var issues = list(plan.errors).length + plan.phases.reduce(function (sum, phase) { return sum + list(phase.errors).length; }, 0);
    var issueBadge = issues ? Badge("stuck", issues + " error" + (issues === 1 ? "" : "s"), "plan_validate would fail") : "";
    return '<details data-key="' + esc(planKey) + '"' + openAttr + ' class="bg-[#111720] border border-[#232b38] rounded-xl p-2"><summary class="cursor-pointer flex gap-2 sm:gap-3 items-start">' + CHEVRON + PlanHeading(plan, planStats.percent) + '<span class="flex flex-col items-end gap-1 sm:gap-1.5 shrink-0">' + CompletionBadge(planStats) + '<span class="flex items-center gap-1.5">' + issueBadge + '<span class="' + MUTED + ' text-[11px]">' + plan.phases.length + " phase" + (plan.phases.length === 1 ? "" : "s") + "</span></span></span></summary>" + '<div class="pl-0 sm:pl-[22px] pt-1"><div class="mb-1">' + ProgressBar(planStats.percent, variant) + "</div>" + Notice("error", list(plan.errors)) + PlanActions(plan) + '<div class="grid gap-2 sm:gap-3 grid-cols-1 md:grid-cols-[repeat(auto-fit,minmax(340px,1fr))] items-start">' + (phaseSections.join("") || '<span class="' + MUTED + '">No phases</span>') + "</div></div></details>";
  }

  // ============== render ==============
  function render() {
    if (!state.renderedQuery) rememberAccordions();
    state.renderedQuery = state.query.trim();
    var projects = (state.data && state.data.projects) || [];
    var select = document.querySelector("#project");
    var previous = state.project || select.value;
    select.innerHTML = projects.map(function (project) {
      return '<option value="' + esc(project.id) + '">' + esc(project.name) + " — " + esc(project.path) + "</option>";
    }).join("");
    state.project = projects.some(function (project) { return project.id === previous; }) ? previous : (projects[0] ? projects[0].id : "");
    select.value = state.project;
    var project = projects.find(function (item) { return item.id === state.project; });
    if (!project) {
      document.querySelector("#content").innerHTML = '<div class="text-[#8996a8] text-sm border border-dashed border-[#232b38] rounded-lg p-6 text-center">No <code class="font-mono text-teal-300 bg-[#161d27] px-1.5 py-0.5 rounded">.ppm</code> plan found in this workspace. Run <code class="font-mono text-teal-300 bg-[#161d27] px-1.5 py-0.5 rounded">ppm init</code>.</div>';
      return;
    }
    if (project.error) {
      document.querySelector("#content").innerHTML = '<p class="text-rose-300 text-sm border border-rose-900/50 bg-rose-950/30 rounded-lg p-3.5">' + esc(project.error) + "</p>";
      return;
    }
    var query = state.query.trim().toLowerCase();
    var plans = project.plans
      .map(function (plan) { return { plan: plan, planStats: stats(plan.phases) }; })
      .filter(function (entry) { return state.filter === "all" || completionClass(entry.planStats.percent) === state.filter; })
      .sort(function (a, b) { return byCompletion(a.planStats, b.planStats); })
      .map(function (entry) { return Plan({ plan: entry.plan, planStats: entry.planStats, projectId: project.id, query: query }); })
      .filter(Boolean)
      .join("");
    var notice = state.notice ? '<p class="' + (state.notice.kind === "error" ? "text-rose-300 border-rose-900/50 bg-rose-950/30" : "text-teal-200 border-teal-900/50 bg-teal-950/30") + ' text-xs sm:text-sm font-mono border rounded-lg p-2.5 break-words" role="status">' + esc(state.notice.text) + "</p>" : "";
    document.querySelector("#content").innerHTML = notice + (plans || '<div class="text-[#8996a8] text-sm border border-dashed border-[#232b38] rounded-lg p-6 text-center">No plans found.</div>');
  }

  var loading = false;
  async function load() {
    if (!state.cwd && !window.PpmStandalone) {
      document.querySelector("#content").innerHTML = '<div class="text-[#8996a8] text-sm border border-dashed border-[#232b38] rounded-lg p-6 text-center">Waiting for a workspace…</div>';
      return;
    }
    if (loading || document.hidden) return;
    loading = true;
    try {
      state.data = await window.PpmData.loadDashboard(state.cwd);
      render();
    } catch (error) {
      document.querySelector("#content").innerHTML = '<p class="text-rose-300 text-sm border border-rose-900/50 bg-rose-950/30 rounded-lg p-3.5">' + esc(error.message) + "</p>";
    } finally {
      loading = false;
    }
  }

  // Runs migrate_format in code (no LLM): standalone via POST /api/migrate_format, pi-web via its file API.
  // Two-click confirm on the button itself: sandboxed panel iframes may block window.confirm/alert.
  async function reformatPlan(button) {
    var plan = button.dataset.reformat;
    if (!(state.armed && state.armed.plan === plan && state.armed.until > Date.now())) {
      state.armed = { plan: plan, until: Date.now() + 5000 };
      render();
      setTimeout(render, 5100);
      return;
    }
    state.armed = null;
    button.disabled = true;
    button.textContent = "Reformatting…";
    try {
      var result = await window.PpmData.migrateFormat(state.project, plan);
      state.notice = { kind: "info", text: plan + ": migrated " + result.tasks + " task(s) in " + result.phases.length + " phase file(s)." + (result.backup ? " Backup: " + result.backup : "") };
    } catch (error) {
      state.notice = { kind: "error", text: plan + ": reformat failed: " + error.message };
    }
    await load();
  }

  // ============== host context ==============
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || typeof data !== "object" || data.type !== "pi-web:context") return;
    if (typeof data.cwd === "string" && data.cwd && data.cwd !== state.cwd) {
      state.cwd = data.cwd;
      load();
    }
  });
  if (host) sendHost({ type: "pi-web:ready" });

  // ============== event handlers ==============
  document.querySelector("#project").addEventListener("change", function (event) { state.project = event.target.value; render(); });
  document.querySelector("#plan-filter").addEventListener("change", function (event) { state.filter = event.target.value; render(); });
  document.querySelector("#search").addEventListener("input", function (event) { state.query = event.target.value; render(); });
  document.querySelector("#refresh").addEventListener("click", load);
  document.querySelector("#content").addEventListener("click", function (event) {
    var waveTab = event.target.closest("[data-wave-tab]");
    if (waveTab) { state.waveTab.set(waveTab.dataset.waveTab, Number(waveTab.dataset.wave)); render(); return; }
    var reformatButton = event.target.closest("[data-reformat]");
    if (reformatButton) { reformatPlan(reformatButton); return; }
    var promptButton = event.target.closest("[data-prompt]");
    if (promptButton) { dispatchPrompt(promptButton); return; }
    var openButton = event.target.closest("[data-plan]");
    if (!openButton) return;
    var project = state.data && state.data.projects.find(function (item) { return item.id === state.project; });
    var plan = project && project.plans.find(function (item) { return item.name === openButton.dataset.plan; });
    if (host) {
      sendHost({ type: "pi-web:open-file", path: openButton.dataset.path });
      return;
    }
    document.querySelector("#modal-title").textContent = (plan ? plan.name : "Plan") + " — plan.md";
    document.querySelector("#modal-content").textContent = (plan && plan.content) || "plan.md not found or empty.";
    document.querySelector("#plan-modal").showModal();
  });
  document.querySelector("#modal-close").addEventListener("click", function () { document.querySelector("#plan-modal").close(); });
  document.querySelector("#plan-modal").addEventListener("click", function (event) {
    if (event.target === event.currentTarget) event.currentTarget.close();
  });
  document.addEventListener("visibilitychange", function () { if (!document.hidden) load(); });

  load();
  setInterval(load, 3000);
})();
