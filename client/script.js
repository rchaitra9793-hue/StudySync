/* =========================================
   StudySync – Student Academic Planner
   Plain JavaScript, data saved on the StudySync server
   (a copy is kept in localStorage for offline viewing)
   ========================================= */

const MIN_ATTENDANCE = 75; // required attendance in percent

// Use the local server when the page is opened straight from disk
const API_URL = location.protocol === "file:" ? "http://localhost:3000/api" : "/api";
const CACHE_KEY = "studysync_cache";
const TOKEN_KEY = "studysync_token";

// ---------- App data (filled from the server) ----------
let user = null;         // logged-in student's profile
let attendance = null;   // { total, attended }
let subjects = [];       // [{ id, name, total, attended }]
let assignments = [];    // [{ id, name, subject, start, deadline, completed }]
let exams = [];          // [{ id, name, subject, date, time }]
let notes = [];          // [{ id, title, category, subject, content, createdAt }]

let currentFilter = "all";
let noteFilter = "all";
let noteSearch = "";
let calDate = new Date();          // month shown in the calendar
let lastRenderedDay = todayStr();  // used to refresh reminders when the date changes

/* =========================================
   Server (API) helpers
   ========================================= */
// Send a request to the server and return the JSON reply
async function api(path, method = "GET", body) {
  const headers = { Authorization: "Bearer " + getToken() };
  if (body) headers["Content-Type"] = "application/json";

  let response;
  try {
    response = await fetch(API_URL + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (e) {
    setServerStatus(false);
    throw new Error("Cannot reach the server. Please check your internet connection and try again.");
  }

  setServerStatus(true);
  // Login missing or expired: back to the login page
  if (response.status === 401) {
    clearLogin();
    location.replace("login.html");
    throw new Error("Please log in again.");
  }
  if (response.status === 204) return null;
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error((data && data.error) || "Request failed.");
  return data;
}

function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; }
}

// Forget the login and this student's offline copy
function clearLogin() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(CACHE_KEY);
  } catch (e) { /* storage not available – ignore */ }
}

async function logout() {
  try {
    await api("/auth/logout", "POST");
  } catch (e) { /* server offline – still log out on this device */ }
  clearLogin();
  location.replace("login.html");
}

// Load all data from the server; fall back to the last saved copy if offline
async function loadData() {
  try {
    const data = await api("/data");
    user = data.user;
    attendance = data.attendance;
    subjects = data.subjects;
    assignments = data.assignments;
    exams = data.exams || [];
    notes = data.notes || [];
    saveCache();
  } catch (e) {
    const cache = readCache();
    if (cache) {
      user = cache.user || null;
      attendance = cache.attendance;
      subjects = cache.subjects || [];
      assignments = cache.assignments || [];
      exams = cache.exams || [];
      notes = cache.notes || [];
    }
    showToast("Server offline – showing your last saved data.");
  }
}

function saveCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ user, attendance, subjects, assignments, exams, notes }));
  } catch (e) { /* storage not available – ignore */ }
}

function readCache() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY));
  } catch (e) {
    return null;
  }
}

function setServerStatus(online) {
  const el = $("serverStatus");
  el.textContent = online ? "● Server connected" : "● Server offline";
  el.className = "server-status " + (online ? "online" : "offline");
}

// Disable a form's button while a request is running (prevents double clicks)
async function withBusy(button, task) {
  button.disabled = true;
  try {
    await task();
  } finally {
    button.disabled = false;
  }
}

/* =========================================
   General helpers
   ========================================= */
function $(id) { return document.getElementById(id); }

// Prevent user text from being treated as HTML
function escapeHTML(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2500);
}

// Is the string a whole number like "0", "12", "60"?
function isWholeNumber(value) {
  return /^\d+$/.test(String(value).trim());
}

/* =========================================
   Date helpers (all dates are local, "YYYY-MM-DD")
   ========================================= */
function todayStr() {
  const d = new Date();
  return toDateStr(d);
}

