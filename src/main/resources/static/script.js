/*
 * PrintFlow dashboard.
 * Every button calls the Spring Boot REST API with fetch(), then refresh()
 * reloads /api/state and /api/structures and redraws the whole page.
 * All scheduling logic lives on the server; this file only displays it.
 */

const $ = (id) => document.getElementById(id);

let state = null;        // GET /api/state
let structures = null;   // GET /api/structures
let searchedId = null;   // job currently shown in the search panel

// ---------- API helper ----------

async function api(method, path, body) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, options);
  } catch {
    throw new Error("Cannot reach the PrintFlow server. Is it running?");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status}).`);
  }
  return data;
}

/** Run an action, show its message (or error), then redraw everything. */
async function run(action) {
  try {
    const data = await action();
    if (data && data.message) {
      let msg = data.message;
      if (data.skipped && data.skipped.length) {
        msg += ` Lazy deletion skipped cancelled job ${data.skipped.join(", ")}.`;
      }
      toast(msg, "ok");
    }
  } catch (err) {
    toast(err.message, "err");
  }
  await refresh();
}

async function refresh() {
  try {
    [state, structures] = await Promise.all([api("GET", "/api/state"), api("GET", "/api/structures")]);
  } catch (err) {
    toast(err.message, "err");
    return;
  }
  render();
  if (searchedId) {
    showJob(searchedId, { quiet: true });
  }
}

// ---------- Helpers ----------

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

let toastTimer = null;
function toast(message, kind) {
  const el = $("toast");
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 6000);
}

function flash(el) {
  el.classList.remove("flash");
  void el.offsetWidth;            // restart the animation
  el.classList.add("flash");
}

/** Clickable job chip used in the heap and queue views. */
function jobNode(job) {
  const cancelled = job.status === "CANCELLED";
  const tag = cancelled ? "CANCELLED" : job.priority;
  return `
    <button type="button" class="job-node ${job.priority} ${cancelled ? "cancelled" : ""}"
            data-id="${esc(job.jobId)}"
            title="${esc(job.jobId)} · ${esc(job.document)} · ${esc(job.user)} · key (${job.key.join(", ")})">
      <span class="id">${esc(job.jobId)}</span>
      <span class="doc">${esc(job.document)}</span>
      <span class="tag">${tag}</span>
    </button>`;
}

// ---------- Rendering ----------

function render() {
  renderStats();
  renderPrinter();
  renderHeap();
  renderQueue();
  renderHistory();
  renderHashMap();
  renderComplexities();
}

function renderStats() {
  const s = state.stats;
  const items = [
    ["Total jobs", s.totalJobs],
    ["Waiting", s.waiting],
    ["Printing", s.printing],
    ["Completed", s.completed],
    ["Cancelled", s.cancelled],
    ["Pages printed", s.pagesPrinted],
  ];
  $("stats").innerHTML = items.map(([label, value]) => `
    <div class="stat"><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div>`).join("");
}

function renderPrinter() {
  const job = state.currentJob;
  const status = $("printer-status");
  status.textContent = job ? "PRINTING" : "IDLE";
  status.className = `pill ${job ? "printing" : "idle"}`;

  $("printer-body").innerHTML = job
    ? `<div class="printer-job">
         <div class="job-id">${esc(job.jobId)}</div>
         <div class="doc">${esc(job.document)}</div>
         <dl class="meta">
           <dt>Submitted by</dt><dd>${esc(job.user)}</dd>
           <dt>Priority</dt><dd><span class="badge ${job.priority.toLowerCase()}">${job.priority}</span></dd>
           <dt>Pages</dt><dd>${job.pages}</dd>
           <dt>Started at turn</dt><dd>${job.startedTurn}</dd>
         </dl>
         <div class="printer-bar"></div>
       </div>`
    : `<div class="printer-empty">Printer is idle.<br>
         <span class="small">${state.stats.waiting ? "Press “Start next job”." : "Submit a job to begin."}</span></div>`;

  $("btn-start").disabled = Boolean(job) || state.stats.waiting === 0;
  $("btn-complete").disabled = !job;
}

function renderHeap() {
  const jobs = state.priorityHeap;
  const tree = $("heap-tree");
  const array = $("heap-array");

  if (!jobs.length) {
    tree.innerHTML = `<div class="empty">Heap is empty — no urgent or high priority jobs waiting.</div>`;
    array.innerHTML = `<div class="empty">[ ]</div>`;
    return;
  }

  // Level k holds array indices 2^k − 1 … 2^(k+1) − 2.
  // Missing positions get empty slots so each node sits above its children.
  const levels = Math.floor(Math.log2(jobs.length)) + 1;
  let html = `<div class="heap-inner" style="min-width:${Math.pow(2, levels - 1) * 96}px">
                <svg class="heap-lines"></svg>`;
  for (let k = 0; k < levels; k++) {
    const start = Math.pow(2, k) - 1;
    html += `<div class="heap-level">`;
    for (let i = start; i < start + Math.pow(2, k); i++) {
      html += `<div class="heap-slot" data-index="${i}">`;
      if (i < jobs.length) {
        html += `<div class="heap-node-wrap" style="width:100%;text-align:center">
                   <div class="heap-node-index">[${i}]</div>${jobNode(jobs[i])}</div>`;
      }
      html += `</div>`;
    }
    html += `</div>`;
  }
  html += `</div>`;
  tree.innerHTML = html;
  drawHeapLines();

  array.innerHTML = jobs.map((job, i) => `
    <div class="heap-cell ${job.status === "CANCELLED" ? "cancelled" : ""}" title="key (${job.key.join(", ")})">
      <span class="idx">[${i}]</span>${esc(job.jobId)}
    </div>`).join("");
}

/** Draw a line from every heap node (index i) to its parent ((i − 1) / 2). */
function drawHeapLines() {
  const inner = document.querySelector(".heap-inner");
  if (!inner) return;
  const svg = inner.querySelector(".heap-lines");
  const box = inner.getBoundingClientRect();
  svg.setAttribute("width", box.width);
  svg.setAttribute("height", box.height);

  const centre = (i, edge) => {
    const node = inner.querySelector(`.heap-slot[data-index="${i}"] .job-node`);
    const r = node.getBoundingClientRect();
    return { x: r.left - box.left + r.width / 2, y: (edge === "top" ? r.top : r.bottom) - box.top };
  };

  let lines = "";
  const count = inner.querySelectorAll(".job-node").length;
  for (let i = 1; i < count; i++) {
    const child = centre(i, "top");
    const parent = centre(Math.floor((i - 1) / 2), "bottom");
    lines += `<line x1="${parent.x}" y1="${parent.y}" x2="${child.x}" y2="${child.y}"/>`;
  }
  svg.innerHTML = lines;
}

function renderQueue() {
  const jobs = state.normalQueue;
  const view = $("queue-view");
  if (!jobs.length) {
    view.innerHTML = `<span class="queue-end">FRONT</span><span class="empty">Queue is empty</span><span class="queue-end">REAR</span>`;
    return;
  }
  // Each job is grouped with the arrow after it so a wrapped line never starts with a stray arrow.
  view.innerHTML = `<span class="queue-group"><span class="queue-end">FRONT</span><span class="queue-arrow">→</span></span>`
    + jobs.map((job, i) => `<span class="queue-group">${jobNode(job)}<span class="queue-arrow">${i < jobs.length - 1 ? "→" : "←"}</span>`
        + (i === jobs.length - 1 ? `<span class="queue-end">REAR</span>` : "") + `</span>`).join("");
}

function renderHistory() {
  const item = (job, detail) => `
    <li><span class="id">${esc(job.jobId)}</span>
        <span class="badge ${job.priority.toLowerCase()}">${job.priority}</span>
        <span class="doc">${esc(job.document)} · ${esc(job.user)} · ${detail}</span></li>`;
  $("completed-list").innerHTML = state.completed.length
    ? state.completed.map((j) => item(j, `${j.pages} page${j.pages === 1 ? "" : "s"}`)).join("")
    : `<li class="muted">None yet</li>`;
  $("cancelled-list").innerHTML = state.cancelled.length
    ? state.cancelled.map((j) => item(j, `cancelled at turn ${j.finishedTurn}`)).join("")
    : `<li class="muted">None yet</li>`;
}

function renderHashMap() {
  const map = structures.hashMap;
  const statusById = {};
  allJobs().forEach((job) => { statusById[job.jobId] = job.status; });

  $("hashmap-meta").textContent =
    `${map.size} entr${map.size === 1 ? "y" : "ies"} · ${map.capacity} buckets · load factor ${map.loadFactor.toFixed(2)}`
    + " (resizes above 0.75). Collisions are chained in the same bucket.";

  $("hashmap-view").innerHTML = map.buckets.length
    ? map.buckets.map((b) => `
        <div class="bucket">
          <span class="bucket-index">[${b.index}]</span>
          ${b.keys.map((key) => `<span class="bucket-entry ${statusById[key] || ""}" data-id="${esc(key)}"
                title="${esc(key)} → ${statusById[key] || ""}">${esc(key)}</span>`).join(`<span class="chain-arrow">→</span>`)}
        </div>`).join("")
    : `<div class="empty">Empty — submit a job to add an entry.</div>`;
}

function renderComplexities() {
  $("complexity-table").querySelector("tbody").innerHTML = structures.complexities.map((row) => `
    <tr><td>${esc(row.operation)}</td><td class="time">${esc(row.time)}</td><td class="muted">${esc(row.how)}</td></tr>`).join("");
}

/** Every job known to the dashboard, from each part of the state. */
function allJobs() {
  const jobs = [...state.priorityHeap, ...state.normalQueue, ...state.completed, ...state.cancelled];
  if (state.currentJob) jobs.push(state.currentJob);
  return jobs;
}

// ---------- Search & cancel ----------

async function showJob(rawId, { quiet = false } = {}) {
  const id = rawId.trim().toUpperCase();
  const box = $("search-result");
  if (!id) {
    toast("Enter a job ID to search.", "err");
    return;
  }
  let job;
  try {
    job = await api("GET", `/api/jobs/${encodeURIComponent(id)}`);
  } catch (err) {
    searchedId = null;
    box.innerHTML = `<div class="search-card"><strong>${esc(id)}</strong><p class="muted">${esc(err.message)}</p></div>`;
    if (!quiet) flash(box.firstElementChild);
    return;
  }
  searchedId = job.jobId;
  $("search-input").value = job.jobId;

  box.innerHTML = `
    <div class="search-card">
      <div><span class="job-id">${esc(job.jobId)}</span>
           <span class="badge status-${job.status}">${job.status}</span></div>
      <div class="doc"><strong>${esc(job.document)}</strong></div>
      <dl class="meta">
        <dt>User</dt><dd>${esc(job.user)}</dd>
        <dt>Priority</dt><dd><span class="badge ${job.priority.toLowerCase()}">${job.priority}</span></dd>
        <dt>Pages</dt><dd>${job.pages}</dd>
        <dt>Heap key</dt><dd><code>(${job.key.join(", ")})</code></dd>
      </dl>
      ${job.status === "WAITING" ? `<button id="btn-cancel" class="btn btn-danger" type="button">Cancel job</button>` : ""}
      ${lazyDeletionNote(job)}
    </div>`;
  if (!quiet) flash(box.firstElementChild);

  const cancelBtn = $("btn-cancel");
  if (cancelBtn) {
    cancelBtn.addEventListener("click", () => run(() => api("PUT", `/api/jobs/${encodeURIComponent(job.jobId)}/cancel`)));
  }
}

/** Explain where a cancelled job physically is: this is the lazy-deletion demo. */
function lazyDeletionNote(job) {
  if (job.status !== "CANCELLED") return "";
  const queuePos = state.normalQueue.findIndex((j) => j.jobId === job.jobId);
  const heapPos = state.priorityHeap.findIndex((j) => j.jobId === job.jobId);
  if (queuePos >= 0) {
    return `<p class="note">Still physically in the FIFO queue at position ${queuePos + 1}.
            The scheduler will skip it when it reaches the FRONT.</p>`;
  }
  if (heapPos >= 0) {
    return `<p class="note">Still physically in the heap at index [${heapPos}].
            The scheduler will discard it when it reaches the top.</p>`;
  }
  return `<p class="note">Already discarded by lazy deletion. Only the hash-map record remains.</p>`;
}

// ---------- Event wiring ----------

$("job-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.target;
  const body = Object.fromEntries(new FormData(form));
  run(async () => {
    const data = await api("POST", "/api/jobs", body);
    form.document.value = "";
    form.pages.value = 1;
    form.document.focus();
    return data;
  });
});

$("btn-start").addEventListener("click", () => run(() => api("POST", "/api/printer/start-next")));
$("btn-complete").addEventListener("click", () => run(() => api("POST", "/api/printer/complete")));

$("search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  showJob($("search-input").value);
});

// Clicking any job in the heap, queue or hash map opens it in the search panel.
document.addEventListener("click", (event) => {
  const target = event.target.closest("[data-id]");
  if (target) {
    showJob(target.dataset.id);
  }
});

$("btn-reset").addEventListener("click", () => {
  if (!confirm("Clear all jobs and start again?")) return;
  searchedId = null;
  $("search-input").value = "";
  $("search-result").innerHTML = `<p class="muted">Enter a job ID, or click any job below.</p>`;
  run(() => api("POST", "/api/reset"));
});

// The evaluation demo: three normal jobs, then one urgent job.
const DEMO_JOBS = [
  { user: "Shiv", document: "Lab_Record.pdf", pages: 15, priority: "NORMAL" },
  { user: "Asha", document: "Assignment.pdf", pages: 6, priority: "NORMAL" },
  { user: "Ravi", document: "Notes.pdf", pages: 3, priority: "NORMAL" },
  { user: "Admin", document: "Exam_Papers.pdf", pages: 4, priority: "URGENT" },
];

$("btn-sample").addEventListener("click", () => run(async () => {
  const ids = [];
  for (const job of DEMO_JOBS) {
    ids.push((await api("POST", "/api/jobs", job)).job.jobId);
  }
  return { message: `Loaded demo jobs ${ids.join(", ")}.` };
}));

window.addEventListener("resize", drawHeapLines);

refresh();
