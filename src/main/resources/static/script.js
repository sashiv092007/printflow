/*
 * PrintFlow dashboard.
 * Every button calls the Spring Boot REST API with fetch(), then refresh()
 * reloads /api/state and /api/structures and redraws the whole page.
 * All scheduling logic lives on the server; this file only displays it.
 *
 * Heap operations come back with a step trace (place, compare, swap, settle,
 * remove, move). The player below replays it on the heap tree and array.
 */

const $ = (id) => document.getElementById(id);

let state = null;        // GET /api/state
let structures = null;   // GET /api/structures
let searchedId = null;   // job currently shown in the search panel
let probe = null;        // last hash-map lookup, highlighted in the bucket view
let lastTrace = null;    // last heap trace, for Replay

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

/** Run an action, show its message (or error), then redraw, animating any heap steps. */
async function run(action) {
  if (activeBurst) activeBurst.fast = true;   // another action makes the rest of a burst instant
  await player.stop();
  const capacityBefore = structures ? structures.hashMap.capacity : null;
  let data = null;
  try {
    data = await action();
    if (data && data.message) {
      let msg = data.message;
      const capacity = data.state && data.state.hashMap.capacity;
      if (capacityBefore && capacity > capacityBefore) {
        msg += ` The hash map passed load factor 0.75 and resized from ${capacityBefore} to ${capacity} buckets.`;
      }
      if (data.promoted && data.promoted.length) {
        msg += ` Fairness aging promoted ${data.promoted.join(", ")} into the heap.`;
      }
      if (data.skipped && data.skipped.length) {
        msg += ` Lazy deletion skipped cancelled job ${data.skipped.join(", ")}.`;
      }
      toast(msg, "ok");
    }
  } catch (err) {
    toast(err.message, "err");
  }
  await refresh(data && data.heapTrace && data.heapTrace.length ? data.heapTrace : null);
}

async function refresh(trace = null, { boost = 1 } = {}) {
  const before = structures;
  try {
    [state, structures] = await Promise.all([api("GET", "/api/state"), api("GET", "/api/structures")]);
  } catch (err) {
    toast(err.message, "err");
    return;
  }
  const resized = before && structures.hashMap.capacity > before.hashMap.capacity;
  if (trace) {
    lastTrace = trace;
  }
  if (trace && $("pl-enabled").checked) {
    render({ skipHeap: true, skipPrinter: trace.some((s) => s.kind === "print"), resized });
    await player.play(trace, { boost });
    render();
  } else {
    render({ resized });
  }
  updatePlayerButtons();
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
  if (!el) return;
  el.classList.remove("flash");
  void el.offsetWidth;            // restart the animation
  el.classList.add("flash");
}

/** A heap key such as (3, −7). */
function keyText(key) {
  return `(${key[0]}, ${key[1] < 0 ? "−" + -key[1] : key[1]})`;
}

/** How many turns this waiting normal job has been passed over (for the aging meter). */
function waitedTurns(job) {
  return state.turn - job.submittedTurn;
}

/** Clickable job chip used in the heap and queue views. */
function jobNode(job, { extraClass = "", showAge = false, flip = "job" } = {}) {
  const cancelled = job.status === "CANCELLED";
  const tag = cancelled ? "CANCELLED" : job.aged ? "AGED → HIGH" : job.priority;
  let age = "";
  if (showAge && state.aging.enabled && job.status === "WAITING") {
    const limit = state.aging.turns;
    const waited = Math.min(waitedTurns(job), limit);
    age = `<span class="age" title="Passed over ${waited} of ${limit} times before promotion">
             <span class="age-bar"><span style="width:${(waited / limit) * 100}%"></span></span>
             ⏳ ${waited}/${limit}${waited >= limit ? " ⏫" : ""}</span>`;
  }
  return `
    <button type="button" class="job-node ${job.priority} ${job.aged ? "aged" : ""} ${cancelled ? "cancelled" : ""} ${extraClass}"
            data-id="${esc(job.jobId)}" data-flip="${flip}:${esc(job.jobId)}"
            title="${esc(job.jobId)} · ${esc(job.document)} · ${esc(job.user)} · key ${keyText(job.key)}">
      <span class="id">${esc(job.jobId)}</span>
      <span class="id-short">${esc(job.jobId.replace(/^PF-/, ""))}</span>
      <span class="doc">${esc(job.document)}</span>
      <span class="tag">${tag}</span>${age}
    </button>`;
}

// ---------- Rendering ----------

function render({ skipHeap = false, skipPrinter = false, resized = false } = {}) {
  const before = snapshotPositions();
  renderStats();
  if (!skipPrinter) renderPrinter();
  if (!skipHeap) renderHeap(state.priorityHeap);
  renderQueue();
  renderAging();
  renderHistory();
  renderHashMap(resized);
  renderComplexities();
  animateMoves(before);
}

// ---------- Motion: jobs travel between queue, heap, printer and history ----------

/**
 * Every element with data-flip="scope:ID" is one job in one place. Before a
 * redraw we record where each one is; after it, each job glides from its old
 * spot to its new one (FLIP: First, Last, Invert, Play). A job that changed
 * section (queue → printer, heap → printer, printer → history, queue → heap)
 * flies there as a floating copy, so scrolling boxes cannot clip it.
 */