function toDateStr(d) {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function parseDate(str) {
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function isValidDateStr(str) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const d = parseDate(str);
  return toDateStr(d) === str; // rejects dates like 2026-02-31
}

// Whole days from today until the given date (negative = in the past)
function daysUntil(str) {
  const today = parseDate(todayStr());
  return Math.round((parseDate(str) - today) / 86400000);
}

function formatDate(str) {
  return parseDate(str).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

/* =========================================
   Attendance logic
   ========================================= */
// Returns percentage, how many classes can be missed, or how many must be attended
function calculateAttendance(total, attended) {
  const percent = (attended / total) * 100;
  // Integer maths avoids rounding errors:
  // attended / total >= 75%  <=>  4 * attended >= 3 * total
  if (4 * attended >= 3 * total) {
    // Largest x with attended / (total + x) >= 0.75
    const canMiss = Math.floor((4 * attended - 3 * total) / 3);
    return { percent, safe: true, canMiss, mustAttend: 0 };
  }
  // Smallest y with (attended + y) / (total + y) >= 0.75
  const mustAttend = 3 * total - 4 * attended;
  return { percent, safe: false, canMiss: 0, mustAttend };
}

// Round down to 2 decimals so 74.996% never shows as "75.00%"
function formatPercent(p) {
  return (Math.floor(p * 100) / 100).toFixed(2) + "%";
}

// Overall attendance for the dashboard: calculator value first, otherwise sum of subjects
function getOverallAttendance() {
  if (attendance && attendance.total > 0) return attendance;
  const total = subjects.reduce((sum, s) => sum + s.total, 0);
  const attended = subjects.reduce((sum, s) => sum + s.attended, 0);
  return total > 0 ? { total, attended } : null;
}

function validateAttendance(totalValue, attendedValue) {
  if (totalValue === "" || attendedValue === "") return "Please fill in both fields.";
  if (!isWholeNumber(totalValue) || !isWholeNumber(attendedValue)) return "Please enter whole numbers only (no decimals or negative values).";
  const total = Number(totalValue);
  const attended = Number(attendedValue);
  if (total < 1) return "Total classes conducted must be at least 1.";
  if (total > 5000) return "Total classes looks too large. Please check the value.";
  if (attended > total) return "Classes attended cannot be more than classes conducted.";
  return "";
}

function renderAttendanceResult() {
  const box = $("attendanceResult");
  if (!attendance) {
    box.className = "result empty";
    box.innerHTML = "Enter your classes and press <strong>Calculate</strong> to see your result.";
    return;
  }

  const { total, attended } = attendance;
  const r = calculateAttendance(total, attended);
  const color = r.safe ? "var(--green)" : "var(--red)";
  const deg = Math.min(r.percent, 100) * 3.6;

  let message;
  if (r.safe && r.canMiss > 0) {
    message = `<div class="result-msg good">✅ Great! You are above ${MIN_ATTENDANCE}%. You can miss
      <strong>${r.canMiss}</strong> more class${r.canMiss === 1 ? "" : "es"} and still stay at ${MIN_ATTENDANCE}% or above.</div>`;
  } else if (r.safe) {
    message = `<div class="result-msg warn">⚠️ You are exactly on the edge. You <strong>cannot miss</strong>
      the next class without falling below ${MIN_ATTENDANCE}%.</div>`;
  } else {
    message = `<div class="result-msg bad">❌ Your attendance is below ${MIN_ATTENDANCE}%. You must attend the next
      <strong>${r.mustAttend}</strong> class${r.mustAttend === 1 ? "" : "es"} in a row to reach ${MIN_ATTENDANCE}%.</div>`;
  }

  box.className = "result";
  box.innerHTML = `
    <div class="result-big">
      <div class="ring" style="background: conic-gradient(${color} ${deg}deg, var(--border) 0deg)">
        <div class="ring-inner">${formatPercent(r.percent)}</div>
      </div>
      <div>
        <p><strong>Attended:</strong> ${attended} classes</p>
        <p><strong>Conducted:</strong> ${total} classes</p>
        <p><strong>Missed:</strong> ${total - attended} classes</p>
        <p><span class="tag ${r.safe ? "green" : "red"}">${r.safe ? "Safe" : "Shortage"}</span></p>
      </div>
    </div>
    ${message}`;
}

/* ---------- Subject-wise attendance ---------- */
function renderSubjects() {
  const tbody = $("subjectTable");
  if (subjects.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-msg">No subjects added yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = subjects.map(s => {
    let pctText = "--";
    let status = `<span class="tag gray">No classes</span>`;
    if (s.total > 0) {
      const r = calculateAttendance(s.total, s.attended);
      pctText = formatPercent(r.percent);
      status = r.safe
        ? `<span class="tag green">Can miss ${r.canMiss}</span>`
        : `<span class="tag red">Attend ${r.mustAttend} more</span>`;
    }
    return `
      <tr>
        <td><strong>${escapeHTML(s.name)}</strong></td>
        <td>${s.attended} / ${s.total}</td>
        <td>${pctText}</td>
        <td>${status}</td>
        <td>
          <button class="mini-btn present" data-action="present" data-id="${s.id}">+ Present</button>
          <button class="mini-btn absent" data-action="absent" data-id="${s.id}">+ Absent</button>
        </td>
        <td><button class="mini-btn del" data-action="delete" data-id="${s.id}">Delete</button></td>
      </tr>`;
  }).join("");
}

/* =========================================
   Assignment logic
   ========================================= */
// Work out the state of an assignment based on today's date
function getStatus(a) {
  if (a.completed) return "completed";
  const days = daysUntil(a.deadline);
  if (days < 0) return "overdue";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days <= 3) return "soon";
  return "upcoming";
}

function getReminder(a) {
  const days = daysUntil(a.deadline);
  switch (getStatus(a)) {
    case "completed": return { text: "✔ Completed", cls: "green" };
    case "overdue":   return { text: `⛔ Deadline passed! (${-days} day${days === -1 ? "" : "s"} ago)`, cls: "red" };
    case "today":     return { text: "🔥 Assignment due today!", cls: "red" };
    case "tomorrow":  return { text: "⏰ Your assignment is due tomorrow!", cls: "orange" };
    case "soon":      return { text: `⏳ Due in ${days} days`, cls: "orange" };
    default:          return { text: `📅 Due in ${days} days`, cls: "blue" };
  }
}

function statusTag(status) {
  const map = {
    completed: ["Completed", "green"],
    overdue: ["Overdue", "red"],
    today: ["Due Today", "red"],
    tomorrow: ["Tomorrow", "orange"],
    soon: ["Due Soon", "orange"],
    upcoming: ["Upcoming", "blue"]
  };
  const [label, cls] = map[status];
  return `<span class="tag ${cls}">${label}</span>`;
}

/* ---------- Smart task priority ---------- */
// How much of the time between start date and deadline has already passed (0 to 1)
function timeUsed(a) {
  const totalDays = Math.max(1, daysBetween(a.start, a.deadline));
  const usedDays = totalDays - daysUntil(a.deadline);
  return Math.min(1, Math.max(0, usedDays / totalDays));
}

function daysBetween(from, to) {
  return Math.round((parseDate(to) - parseDate(from)) / 86400000);
}

// Priority level of a pending assignment:
//   Critical – deadline passed
//   High     – due today or tomorrow
//   Medium   – due within 4 days, or 75% of the given time is already used
//   Low      – plenty of time left
function getPriority(a) {
  if (a.completed) return null;
  const days = daysUntil(a.deadline);
  if (days < 0) return { level: "critical", label: "Critical", cls: "red" };
  if (days <= 1) return { level: "high", label: "High", cls: "orange" };
  if (days <= 4 || timeUsed(a) >= 0.75) return { level: "medium", label: "Medium", cls: "yellow" };
  return { level: "low", label: "Low", cls: "blue" };
}

function priorityTag(a) {
  const p = getPriority(a);
  return p ? `<span class="tag ${p.cls}">${p.label} priority</span>` : "";
}

// Most urgent first:
// pending before completed → closest (or most overdue) deadline first → less time left first
function sortedAssignments() {
  return [...assignments].sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    if (a.completed) return b.deadline.localeCompare(a.deadline); // finished: newest first
    const dayDiff = daysUntil(a.deadline) - daysUntil(b.deadline);
    if (dayDiff !== 0) return dayDiff;
    return timeUsed(b) - timeUsed(a);
  });
}

function validateAssignment(name, subject, start, deadline) {
  if (!name) return "Please enter the assignment name.";
  if (!subject) return "Please enter the subject.";
  if (!start || !isValidDateStr(start)) return "Please choose a valid starting date.";
  if (!deadline || !isValidDateStr(deadline)) return "Please choose a valid submission deadline.";
  if (deadline < start) return "The deadline cannot be before the starting date.";
  if (daysUntil(deadline) < 0) return "The deadline has already passed. Please choose today or a future date.";
  return "";
}

function renderAssignments() {
  const list = $("assignmentList");
  const items = sortedAssignments().filter(a => {
    const st = getStatus(a);
    if (currentFilter === "pending") return st !== "completed" && st !== "overdue";
    if (currentFilter === "overdue") return st === "overdue";
    if (currentFilter === "completed") return st === "completed";
    return true;
  });

  if (items.length === 0) {
    list.innerHTML = `<p class="empty-msg">No assignments to show.</p>`;
    return;
  }

  let rank = 0;
  list.innerHTML = items.map(a => {
    const status = getStatus(a);
    const reminder = getReminder(a);
    let cardClass = "";
    if (status === "completed") cardClass = "completed";
    else if (status === "overdue") cardClass = "overdue";
    else if (status === "today" || status === "tomorrow" || status === "soon") cardClass = "soon";
    const rankBadge = a.completed ? "" : `<span class="rank">#${++rank}</span>`;

    return `
      <div class="assign-card ${cardClass}">
        <div class="assign-top">
          <div class="assign-title">
            ${rankBadge}
            <div>
              <h4>${escapeHTML(a.name)}</h4>
              <span class="assign-subject">${escapeHTML(a.subject)}</span>
            </div>
          </div>
          <div class="assign-tags">
            ${statusTag(status)}
            ${priorityTag(a)}
          </div>
        </div>
        <div class="assign-dates">
          <span>Start: <b>${formatDate(a.start)}</b></span>
          <span>Deadline: <b>${formatDate(a.deadline)}</b></span>
        </div>
        <div class="reminder ${reminder.cls}">${reminder.text}</div>
        <div class="assign-actions">
          ${a.completed
            ? `<button class="mini-btn undo" data-action="toggle" data-id="${a.id}">Mark as Pending</button>`
            : `<button class="mini-btn complete" data-action="toggle" data-id="${a.id}">✔ Mark Completed</button>`}
          <button class="mini-btn del" data-action="delete" data-id="${a.id}">Delete</button>
        </div>
      </div>`;
  }).join("");
}

/* =========================================
   Dashboard
   ========================================= */
function renderDashboard() {
  // --- Attendance card ---
  const overall = getOverallAttendance();
  const bar = $("statAttendanceBar");
  if (overall) {
    const r = calculateAttendance(overall.total, overall.attended);
    $("statAttendance").textContent = formatPercent(r.percent);
    bar.style.width = Math.min(r.percent, 100) + "%";
    bar.className = "progress-fill " + (r.safe ? "good" : "bad");
  } else {
    $("statAttendance").textContent = "--";
    bar.style.width = "0";
  }

  // --- Assignment counts ---
  const total = assignments.length;
  const completed = assignments.filter(a => a.completed).length;
  const pending = total - completed;
  const overdue = assignments.filter(a => getStatus(a) === "overdue").length;

  $("statTotal").textContent = total;
  $("statPending").textContent = pending;
  $("statCompleted").textContent = completed;
  $("statCompletedBar").style.width = total ? (completed / total) * 100 + "%" : "0";

  renderReminderBanner();
  renderAttendanceChart();
  renderStatusChart(completed, pending - overdue, overdue);
  renderWeekChart();
  renderUpcoming();
  renderExamCountdown();
  renderRecentNotes();
}

function renderReminderBanner() {
  const overdue = assignments.filter(a => getStatus(a) === "overdue").length;
  const today = assignments.filter(a => getStatus(a) === "today").length;
  const tomorrow = assignments.filter(a => getStatus(a) === "tomorrow").length;

  let html = "";
  if (overdue) html += `<div class="banner red">⛔ <span><strong>Deadline passed!</strong> ${overdue} assignment${overdue > 1 ? "s are" : " is"} overdue.</span></div>`;
  if (today) html += `<div class="banner red">🔥 <span><strong>Assignment due today!</strong> ${today} assignment${today > 1 ? "s" : ""} must be submitted today.</span></div>`;
  if (tomorrow) html += `<div class="banner orange">⏰ <span><strong>Your assignment is due tomorrow!</strong> ${tomorrow} assignment${tomorrow > 1 ? "s" : ""} due tomorrow.</span></div>`;

  // Exams today / tomorrow
  exams.forEach(x => {
    const days = daysUntil(x.date);
    if (days === 0) html += `<div class="banner purple">📝 <span><strong>Exam today:</strong> ${escapeHTML(x.name)} (${escapeHTML(x.subject)})${x.time ? " at " + formatTime(x.time) : ""}. Good luck! 🍀</span></div>`;
    if (days === 1) html += `<div class="banner purple">📝 <span><strong>Exam tomorrow:</strong> ${escapeHTML(x.name)} (${escapeHTML(x.subject)})${x.time ? " at " + formatTime(x.time) : ""}. Time for a final revision!</span></div>`;
  });

  const overall = getOverallAttendance();
  if (overall && !calculateAttendance(overall.total, overall.attended).safe) {
    html += `<div class="banner orange">📉 <span>Your attendance is below ${MIN_ATTENDANCE}%. Check the Attendance page to see how many classes you need.</span></div>`;
  }
  $("reminderBanner").innerHTML = html;

  // Badge on the sidebar menu
  const badge = $("navBadge");
  const urgent = overdue + today + tomorrow;
  badge.hidden = urgent === 0;
  badge.textContent = urgent;
}