function snapshotPositions() {
  const map = new Map();
  document.querySelectorAll("[data-flip]").forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width) map.set(el.dataset.flip, { rect: r, zone: zoneOf(el) });
  });
  return map;
}

function zoneOf(el) {
  const zone = el.closest("[data-zone]");
  return zone ? zone.dataset.zone : "";
}

function animateMoves(before) {
  if (!before || !motionOn()) return;
  let moved = false;
  document.querySelectorAll("[data-flip]").forEach((el) => {
    const now = el.getBoundingClientRect();
    if (!now.width) return;
    const old = before.get(el.dataset.flip);
    if (!old) {
      el.animate([{ opacity: 0, transform: "scale(.6)" }, { opacity: 1, transform: "none" }],
        { duration: 450, easing: "cubic-bezier(.2,.8,.3,1.2)" });
      return;
    }
    const dx = old.rect.left - now.left;
    const dy = old.rect.top - now.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    moved = true;
    const easing = "cubic-bezier(.45,0,.2,1)";
    if (old.zone === zoneOf(el)) {
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 750, easing });
      return;
    }
    // Changed section: a small job chip glides from the old place to the new one,
    // then the new element lights up. The chip never stretches, so text stays crisp.
    const id = el.dataset.flip.split(":")[1];
    const job = allJobs().find((j) => j.jobId === id);
    const chip = document.createElement("div");
    chip.className = `fly-chip ${job ? job.priority : ""}`;
    chip.textContent = id;
    document.body.appendChild(chip);
    const c = chip.getBoundingClientRect();
    const fromX = old.rect.left + old.rect.width / 2 - c.width / 2;
    const fromY = old.rect.top + old.rect.height / 2 - c.height / 2;
    const toX = now.left + now.width / 2 - c.width / 2;
    const toY = now.top + now.height / 2 - c.height / 2;
    const lift = Math.min(80, Math.abs(toY - fromY) / 3 + 30);
    el.style.visibility = "hidden";
    chip.animate([
      { transform: `translate(${fromX}px, ${fromY}px) scale(.9)`, opacity: 0 },
      { transform: `translate(${fromX}px, ${fromY}px) scale(1.05)`, opacity: 1, offset: 0.12 },
      { transform: `translate(${(fromX + toX) / 2}px, ${Math.min(fromY, toY) - lift}px) scale(1.12)`, offset: 0.55 },
      { transform: `translate(${toX}px, ${toY}px) scale(1)`, opacity: 1 },
    ], { duration: 950, easing }).finished.finally(() => {
      chip.remove();
      el.style.visibility = "";
      el.animate([{ boxShadow: "0 0 0 6px rgba(59, 91, 219, .35)" }, { boxShadow: "0 0 0 0 rgba(59, 91, 219, 0)" }], 700);
    });
  });
  const lines = document.querySelector(".heap-lines");
  if (moved && lines) lines.animate([{ opacity: 0 }, { opacity: 0 }, { opacity: 1 }], 900);
}

/** Movement follows the Animate switch. */
function motionOn() {
  return $("pl-enabled").checked;
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
  const box = $("stats");
  if (!box.children.length) {
    box.innerHTML = items.map(([label]) => `
      <div class="stat"><div class="stat-value">0</div><div class="stat-label">${label}</div></div>`).join("");
  }
  items.forEach(([, value], i) => countTo(box.children[i], value));
}