// Horizontal bar chart: one bar per subject with a dashed 75% line
function renderAttendanceChart() {
  const chart = $("attendanceChart");
  const rows = subjects.filter(s => s.total > 0);

  if (rows.length === 0) {
    const overall = getOverallAttendance();
    if (!overall) {
      chart.innerHTML = `<p class="empty-msg">Add subjects on the Attendance page to see this chart.</p>`;
      return;
    }
    rows.push({ name: "Overall", total: overall.total, attended: overall.attended });
  }

  chart.innerHTML = rows.map(s => {
    const r = calculateAttendance(s.total, s.attended);
    return `
      <div class="bar-row">
        <span class="bar-label" title="${escapeHTML(s.name)}">${escapeHTML(s.name)}</span>
        <div class="bar-track">
          <div class="bar-fill ${r.safe ? "good" : "bad"}" data-width="${Math.min(r.percent, 100)}"></div>
          <div class="bar-target"></div>
        </div>
        <span class="bar-value">${Math.floor(r.percent)}%</span>
      </div>`;
  }).join("");

  // Animate the bars after they are added to the page
  requestAnimationFrame(() => {
    chart.querySelectorAll(".bar-fill").forEach(el => { el.style.width = el.dataset.width + "%"; });
  });
}

// Donut chart drawn on a <canvas>
function renderStatusChart(completed, pending, overdue) {
  const canvas = $("statusChart");
  const ctx = canvas.getContext("2d");
  const size = 200;
  const scale = window.devicePixelRatio || 1;
  canvas.width = size * scale;
  canvas.height = size * scale;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, size, size);

  const parts = [
    { label: "Completed", value: completed, color: "#16a34a" },
    { label: "Pending", value: pending, color: "#4f46e5" },
    { label: "Overdue", value: overdue, color: "#dc2626" }
  ];
  const total = completed + pending + overdue;
  const cx = size / 2, cy = size / 2, radius = 80, thickness = 26;

  ctx.lineWidth = thickness;
  if (total === 0) {
    ctx.strokeStyle = "#e5e7eb";
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    let angle = -Math.PI / 2;
    parts.forEach(p => {
      if (p.value === 0) return;
      const slice = (p.value / total) * Math.PI * 2;
      ctx.strokeStyle = p.color;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, angle, angle + slice);
      ctx.stroke();
      angle += slice;
    });
  }

  // Text in the middle
  ctx.fillStyle = "#1e2340";
  ctx.textAlign = "center";
  ctx.font = "700 30px Poppins, sans-serif";
  ctx.fillText(total, cx, cy + 6);
  ctx.fillStyle = "#6b7280";
  ctx.font = "12px Poppins, sans-serif";
  ctx.fillText("assignments", cx, cy + 26);

  $("statusLegend").innerHTML = parts.map(p =>
    `<li><i style="background:${p.color}"></i>${p.label}<b>${p.value}</b></li>`
  ).join("");
}

// Column chart: number of pending deadlines for each of the next 7 days
function renderWeekChart() {
  const chart = $("weekChart");
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = parseDate(todayStr());
    d.setDate(d.getDate() + i);
    const str = toDateStr(d);
    const count = assignments.filter(a => !a.completed && a.deadline === str).length;
    days.push({
      label: i === 0 ? "Today" : d.toLocaleDateString("en-IN", { weekday: "short" }),
      count
    });
  }

  const max = Math.max(1, ...days.map(d => d.count));
  chart.innerHTML = days.map((d, i) => `
    <div class="col">
      <div class="col-bar ${i === 0 ? "today" : ""}" data-height="${(d.count / max) * 85}">
        <span>${d.count}</span>
      </div>
    </div>`).join("");

  // Day labels below the chart
  let labels = chart.nextElementSibling;
  if (!labels || !labels.classList.contains("col-labels")) {
    labels = document.createElement("div");
    labels.className = "col-labels";
    chart.after(labels);
  }
  labels.innerHTML = days.map(d => `<span>${d.label}</span>`).join("");

  requestAnimationFrame(() => {
    chart.querySelectorAll(".col-bar").forEach(el => { el.style.height = el.dataset.height + "%"; });
  });
}

function renderUpcoming() {
  const list = $("upcomingList");
  const pending = sortedAssignments().filter(a => !a.completed).slice(0, 5);

  if (pending.length === 0) {
    list.innerHTML = `<li class="empty-msg" style="background:none">🎉 No pending assignments!</li>`;
    return;
  }

  list.innerHTML = pending.map((a, i) => {
    const d = parseDate(a.deadline);
    const reminder = getReminder(a);
    const p = getPriority(a);
    return `
      <li class="prio-${p.level}">
        <span class="rank">#${i + 1}</span>
        <div class="date-box">
          <b>${d.getDate()}</b>
          <small>${d.toLocaleDateString("en-IN", { month: "short" })}</small>
        </div>
        <div class="up-info">
          <strong>${escapeHTML(a.name)}</strong>
          <span>${escapeHTML(a.subject)} · <span class="reminder ${reminder.cls}">${reminder.text}</span></span>
        </div>
        <span class="tag ${p.cls}">${p.label}</span>
      </li>`;
  }).join("");
}

/* =========================================
   Exam countdown
   ========================================= */
function examCountdownText(days) {
  if (days < 0) return "Finished";
  if (days === 0) return "Today! Good luck 🍀";
  if (days === 1) return "Tomorrow!";
  return `${days} days left`;
}

// Red = 3 days or less, orange = within a week, blue = later, gray = finished
function examColor(days) {
  if (days < 0) return "gray";
  if (days <= 3) return "red";
  if (days <= 7) return "orange";
  return "blue";
}

// Upcoming exams first (soonest first), finished exams at the end
function sortedExams() {
  return [...exams].sort((a, b) => {
    const da = daysUntil(a.date), db = daysUntil(b.date);
    if ((da < 0) !== (db < 0)) return da < 0 ? 1 : -1;
    if (da < 0) return b.date.localeCompare(a.date);
    return a.date.localeCompare(b.date) || (a.time || "").localeCompare(b.time || "");
  });
}

function formatTime(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
}

// Small countdown boxes on the dashboard
function renderExamCountdown() {
  const box = $("examCountdown");
  const upcoming = sortedExams().filter(x => daysUntil(x.date) >= 0).slice(0, 4);

  if (upcoming.length === 0) {
    box.innerHTML = `<p class="empty-msg">No upcoming exams. <button class="link-btn" data-goto="exams">Add one →</button></p>`;
    return;
  }

  box.innerHTML = upcoming.map(x => {
    const days = daysUntil(x.date);
    return `
      <div class="countdown-item">
        <div class="countdown-num ${examColor(days)}">
          <b>${days}</b>
          <small>${days === 1 ? "day" : "days"}</small>
        </div>
        <div class="up-info">
          <strong>${escapeHTML(x.name)}</strong>
          <span>${escapeHTML(x.subject)} · ${formatDate(x.date)}${x.time ? " · " + formatTime(x.time) : ""}</span>
        </div>
        ${days <= 1 ? `<span class="tag ${examColor(days)}">${days === 0 ? "Today" : "Tomorrow"}</span>` : ""}
      </div>`;
  }).join("");
}

// Full list on the Exams page
function renderExams() {
  const list = $("examList");
  if (exams.length === 0) {
    list.innerHTML = `<p class="empty-msg">No exams added yet.</p>`;
    return;
  }

  list.innerHTML = sortedExams().map(x => {
    const days = daysUntil(x.date);
    const color = examColor(days);
    return `
      <div class="exam-card ${color}">
        <div class="exam-days">
          <b>${days < 0 ? "✔" : days}</b>
          <small>${days < 0 ? "done" : days === 1 ? "day left" : "days left"}</small>
        </div>
        <div class="exam-info">
          <h4>${escapeHTML(x.name)}</h4>
          <span class="assign-subject">${escapeHTML(x.subject)}</span>
          <span class="exam-date">📅 ${formatDate(x.date)}${x.time ? " · 🕘 " + formatTime(x.time) : ""}</span>
          <span class="reminder ${color === "gray" ? "" : color}">${examCountdownText(days)}</span>
        </div>
        <button class="mini-btn del" data-id="${x.id}">Delete</button>
      </div>`;
  }).join("");
}

/* =========================================
   Quick notes
   ========================================= */
const NOTE_TYPES = {
  subject: { label: "Subject Note", icon: "📘" },
  reminder: { label: "Reminder", icon: "🔔" },
  topic: { label: "Exam Topic", icon: "🎯" }
};