/** Roll a stat number to its new value and pulse the tile when it changes. */
function countTo(tile, target) {
  const el = tile.querySelector(".stat-value");
  const from = Number(el.dataset.value || 0);
  el.dataset.value = target;
  if (from === target) return;
  if (!motionOn()) { el.textContent = target; return; }
  tile.classList.remove("bump");
  void tile.offsetWidth;
  tile.classList.add("bump");
  const start = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - start) / 500);
    el.textContent = Math.round(from + (target - from) * (1 - Math.pow(1 - k, 3)));
    if (k < 1 && el.dataset.value == target) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderPrinter() {
  const job = state.currentJob;
  const status = $("printer-status");
  status.textContent = job ? "PRINTING" : "IDLE";
  status.className = `pill ${job ? "printing" : "idle"}`;

  $("printer-body").innerHTML = job
    ? `<div class="printer-job" data-flip="job:${esc(job.jobId)}">
         <div class="job-id">${esc(job.jobId)}</div>
         <div class="doc">${esc(job.document)}</div>
         <dl class="meta">
           <dt>Submitted by</dt><dd>${esc(job.user)}</dd>
           <dt>Priority</dt><dd><span class="badge ${job.priority.toLowerCase()}">${job.priority}</span>
             ${job.aged ? `<span class="badge aged">AGED</span>` : ""}</dd>
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

/**
 * Draw the heap as a tree and as its array. `jobs` is in array order;
 * a null entry is an empty slot (the hole left while extractMax runs).
 */
function renderHeap(jobs) {
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
  // Deeper trees get smaller nodes so the whole tree always fits its column.
  const density = levels <= 3 ? "d-full" : levels === 4 ? "d-compact" : levels === 5 ? "d-mini" : "d-dot";
  let html = `<div class="heap-inner ${density}">
                <svg class="heap-lines"></svg>`;
  for (let k = 0; k < levels; k++) {
    const start = Math.pow(2, k) - 1;
    html += `<div class="heap-level">`;
    for (let i = start; i < start + Math.pow(2, k); i++) {
      html += `<div class="heap-slot" data-index="${i}">`;
      if (i < jobs.length) {
        html += `<div class="heap-node-wrap">
                   <div class="heap-node-index">[${i}]</div>
                   ${jobs[i] ? jobNode(jobs[i], { extraClass: "heap-box" })
                             : `<div class="heap-box heap-hole">empty</div>`}
                 </div>`;
      }
      html += `</div>`;
    }
    html += `</div>`;
  }
  html += `</div>`;
  tree.innerHTML = html;
  drawHeapLines();

  array.innerHTML = jobs.map((job, i) => `
    <div class="heap-cell ${job && job.status === "CANCELLED" ? "cancelled" : ""} ${job ? "" : "hole"}"
         data-index="${i}" ${job ? `data-flip="cell:${esc(job.jobId)}"` : ""} title="${job ? "key " + keyText(job.key) : "empty"}">
      <span class="idx">[${i}]</span>${job ? esc(job.jobId) : "—"}
    </div>`).join("");
}

const heapBox = (i) => document.querySelector(`#heap-tree .heap-slot[data-index="${i}"] .heap-box`);
const heapCell = (i) => document.querySelector(`#heap-array .heap-cell[data-index="${i}"]`);
const heapLabel = (i) => document.querySelector(`#heap-tree .heap-slot[data-index="${i}"] .heap-node-index`);

/** Draw a line from every heap node (index i) to its parent ((i − 1) / 2). */
function drawHeapLines() {
  const inner = document.querySelector(".heap-inner");
  if (!inner) return;
  const svg = inner.querySelector(".heap-lines");
  const box = inner.getBoundingClientRect();
  svg.setAttribute("width", box.width);
  svg.setAttribute("height", box.height);

  const point = (el, edge) => {
    const r = el.getBoundingClientRect();
    return { x: r.left - box.left + r.width / 2, y: (edge === "top" ? r.top : r.bottom) - box.top };
  };

  let lines = "";
  const count = inner.querySelectorAll(".heap-box").length;
  for (let i = 1; i < count; i++) {
    const child = heapBox(i);
    const parent = heapBox(Math.floor((i - 1) / 2));
    if (!child || !parent) continue;
    const a = point(parent, "bottom");
    const b = point(child, "top");
    lines += `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`;
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
    + jobs.map((job, i) => `<span class="queue-group">${jobNode(job, { showAge: true })}<span class="queue-arrow">${i < jobs.length - 1 ? "→" : "←"}</span>`
        + (i === jobs.length - 1 ? `<span class="queue-end">REAR</span>` : "") + `</span>`).join("");
}

function renderAging() {
  $("aging-toggle").checked = state.aging.enabled;
  $("aging-turns").textContent = state.aging.turns;
  document.querySelector(".aging-box").classList.toggle("off", !state.aging.enabled);
}

function renderHistory() {
  const item = (job, detail, flip) => `
    <li data-flip="${flip}:${esc(job.jobId)}"><span class="id">${esc(job.jobId)}</span>
        <span class="badge ${job.priority.toLowerCase()}">${job.priority}</span>
        ${job.aged ? `<span class="badge aged">AGED</span>` : ""}
        <span class="doc">${esc(job.document)} · ${esc(job.user)} · ${detail}</span></li>`;
  $("completed-list").innerHTML = state.completed.length
    ? [...state.completed].reverse().map((j) => item(j, `${j.pages} page${j.pages === 1 ? "" : "s"}`, "job")).join("")
    : `<li class="muted">None yet</li>`;
  $("cancelled-list").innerHTML = state.cancelled.length
    ? [...state.cancelled].reverse().map((j) => item(j, `cancelled at turn ${j.finishedTurn}`, "hist")).join("")
    : `<li class="muted">None yet</li>`;
}

/** Every bucket, empty ones too, so a resize visibly doubles the table. */
function renderHashMap(resized = false) {
  const map = structures.hashMap;
  const statusById = {};
  allJobs().forEach((job) => { statusById[job.jobId] = job.status; });
  const chains = {};
  map.buckets.forEach((b) => { chains[b.index] = b.keys; });
  const collisions = map.buckets.filter((b) => b.keys.length > 1).length;

  $("hashmap-meta").textContent =
    `${map.size} entr${map.size === 1 ? "y" : "ies"} · ${map.capacity} buckets · load factor ${map.loadFactor.toFixed(2)}`
    + ` (resizes above 0.75) · ${collisions} collision bucket${collisions === 1 ? "" : "s"}`;

  const note = $("hashmap-resize");
  note.hidden = !map.resizes.length;
  note.innerHTML = map.resizes.map((r) => `
    <div><strong>Resized ${r.from} → ${r.to} buckets</strong> when entry ${r.entries} arrived:
      load factor ${r.entries}/${r.from} = ${(r.entries / r.from).toFixed(2)} &gt; 0.75, so every key was rehashed
      into the bigger table.</div>`).join("");

  const probed = probe && probe.capacity === map.capacity ? probe : null;
  let html = "";
  for (let i = 0; i < map.capacity; i++) {
    const keys = chains[i] || [];
    const isProbe = probed && probed.bucket === i;
    html += `<div class="bucket ${keys.length > 1 ? "collision" : ""} ${keys.length ? "" : "empty-bucket"} ${isProbe ? "probe" : ""}">
      <span class="bucket-index">[${i}]</span>
      ${keys.length
        ? keys.map((key, pos) => `<span class="bucket-entry ${statusById[key] || ""} ${isProbe && pos < probed.comparisons ? "walked" : ""}"
              data-id="${esc(key)}" data-flip="hash:${esc(key)}" title="${esc(key)} → ${statusById[key] || ""}">${esc(key)}</span>`)
            .join(`<span class="chain-arrow">→</span>`)
        : `<span class="bucket-null">null</span>`}
    </div>`;
  }
  const view = $("hashmap-view");
  view.innerHTML = html;
  if (resized) {
    flash(note);
  }
  if (probed) {
    // Scroll only the bucket list, never the page.
    const row = view.querySelector(".bucket.probe");
    if (row && (row.offsetTop < view.scrollTop || row.offsetTop + row.offsetHeight > view.scrollTop + view.clientHeight)) {
      view.scrollTop = row.offsetTop - view.clientHeight / 2;
    }
  }
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

// ---------- Heap animation player ----------

const UP_CODE = [
  "void insert(PrintJob job) {",
  "    items[size++] = job;           // bottom of the tree",
  "    int i = size - 1;",
  "    while (i > 0) {",
  "        int parent = (i - 1) / 2;",
  "        if (items[i].outranks(items[parent])) {",
  "            swap(i, parent);  i = parent;",
  "        } else break;              // settled",
  "    }",
  "}",
];
const DOWN_CODE = [
  "PrintJob extractMax() {",
  "    PrintJob top = items[0];       // root leaves",
  "    items[0] = items[--size];      // last → root",
  "    int i = 0;",
  "    while (true) {",
  "        int largest = best of i, left, right;",
  "        if (largest == i) break;   // settled",
  "        swap(i, largest);  i = largest;",
  "    }",
  "    return top;",
  "}",
];
const PHASE_TITLES = {
  submit: "Heap insert · heapifyUp",
  aging: "Fairness aging · heapifyUp",
  print: "extractMax · heapifyDown",
  discard: "Lazy deletion · extractMax",
};

const player = {
  running: false,
  paused: false,
  skipping: false,
  resume: null,
  timer: null,
  done: Promise.resolve(),
  anims: new Set(),

  boost: 1,   // extra speed-up while a burst of jobs is animating

  speed() { return (Number($("pl-speed").value) || 1) * this.boost; },

  /** Wait `ms` (scaled by speed). While paused, waits for Next step or Resume. */
  hold(ms) {
    if (this.skipping) return Promise.resolve();
    return new Promise((resolve) => {
      this.resume = resolve;
      if (!this.paused) this.timer = setTimeout(resolve, ms / this.speed());
    });
  },

  animate(el, keyframes, ms) {
    if (!el || this.skipping) return Promise.resolve();
    const anim = el.animate(keyframes, { duration: ms / this.speed(), easing: "cubic-bezier(.45,0,.2,1)", fill: "forwards" });
    this.anims.add(anim);
    return anim.finished.catch(() => {}).finally(() => this.anims.delete(anim));
  },

  pause() {
    this.paused = true;
    clearTimeout(this.timer);
    this.anims.forEach((a) => a.pause());
    updatePlayerButtons();
  },

  unpause() {
    this.paused = false;
    this.anims.forEach((a) => a.play());
    if (this.resume) this.resume();
    updatePlayerButtons();
  },

  /** While paused: let the current movement finish, then run exactly one more step. */
  next() {
    this.anims.forEach((a) => a.play());
    if (this.resume) this.resume();
  },

  /** Finish instantly; the caller then draws the final state. */
  async stop() {
    if (!this.running) return;
    this.skipping = true;
    clearTimeout(this.timer);
    this.anims.forEach((a) => a.finish());
    if (this.resume) this.resume();
    await this.done;
  },

  async play(trace, { boost = 1 } = {}) {
    this.boost = boost;
    let finished;
    this.done = new Promise((resolve) => { finished = resolve; });
    this.running = true;
    this.skipping = false;
    this.paused = false;
    updatePlayerButtons();
    try {
      await playTrace(trace);
    } finally {
      document.querySelectorAll(".heap-ghost").forEach((g) => g.remove());
      this.running = false;
      this.skipping = false;
      this.paused = false;
      this.resume = null;
      this.boost = 1;
      updatePlayerButtons();
      finished();
    }
  },
};

function updatePlayerButtons() {
  const p = player;
  $("pl-pause").disabled = !p.running;
  $("pl-pause").textContent = p.paused ? "Resume" : "Pause";
  $("pl-next").disabled = !(p.running && p.paused);
  $("pl-skip").disabled = !p.running && !activeBurst;
  $("pl-replay").disabled = p.running || !lastTrace;
  $("heap-player").classList.toggle("live", p.running);
}

function narrate(text) {
  $("player-text").innerHTML = text;
}

function showCode(lines, active) {
  const code = $("player-code");
  code.hidden = false;
  code.innerHTML = lines.map((line, i) =>
    `<span class="ln ${i === active ? "active" : ""}"><span class="ln-no">${i + 1}</span>${esc(line)}</span>`).join("");
}

/** Why `winner` outranks `loser`, in words. */
function whyWins(winner, loser) {
  if (winner.key[0] !== loser.key[0]) {
    return `level ${winner.key[0]} &gt; ${loser.key[0]}`;
  }
  return `same level, ${esc(winner.jobId)} arrived earlier`;
}

/** Centre-to-centre offset from element a to element b. */
function offset(a, b) {
  const ra = a.getBoundingClientRect();
  const rb = b.getBoundingClientRect();
  return { dx: rb.left + rb.width / 2 - (ra.left + ra.width / 2), dy: rb.top + rb.height / 2 - (ra.top + ra.height / 2) };
}

/** Slide the nodes at i and j into each other's places, in the tree and the array. */
function animateSwap(i, j) {
  const moves = [];
  for (const [x, y] of [[heapBox(i), heapBox(j)], [heapCell(i), heapCell(j)]]) {
    if (!x || !y) continue;
    const { dx, dy } = offset(x, y);
    const lift = Math.abs(dx) > Math.abs(dy) ? { x: 0, y: -18 } : { x: dx > 0 ? -14 : 14, y: 0 };
    x.classList.add("moving");
    y.classList.add("moving");
    moves.push(player.animate(x, [
      { transform: "translate(0, 0) scale(1)" },
      { transform: `translate(${dx / 2 + lift.x}px, ${dy / 2 + lift.y}px) scale(1.12)`, offset: 0.5 },
      { transform: `translate(${dx}px, ${dy}px) scale(1)` },
    ], 900));
    moves.push(player.animate(y, [
      { transform: "translate(0, 0) scale(1)" },
      { transform: `translate(${-dx / 2 - lift.x}px, ${-dy / 2 - lift.y}px) scale(1.12)`, offset: 0.5 },
      { transform: `translate(${-dx}px, ${-dy}px) scale(1)` },
    ], 900));
  }
  return Promise.all(moves);
}

/** The printed job flies out of the root and into the printer card. */
async function flyToPrinter(el) {
  if (!el || player.skipping) return;
  const from = el.getBoundingClientRect();
  const target = $("printer-body").getBoundingClientRect();
  const ghost = el.cloneNode(true);
  ghost.classList.add("heap-ghost");
  Object.assign(ghost.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` });
  document.body.appendChild(ghost);
  el.style.visibility = "hidden";
  const dx = target.left + target.width / 2 - (from.left + from.width / 2);
  const dy = target.top + target.height / 2 - (from.top + from.height / 2);
  await player.animate(ghost, [
    { transform: "translate(0, 0) scale(1)", opacity: 1 },
    { transform: `translate(0, -26px) scale(1.2)`, opacity: 1, offset: 0.2 },
    { transform: `translate(${dx}px, ${dy}px) scale(1.35)`, opacity: 0.15 },
  ], 1300);
  ghost.remove();
  renderPrinter();
  flash($("printer-card"));
}

/** A cancelled job at the root shakes, greys out and drops away. */
function discardNode(el) {
  return player.animate(el, [
    { transform: "none", opacity: 1, filter: "none" },
    { transform: "translateX(-7px) rotate(-4deg)", offset: 0.12 },
    { transform: "translateX(7px) rotate(4deg)", offset: 0.24 },
    { transform: "translateX(-5px) rotate(-2deg)", offset: 0.36 },
    { transform: "translateY(0) rotate(0)", opacity: 1, filter: "grayscale(1)", offset: 0.5 },
    { transform: "translateY(60px) rotate(12deg) scale(.6)", opacity: 0, filter: "grayscale(1)" },
  ], 1400);
}

function ensureHeapVisible() {
  const tree = $("heap-tree");
  const r = tree.getBoundingClientRect();
  if (r.top < 0 || r.bottom > window.innerHeight) {
    tree.scrollIntoView({ behavior: "smooth", block: "nearest" });
    return player.hold(450);
  }
  return Promise.resolve();
}

/** Mark nodes (and their array cells) with a class for the current step. */
function mark(indices, cls) {
  indices.forEach((i) => {
    if (heapBox(i)) heapBox(i).classList.add(cls);
    if (heapCell(i)) heapCell(i).classList.add(cls);
  });
}

async function playTrace(trace) {
  const known = {};
  allJobs().forEach((job) => { known[job.jobId] = job; });
  const job = (id) => known[id] || { jobId: id, priority: "HIGH", document: "", status: "WAITING", key: [0, 0] };
  const draw = (ids) => renderHeap(ids.map((id) => (id ? job(id) : null)));
  const name = (id) => `<strong>${esc(id)}</strong>`;

  const steps = trace.filter((s) => s.op !== "phase").length;
  let stepNo = 0;
  let kind = "submit";
  let code = UP_CODE;
  let comparisons = 0;
  let swaps = 0;
  let totalSwaps = 0;
  let size = 0;

  const counters = () => {
    const h = size > 0 ? Math.floor(Math.log2(size)) : 0;
    $("player-counters").innerHTML = `
      <span><b>${comparisons}</b> comparison${comparisons === 1 ? "" : "s"}</span>
      <span><b>${swaps}</b> swap${swaps === 1 ? "" : "s"}</span>
      <span>n = <b>${size}</b> · tree height ⌊log₂ n⌋ = <b>${h}</b> → at most <b>${h}</b> swaps</span>`;
  };

  await ensureHeapVisible();

  for (const step of trace) {
    if (player.skipping) break;
    const a = step.a;
    const b = step.b;
    const ids = step.heap;

    if (step.op === "phase") {
      kind = step.kind;
      code = kind === "submit" || kind === "aging" ? UP_CODE : DOWN_CODE;
      comparisons = 0;
      swaps = 0;
      size = kind === "submit" || kind === "aging" ? ids.length + 1 : ids.length;
      $("player-title").textContent = PHASE_TITLES[kind] || "Heap";
      $("player-step").textContent = "";
      draw(ids);
      narrate(esc(step.text) + ".");
      showCode(code, 0);
      counters();
      await player.hold(1100);
      continue;
    }

    stepNo++;
    $("player-step").textContent = `Step ${stepNo} of ${steps}`;

    if (step.op === "insert") {
      draw(ids);
      mark([a], "fresh");
      narrate(`Place ${name(ids[a])} in the next free slot, index <code>[${a}]</code>: the bottom of the tree.
               It may break heap order, so it bubbles up.`);
      showCode(code, 1);
      await player.animate(heapBox(a), [
        { transform: "translateY(-50px) scale(.5)", opacity: 0 },
        { transform: "translateY(6px) scale(1.05)", opacity: 1, offset: 0.7 },
        { transform: "none", opacity: 1 },
      ], 800);
      await player.hold(700);
    } else if (step.op === "compare") {
      comparisons++;
      counters();
      const up = code === UP_CODE;
      const loser = step.winner === a ? b : a;
      draw(ids);   // clear the previous comparison's highlights
      mark([a, b], "cmp");
      mark([step.winner], "win");
      mark([loser], "lose");
      for (const i of [a, b]) {
        const label = heapLabel(i);
        if (label) label.innerHTML = `[${i}] key <b>${keyText(job(ids[i]).key)}</b>`;
      }
      const W = job(ids[step.winner]);
      const L = job(ids[loser]);
      narrate(up
        ? `Compare ${name(ids[a])} with its parent ${name(ids[b])}: ${name(W.jobId)} ranks higher
           (${whyWins(W, L)}) → ${step.winner === a ? "<b>swap them</b>." : "already in order, <b>stop</b>."}`
        : `Compare ${name(ids[a])} with child ${name(ids[b])}: ${name(W.jobId)} ranks higher (${whyWins(W, L)}).`);
      showCode(code, 5);
      await player.hold(1500);
    } else if (step.op === "swap") {
      swaps++;
      totalSwaps++;
      counters();
      mark([a, b], "cmp");
      narrate(`Swap <code>[${a}]</code> ↔ <code>[${b}]</code>: tree node and array cell are the same thing,
               so both views move together.`);
      showCode(code, code === UP_CODE ? 6 : 7);
      await animateSwap(a, b);
      draw(ids);
      await player.hold(350);
    } else if (step.op === "settle") {
      draw(ids);
      mark([a], "settled");
      const h = size > 0 ? Math.floor(Math.log2(size)) : 0;
      const where = a === 0 && code === UP_CODE
        ? `${name(ids[a])} reached the root <code>[0]</code>: it is now the next job to print.`
        : `${name(ids[a])} settles at <code>[${a}]</code>.`;
      narrate(`${where} Heap order restored with <b>${swaps}</b> swap${swaps === 1 ? "" : "s"};
               a heap of ${size} job${size === 1 ? "" : "s"} can never need more than ⌊log₂ ${size}⌋ = ${h}. That is O(log n).`);
      showCode(code, code === UP_CODE ? (a === 0 ? 3 : 7) : 6);
      await player.animate(heapBox(a), [
        { boxShadow: "0 0 0 0 rgba(47, 158, 68, .7)" },
        { boxShadow: "0 0 0 12px rgba(47, 158, 68, 0)" },
      ], 900);
      await player.hold(1100);
    } else if (step.op === "remove") {
      const root = heapBox(0);
      mark([0], kind === "discard" ? "lose" : "win");
      showCode(code, 1);
      if (kind === "discard") {
        narrate(`${name(step.jobId)} is <b>CANCELLED</b>. Lazy deletion left it in place, and now that it has
                 reached the top it is thrown away.`);
        await player.hold(500);
        await discardNode(root);
      } else {
        narrate(`${name(step.jobId)} is the root, so it is the highest-priority job. It leaves the heap and
                 goes to the printer.`);
        await player.hold(500);
        await flyToPrinter(root);
      }
      draw(ids);
      await player.hold(500);
    } else if (step.op === "move") {
      const last = heapBox(a);
      const hole = heapBox(0);
      mark([a], "fresh");
      narrate(`Move the last element ${name(ids[0])} from <code>[${a}]</code> into the hole at the root.
               The tree stays complete; now it sinks down.`);
      showCode(code, 2);
      if (last && hole) {
        const { dx, dy } = offset(last, hole);
        last.classList.add("moving");
        const cellMove = heapCell(a) && heapCell(0) ? offset(heapCell(a), heapCell(0)) : null;
        await Promise.all([
          player.animate(last, [
            { transform: "translate(0, 0)" },
            { transform: `translate(${dx}px, ${dy}px)` },
          ], 1000),
          cellMove && player.animate(heapCell(a), [
            { transform: "translate(0, 0)" },
            { transform: `translate(${cellMove.dx}px, 0)` },
          ], 1000),
        ]);
      }
      size = ids.length;
      draw(ids);
      counters();
      await player.hold(400);
    }
  }

  if (!player.skipping) {
    $("player-step").textContent = "Done";
    narrate(`Done. <b>${totalSwaps}</b> swap${totalSwaps === 1 ? "" : "s"} in total. Each insert or extractMax walks
             one root-to-leaf path, never more than the tree height, so it costs O(log n).
             Press <b>Replay</b> to watch again.`);
  } else {
    $("player-step").textContent = "Skipped";
    narrate("Skipped to the end. The heap now shows the final state. Press <b>Replay</b> to watch the steps.");
  }
}

// ---------- Search & cancel ----------

async function showJob(rawId, { quiet = false } = {}) {
  const id = rawId.trim().toUpperCase();
  const box = $("search-result");
  if (!id) {
    toast("Enter a job ID to search.", "err");
    return;
  }
  const [jobResult, lookupResult] = await Promise.allSettled([
    api("GET", `/api/jobs/${encodeURIComponent(id)}`),
    api("GET", `/api/hash/${encodeURIComponent(id)}`),
  ]);
  const lookup = lookupResult.status === "fulfilled" ? lookupResult.value : null;
  const changedProbe = JSON.stringify(probe) !== JSON.stringify(lookup);
  probe = lookup;
  if (changedProbe && structures) renderHashMap();

  if (jobResult.status === "rejected") {
    searchedId = null;
    box.innerHTML = `<div class="search-card"><strong>${esc(id)}</strong>
                       <p class="muted">${esc(jobResult.reason.message)}</p>${lookupHtml(lookup)}</div>`;
    if (!quiet) flash(box.firstElementChild);
    return;
  }
  const job = jobResult.value;
  searchedId = job.jobId;
  $("search-input").value = job.jobId;

  box.innerHTML = `
    <div class="search-card">
      <div><span class="job-id">${esc(job.jobId)}</span>
           <span class="badge status-${job.status}">${job.status}</span></div>
      <div class="doc"><strong>${esc(job.document)}</strong></div>
      <dl class="meta">
        <dt>User</dt><dd>${esc(job.user)}</dd>
        <dt>Priority</dt><dd><span class="badge ${job.priority.toLowerCase()}">${job.priority}</span>
          ${job.aged ? `<span class="badge aged">AGED → HIGH at turn ${job.agedTurn}</span>` : ""}</dd>
        <dt>Pages</dt><dd>${job.pages}</dd>
        <dt>Heap key</dt><dd><code>${keyText(job.key)}</code></dd>
      </dl>
      ${job.status === "WAITING" ? `<button id="btn-cancel" class="btn btn-danger" type="button">Cancel job</button>` : ""}
      ${lazyDeletionNote(job)}
      ${lookupHtml(lookup)}
    </div>`;
  if (!quiet) flash(box.firstElementChild);

  const cancelBtn = $("btn-cancel");
  if (cancelBtn) {
    cancelBtn.addEventListener("click", () => run(() => api("PUT", `/api/jobs/${encodeURIComponent(job.jobId)}/cancel`)));
  }
}

/** Show exactly how the hash map found (or failed to find) the key. */
function lookupHtml(l) {
  if (!l) return "";
  const chain = l.chain.length
    ? l.chain.map((key, i) => `<span class="chain-key ${i < l.comparisons ? "walked" : ""} ${key === l.key ? "hit" : ""}">${esc(key)}</span>`)
        .join(`<span class="chain-arrow">→</span>`)
    : `<span class="muted">empty bucket</span>`;
  return `
    <div class="lookup">
      <div class="lookup-title">How the hash map found it</div>
      <div><code>hash("${esc(l.key)}") = ${l.hash}</code> <span class="muted small">(h = h × 31 + char)</span></div>
      <div><code>${l.hash} mod ${l.capacity} = bucket [${l.bucket}]</code></div>
      <div class="lookup-chain">${chain}</div>
      <div class="muted small">${l.found
        ? `Found after ${l.comparisons} key comparison${l.comparisons === 1 ? "" : "s"}${l.chain.length > 1 ? " (collision: this bucket holds a chain)" : ""}.`
        : `Not found after ${l.comparisons} comparison${l.comparisons === 1 ? "" : "s"}, so the API returns 404.`}</div>
    </div>`;
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
  probe = null;
  lastTrace = null;
  $("search-input").value = "";
  $("search-result").innerHTML = `<p class="muted">Enter a job ID, or click any job below.</p>`;
  run(() => api("POST", "/api/reset"));
});

$("aging-toggle").addEventListener("change", (event) =>
  run(() => api("PUT", "/api/settings/aging", { enabled: event.target.checked })));

// Player controls
$("pl-pause").addEventListener("click", () => (player.paused ? player.unpause() : player.pause()));
$("pl-next").addEventListener("click", () => player.next());
$("pl-skip").addEventListener("click", () => {
  if (activeBurst) activeBurst.fast = true;   // the remaining jobs arrive without animation
  player.stop();
});
$("pl-replay").addEventListener("click", async () => {
  if (!lastTrace || player.running) return;
  await player.play(lastTrace);
  render();
  updatePlayerButtons();
});

// Remember the viewer's animation preferences (a convenience only).
for (const id of ["pl-speed", "pl-enabled"]) {
  const el = $(id);
  try {
    const saved = localStorage.getItem(`printflow.${id}`);
    if (saved !== null) {
      if (el.type === "checkbox") el.checked = saved === "true"; else el.value = saved;
    }
  } catch { /* storage unavailable */ }
  el.addEventListener("change", () => {
    try { localStorage.setItem(`printflow.${id}`, el.type === "checkbox" ? el.checked : el.value); } catch { /* ignore */ }
  });
}

// ---------- Bursts: several jobs arriving one after another ----------

/**
 * Submit jobs one at a time and animate each arrival: normal jobs pop into the
 * queue at REAR, priority jobs are inserted into the heap and bubble up live.
 * `more(count, capacity, startCapacity)` can ask for extra jobs (Rush hour
 * keeps going until the hash map resizes). Skip makes the rest arrive instantly.
 */
let activeBurst = null;

async function burst(jobs, { more = () => false } = {}) {
  if (activeBurst) return null;
  await player.stop();
  const current = { fast: !$("pl-enabled").checked };
  activeBurst = current;
  setBurstButtons(true);
  const startCapacity = structures ? structures.hashMap.capacity : 16;
  const ids = [];
  const traces = [];
  let capacity = startCapacity;
  try {
    while (ids.length < jobs.length || more(ids.length, capacity, startCapacity)) {
      const data = await api("POST", "/api/jobs", jobs[ids.length % jobs.length]);
      ids.push(data.job.jobId);
      capacity = data.state.hashMap.capacity;
      traces.push(...data.heapTrace);
      if (current.fast) continue;
      toast(`Arrived: ${data.job.jobId} (${data.job.priority}), job ${ids.length} of the burst.`, "ok");
      await refresh(data.heapTrace.length ? data.heapTrace : null, { boost: 1.6 });
      if (!data.heapTrace.length) await pause(650);
    }
  } catch (err) {
    toast(err.message, "err");
  } finally {
    activeBurst = null;
    setBurstButtons(false);
  }
  await refresh();
  if (traces.length) {
    lastTrace = traces;   // Replay shows the whole burst
    const inserts = traces.filter((step) => step.op === "insert").length;
    $("player-title").textContent = "Burst finished";
    $("player-step").textContent = "";
    $("player-counters").innerHTML = "";
    narrate(`${ids.length} jobs arrived; ${inserts} of them went into the heap.
             Press <b>Replay</b> to watch ${inserts === 1 ? "that heap insert" : `all ${inserts} heap inserts, one after another`}.`);
  }
  updatePlayerButtons();
  return { ids, startCapacity, capacity };
}

function setBurstButtons(busy) {
  for (const id of ["btn-sample", "btn-rush", "btn-reset"]) $(id).disabled = busy;
  updatePlayerButtons();
}

/** A short gap between arrivals, scaled by the speed setting. */
function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms / (Number($("pl-speed").value) || 1)));
}

// The evaluation demo: three normal jobs, then one urgent job.
const DEMO_JOBS = [
  { user: "Shiv", document: "Lab_Record.pdf", pages: 15, priority: "NORMAL" },
  { user: "Asha", document: "Assignment.pdf", pages: 6, priority: "NORMAL" },
  { user: "Ravi", document: "Notes.pdf", pages: 3, priority: "NORMAL" },
  { user: "Admin", document: "Exam_Papers.pdf", pages: 4, priority: "URGENT" },
];

$("btn-sample").addEventListener("click", async () => {
  const result = await burst(DEMO_JOBS);
  if (result) toast(`Loaded demo jobs ${result.ids.join(", ")}.`, "ok");
});

// A burst of mostly priority jobs: normal jobs get passed over (aging kicks in),
// sequential IDs start colliding, and the hash map grows past 0.75 and resizes.
const RUSH_JOBS = [
  { user: "Meera", document: "Project_Report.pdf", pages: 12, priority: "HIGH" },
  { user: "Principal", document: "Circular.pdf", pages: 2, priority: "URGENT" },
  { user: "Kiran", document: "Resume.pdf", pages: 1, priority: "NORMAL" },
  { user: "HOD", document: "Timetable.pdf", pages: 3, priority: "HIGH" },
  { user: "Office", document: "Fee_Notice.pdf", pages: 1, priority: "URGENT" },
  { user: "Divya", document: "Seminar_Slides.pdf", pages: 8, priority: "HIGH" },
  { user: "Arjun", document: "Lab_Manual.pdf", pages: 20, priority: "NORMAL" },
  { user: "Exam Cell", document: "Hall_Tickets.pdf", pages: 5, priority: "URGENT" },
  { user: "Library", document: "Book_List.pdf", pages: 4, priority: "HIGH" },
];

$("btn-rush").addEventListener("click", async () => {
  // Send the whole burst, then keep going until the hash map has resized once.
  const result = await burst(RUSH_JOBS, {
    more: (count, capacity, startCapacity) => capacity === startCapacity && count < 40,
  });
  if (!result) return;
  toast(`Rush hour: ${result.ids.length} jobs arrived.`
    + (result.capacity > result.startCapacity
      ? ` The hash map grew from ${result.startCapacity} to ${result.capacity} buckets.` : ""), "ok");
});

window.addEventListener("resize", drawHeapLines);

refresh();