function formatDateTime(iso) {
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function noteCard(n, short) {
  const type = NOTE_TYPES[n.category] || NOTE_TYPES.subject;
  const text = short && n.content.length > 90 ? n.content.slice(0, 90) + "…" : n.content;
  return `
    <div class="note-card ${n.category}">
      <div class="note-top">
        <span class="note-type">${type.icon} ${type.label}</span>
        ${short ? "" : `<button class="note-del" data-id="${n.id}" title="Delete note" aria-label="Delete note">🗑</button>`}
      </div>
      <h4>${escapeHTML(n.title)}</h4>
      <p>${escapeHTML(text)}</p>
      <div class="note-foot">
        ${n.subject ? `<span class="tag gray">${escapeHTML(n.subject)}</span>` : "<span></span>"}
        <small>${formatDateTime(n.createdAt)}</small>
      </div>
    </div>`;
}

// Newest notes first
function sortedNotes() {
  return [...notes].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function renderNotes() {
  const list = $("noteList");
  const search = noteSearch.toLowerCase();
  const items = sortedNotes().filter(n => {
    if (noteFilter !== "all" && n.category !== noteFilter) return false;
    if (!search) return true;
    return [n.title, n.subject, n.content].some(t => (t || "").toLowerCase().includes(search));
  });

  if (items.length === 0) {
    list.innerHTML = `<p class="empty-msg">${notes.length ? "No notes match your search." : "Your notebook is empty. Write your first note above!"}</p>`;
    return;
  }
  list.innerHTML = items.map(n => noteCard(n, false)).join("");
}

function renderRecentNotes() {
  const box = $("recentNotes");
  const recent = sortedNotes().slice(0, 3);
  if (recent.length === 0) {
    box.innerHTML = `<p class="empty-msg">No notes yet. <button class="link-btn" data-goto="notes">Write one →</button></p>`;
    return;
  }
  box.innerHTML = recent.map(n => noteCard(n, true)).join("");
}

/* =========================================
   Calendar
   ========================================= */
function renderCalendar() {
  const year = calDate.getFullYear();
  const month = calDate.getMonth();
  $("calTitle").textContent = calDate.toLocaleDateString("en-IN", { month: "long", year: "numeric" });

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = todayStr();

  let html = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    .map(d => `<div class="cal-dayname">${d}</div>`).join("");

  for (let i = 0; i < firstDay; i++) html += `<div class="cal-cell blank"></div>`;

  for (let day = 1; day <= daysInMonth; day++) {
    const str = toDateStr(new Date(year, month, day));
    const examEvents = exams.filter(x => x.date === str).map(x =>
      `<div class="cal-event exam" title="Exam: ${escapeHTML(x.name)} (${escapeHTML(x.subject)})">📝 ${escapeHTML(x.name)}</div>`
    ).join("");
    const events = examEvents + assignments.filter(a => a.deadline === str).map(a => {
      const st = getStatus(a);
      const cls = st === "completed" ? "done" : st === "overdue" ? "overdue" : "upcoming";
      return `<div class="cal-event ${cls}" title="${escapeHTML(a.name)} (${escapeHTML(a.subject)})">${escapeHTML(a.name)}</div>`;
    }).join("");

    html += `
      <div class="cal-cell ${str === today ? "today" : ""}">
        <span class="cal-num">${day}</span>
        ${events}
      </div>`;
  }

  $("calendar").innerHTML = html;
}

/* =========================================
   Student profile
   ========================================= */
function getInitials(name) {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0][0];
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase();
}

function ordinal(n) {
  return n + (n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th");
}

// Text like "B.Sc · 2nd Year · Sem 3"
function courseLine(u) {
  const parts = [];
  if (u.course) parts.push(u.course);
  if (u.year) parts.push(`${ordinal(u.year)} Year`);
  if (u.semester) parts.push(`Sem ${u.semester}`);
  return parts.join(" · ");
}

function renderProfile() {
  if (!user) return;
  const firstName = user.name.split(" ")[0];

  // Sidebar, top bar and greeting
  document.querySelectorAll(".js-initials").forEach(el => { el.textContent = getInitials(user.name); });
  $("sideName").textContent = user.name;
  $("sideCourse").textContent = courseLine(user) || "View profile";
  const hour = new Date().getHours();
  const greet = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  $("greeting").textContent = `${greet}, ${firstName} 👋`;

  // Profile summary card
  $("profName").textContent = user.name;
  $("profEmail").textContent = user.email;
  const tags = [];
  if (courseLine(user)) tags.push(`<span class="tag gray">${escapeHTML(courseLine(user))}</span>`);
  if (user.college) tags.push(`<span class="tag gray">🏫 ${escapeHTML(user.college)}</span>`);
  $("profTags").innerHTML = tags.join("");
  $("profSince").textContent = user.createdAt
    ? "Member since " + new Date(user.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })
    : "";

  const overall = getOverallAttendance();
  $("profAttendance").textContent = overall ? formatPercent(calculateAttendance(overall.total, overall.attended).percent) : "--";
  $("profSubjects").textContent = subjects.length;
  $("profDone").textContent = `${assignments.filter(a => a.completed).length}/${assignments.length}`;
}

// Put the saved details into the edit form
function fillProfileForm() {
  if (!user) return;
  $("pName").value = user.name || "";
  $("pEmail").value = user.email || "";
  $("pCollege").value = user.college || "";
  $("pCourse").value = user.course || "";
  $("pYear").value = user.year || "";
  $("pSemester").value = user.semester || "";
}

/* =========================================
   Render everything
   ========================================= */
function renderAll() {
  $("todayText").textContent = "📅 " + new Date().toLocaleDateString("en-IN", {
    weekday: "long", day: "numeric", month: "long", year: "numeric"
  });
  // Assignments and exams can only be added from today onwards
  $("asDeadline").min = todayStr();
  $("exDate").min = todayStr();

  renderAttendanceResult();
  renderSubjects();
  renderAssignments();
  renderExams();
  renderNotes();
  renderDashboard();
  renderCalendar();
  renderProfile();
}

/* =========================================
   Event listeners
   ========================================= */

// ---------- Navigation ----------
function showPage(name) {
  document.querySelectorAll(".page").forEach(p => p.classList.toggle("active", p.id === "page-" + name));
  document.querySelectorAll(".nav-link").forEach(l => l.classList.toggle("active", l.dataset.page === name));
  $("userChip").classList.toggle("active", name === "profile");
  closeSidebar();
  window.scrollTo(0, 0);
  if (name === "dashboard") renderDashboard(); // replay chart animations
  if (name === "profile") {
    renderProfile();
    fillProfileForm();
    $("profileError").textContent = "";
  }
}

document.querySelectorAll(".nav-link").forEach(link => {
  link.addEventListener("click", () => showPage(link.dataset.page));
});
// One listener for every "go to page" button, including ones added later
document.addEventListener("click", e => {
  const btn = e.target.closest("[data-goto]");
  if (btn) showPage(btn.dataset.goto);
});

// ---------- Mobile sidebar ----------
function closeSidebar() {
  $("sidebar").classList.remove("open");
  $("overlay").classList.remove("show");
}
$("menuBtn").addEventListener("click", () => {
  $("sidebar").classList.add("open");
  $("overlay").classList.add("show");
});
$("overlay").addEventListener("click", closeSidebar);

// ---------- Attendance calculator ----------
$("attendanceForm").addEventListener("submit", e => {
  e.preventDefault();
  const totalInput = $("totalClasses");
  const attendedInput = $("attendedClasses");
  const error = validateAttendance(totalInput.value.trim(), attendedInput.value.trim());

  totalInput.classList.toggle("invalid", !!error);
  attendedInput.classList.toggle("invalid", !!error);
  $("attendanceError").textContent = error;
  if (error) return;

  withBusy(e.submitter || $("attendanceForm").querySelector("[type=submit]"), async () => {
    try {
      attendance = await api("/attendance", "PUT", {
        total: Number(totalInput.value),
        attended: Number(attendedInput.value)
      });
      saveCache();
      renderAttendanceResult();
      renderDashboard();
      showToast("Attendance saved.");
    } catch (err) {
      $("attendanceError").textContent = err.message;
    }
  });
});

$("resetAttendance").addEventListener("click", async () => {
  try {
    await api("/attendance", "DELETE");
  } catch (err) {
    showToast(err.message);
    return;
  }
  attendance = null;
  saveCache();
  $("attendanceForm").reset();
  $("attendanceError").textContent = "";
  $("totalClasses").classList.remove("invalid");
  $("attendedClasses").classList.remove("invalid");
  renderAttendanceResult();
  renderDashboard();
  showToast("Attendance cleared.");
});

// ---------- Subjects ----------
$("subjectForm").addEventListener("submit", e => {
  e.preventDefault();
  const name = $("subName").value.trim();
  const totalValue = $("subTotal").value.trim();
  const attendedValue = $("subAttended").value.trim();

  let error = "";
  if (!name) error = "Please enter the subject name.";
  else if (subjects.some(s => s.name.toLowerCase() === name.toLowerCase())) error = "This subject is already added.";
  else if (totalValue === "" || attendedValue === "") error = "Please enter classes conducted and attended (use 0 if none yet).";
  else if (!isWholeNumber(totalValue) || !isWholeNumber(attendedValue)) error = "Please enter whole numbers only.";
  else if (Number(totalValue) > 5000) error = "Classes conducted looks too large. Please check the value.";
  else if (Number(attendedValue) > Number(totalValue)) error = "Classes attended cannot be more than classes conducted.";

  $("subjectError").textContent = error;
  if (error) return;

  withBusy(e.submitter || $("subjectForm").querySelector("[type=submit]"), async () => {
    try {
      const subject = await api("/subjects", "POST", {
        name,
        total: Number(totalValue),
        attended: Number(attendedValue)
      });
      subjects.push(subject);
      saveCache();
      $("subjectForm").reset();
      renderSubjects();
      renderDashboard();
      showToast(`${subject.name} added.`);
    } catch (err) {
      $("subjectError").textContent = err.message;
    }
  });
});

$("subjectTable").addEventListener("click", async e => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const subject = subjects.find(s => s.id === btn.dataset.id);
  if (!subject) return;

  try {
    btn.disabled = true; // stop double clicks while saving
    if (btn.dataset.action === "delete") {
      await api(`/subjects/${subject.id}`, "DELETE");
      subjects = subjects.filter(s => s.id !== subject.id);
      showToast(`${subject.name} deleted.`);
    } else {
      // "present" or "absent"
      const updated = await api(`/subjects/${subject.id}`, "PATCH", { action: btn.dataset.action });
      Object.assign(subject, updated);
    }
  } catch (err) {
    btn.disabled = false;
    showToast(err.message);
    return;
  }
  saveCache();
  renderSubjects();
  renderDashboard();
});

// ---------- Assignments ----------
$("assignmentForm").addEventListener("submit", e => {
  e.preventDefault();
  const name = $("asName").value.trim();
  const subject = $("asSubject").value.trim();
  const start = $("asStart").value;
  const deadline = $("asDeadline").value;

  const error = validateAssignment(name, subject, start, deadline);
  $("assignmentError").textContent = error;
  if (error) return;

  withBusy(e.submitter || $("assignmentForm").querySelector("[type=submit]"), async () => {
    try {
      const assignment = await api("/assignments", "POST", { name, subject, start, deadline });
      assignments.push(assignment);
      saveCache();
      $("assignmentForm").reset();
      $("asStart").value = todayStr();
      renderAll();
      showToast("Assignment added.");
    } catch (err) {
      $("assignmentError").textContent = err.message;
    }
  });
});

// Keep the deadline picker from going before the start date
$("asStart").addEventListener("change", () => {
  const start = $("asStart").value;
  $("asDeadline").min = start && start > todayStr() ? start : todayStr();
});

$("assignmentList").addEventListener("click", async e => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const item = assignments.find(a => a.id === btn.dataset.id);
  if (!item) return;

  try {
    if (btn.dataset.action === "toggle") {
      const updated = await api(`/assignments/${item.id}`, "PATCH", { completed: !item.completed });
      Object.assign(item, updated);
      showToast(item.completed ? "Marked as completed. Well done!" : "Marked as pending.");
    } else if (btn.dataset.action === "delete") {
      btn.disabled = true;
      await api(`/assignments/${item.id}`, "DELETE");
      assignments = assignments.filter(a => a.id !== item.id);
      showToast("Assignment deleted.");
    }
  } catch (err) {
    btn.disabled = false;
    showToast(err.message);
    return;
  }
  saveCache();
  renderAll();
});

$("filters").addEventListener("click", e => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  currentFilter = chip.dataset.filter;
  $("filters").querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c === chip));
  renderAssignments();
});

// ---------- Exams ----------
$("examForm").addEventListener("submit", e => {
  e.preventDefault();
  const exam = {
    name: $("exName").value.trim(),
    subject: $("exSubject").value.trim(),
    date: $("exDate").value,
    time: $("exTime").value
  };

  let error = "";
  if (!exam.name) error = "Please enter the exam name.";
  else if (!exam.subject) error = "Please enter the subject.";
  else if (!exam.date || !isValidDateStr(exam.date)) error = "Please choose a valid exam date.";
  else if (daysUntil(exam.date) < 0) error = "The exam date has already passed. Please choose today or a future date.";
  $("examError").textContent = error;
  if (error) return;

  withBusy(e.submitter || $("examForm").querySelector("[type=submit]"), async () => {
    try {
      exams.push(await api("/exams", "POST", exam));
      saveCache();
      $("examForm").reset();
      renderExams();
      renderDashboard();
      renderCalendar();
      const days = daysUntil(exam.date);
      showToast(`Exam added – ${examCountdownText(days).toLowerCase()}.`);
    } catch (err) {
      $("examError").textContent = err.message;
    }
  });
});

$("examList").addEventListener("click", async e => {
  const btn = e.target.closest("button[data-id]");
  if (!btn) return;
  const exam = exams.find(x => x.id === btn.dataset.id);
  if (!exam) return;
  btn.disabled = true;
  try {
    await api(`/exams/${exam.id}`, "DELETE");
  } catch (err) {
    btn.disabled = false;
    showToast(err.message);
    return;
  }
  exams = exams.filter(x => x.id !== exam.id);
  saveCache();
  renderExams();
  renderDashboard();
  renderCalendar();
  showToast("Exam deleted.");
});

// ---------- Quick notes ----------
$("noteContent").addEventListener("input", () => {
  $("noteCount").textContent = `${$("noteContent").value.length} / 1000`;
});

$("noteForm").addEventListener("submit", e => {
  e.preventDefault();
  const note = {
    title: $("noteTitle").value.trim(),
    category: $("noteCategory").value,
    subject: $("noteSubject").value.trim(),
    content: $("noteContent").value.trim()
  };

  let error = "";
  if (!note.title) error = "Please enter a title for the note.";
  else if (!note.content) error = "Please write something in the note.";
  $("noteError").textContent = error;
  if (error) return;

  withBusy(e.submitter || $("noteForm").querySelector("[type=submit]"), async () => {
    try {
      notes.push(await api("/notes", "POST", note));
      saveCache();
      $("noteForm").reset();
      $("noteCount").textContent = "0 / 1000";
      renderNotes();
      renderRecentNotes();
      showToast("Note saved.");
    } catch (err) {
      $("noteError").textContent = err.message;
    }
  });
});

$("noteList").addEventListener("click", async e => {
  const btn = e.target.closest(".note-del");
  if (!btn) return;
  const note = notes.find(n => n.id === btn.dataset.id);
  if (!note) return;
  btn.disabled = true;
  try {
    await api(`/notes/${note.id}`, "DELETE");
  } catch (err) {
    btn.disabled = false;
    showToast(err.message);
    return;
  }
  notes = notes.filter(n => n.id !== note.id);
  saveCache();
  renderNotes();
  renderRecentNotes();
  showToast("Note deleted.");
});

$("noteFilters").addEventListener("click", e => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  noteFilter = chip.dataset.filter;
  $("noteFilters").querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c === chip));
  renderNotes();
});

$("noteSearch").addEventListener("input", () => {
  noteSearch = $("noteSearch").value.trim();
  renderNotes();
});

// ---------- Calendar ----------
$("prevMonth").addEventListener("click", () => {
  calDate = new Date(calDate.getFullYear(), calDate.getMonth() - 1, 1);
  renderCalendar();
});
$("nextMonth").addEventListener("click", () => {
  calDate = new Date(calDate.getFullYear(), calDate.getMonth() + 1, 1);
  renderCalendar();
});

// ---------- Profile ----------
// Change password popup
function openPasswordModal() {
  $("passwordForm").reset();
  $("passwordError").textContent = "";
  $("passwordModal").hidden = false;
  $("curPass").focus();
}
function closePasswordModal() {
  $("passwordModal").hidden = true;
  $("passwordForm").reset();
}
$("openPasswordBtn").addEventListener("click", openPasswordModal);
$("closePasswordBtn").addEventListener("click", closePasswordModal);
$("passwordModal").addEventListener("click", e => {
  if (e.target === $("passwordModal")) closePasswordModal(); // click outside the box
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && !$("passwordModal").hidden) closePasswordModal();
});

$("profileForm").addEventListener("submit", e => {
  e.preventDefault();
  const details = {
    name: $("pName").value.trim(),
    college: $("pCollege").value.trim(),
    course: $("pCourse").value.trim(),
    year: $("pYear").value,
    semester: $("pSemester").value
  };

  let error = "";
  if (!details.name) error = "Please enter your full name.";
  $("profileError").textContent = error;
  if (error) return;

  withBusy(e.submitter || $("profileForm").querySelector("[type=submit]"), async () => {
    try {
      user = await api("/profile", "PUT", details);
      saveCache();
      renderProfile();
      fillProfileForm();
      showToast("Profile updated.");
    } catch (err) {
      $("profileError").textContent = err.message;
    }
  });
});

$("passwordForm").addEventListener("submit", e => {
  e.preventDefault();
  const currentPassword = $("curPass").value;
  const newPassword = $("newPass").value;

  let error = "";
  if (!currentPassword) error = "Please enter your current password.";
  else if (newPassword.length < 6) error = "New password must be at least 6 characters.";
  else if (newPassword !== $("newPass2").value) error = "New passwords do not match.";
  else if (newPassword === currentPassword) error = "New password must be different from the current one.";
  $("passwordError").textContent = error;
  if (error) return;

  withBusy(e.submitter || $("passwordForm").querySelector("[type=submit]"), async () => {
    try {
      await api("/profile/password", "PUT", { currentPassword, newPassword });
      closePasswordModal();
      showToast("Password changed.");
    } catch (err) {
      $("passwordError").textContent = err.message;
    }
  });
});

$("logoutBtn").addEventListener("click", logout);
$("sideLogout").addEventListener("click", logout);

// Delete account popup (asks for the password, because this can't be undone)
function closeDeleteModal() {
  $("deleteModal").hidden = true;
  $("deleteForm").reset();
}
$("deleteAccountBtn").addEventListener("click", () => {
  $("deleteForm").reset();
  $("deleteError").textContent = "";
  $("deleteModal").hidden = false;
  $("deletePass").focus();
});
$("closeDeleteBtn").addEventListener("click", closeDeleteModal);
$("cancelDeleteBtn").addEventListener("click", closeDeleteModal);
$("deleteModal").addEventListener("click", e => {
  if (e.target === $("deleteModal")) closeDeleteModal(); // click outside the box
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && !$("deleteModal").hidden) closeDeleteModal();
});

$("deleteForm").addEventListener("submit", e => {
  e.preventDefault();
  const password = $("deletePass").value;
  if (!password) { $("deleteError").textContent = "Please enter your password."; return; }

  withBusy(e.submitter || $("deleteForm").querySelector("[type=submit]"), async () => {
    try {
      await api("/profile", "DELETE", { password });
      clearLogin();
      location.replace("login.html?deleted=1");
    } catch (err) {
      $("deleteError").textContent = err.message;
    }
  });
});

// ---------- Auto-update reminders when the date changes ----------
function checkForNewDay() {
  if (todayStr() !== lastRenderedDay) {
    lastRenderedDay = todayStr();
    renderAll();
  }
}
setInterval(checkForNewDay, 60 * 1000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) checkForNewDay();
});

/* =========================================
   Start the app
   ========================================= */
async function start() {
  $("asStart").value = todayStr();
  renderAll(); // show the empty layout straight away
  await loadData();
  if (attendance) {
    $("totalClasses").value = attendance.total;
    $("attendedClasses").value = attendance.attended;
  }
  renderAll();
}
start();
