/* =========================================
   StudySync – Login & Register page
   ========================================= */

// Use the local server when login.html is opened straight from disk
const API_URL = location.protocol === "file:" ? "http://localhost:3000/api" : "/api";
const TOKEN_KEY = "studysync_token";
const MIN_PASSWORD = 6;

function $(id) { return document.getElementById(id); }

function getToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
}

function saveToken(token) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    return true;
  } catch (e) {
    return false;
  }
}

// Only Gmail addresses are allowed.
// Gmail usernames: 6–30 letters, numbers or dots (not at the start/end, no "..")
function isGmail(email) {
  return /^[a-z0-9](?:[a-z0-9]|\.(?!\.)){4,28}[a-z0-9]@gmail\.com$/.test(email);
}
const GMAIL_ERROR = "Please enter a valid Gmail address (example: yourname@gmail.com).";

// Send login/register details to the server
async function sendAuth(path, body) {
  let response;
  try {
    response = await fetch(API_URL + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (e) {
    throw new Error("Cannot reach the server. Please check your internet connection and try again.");
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error((data && data.error) || "Something went wrong.");
  return data;
}

function goToDashboard(token) {
  if (!saveToken(token)) {
    showToast("Your browser is blocking storage, so you can't stay logged in. Please allow site data for this page.");
    return;
  }
  location.replace("dashboard.html");
}

/* ---------- Tabs ---------- */
function showTab(name) {
  document.querySelectorAll(".auth-tab").forEach(t => t.classList.toggle("active", t.dataset.tab === name));
  $("loginForm").hidden = name !== "login";
  $("registerForm").hidden = name !== "register";
  $("verifyForm").hidden = true;
  $("loginError").textContent = "";
  $("registerError").textContent = "";
}

document.querySelectorAll("[data-tab]").forEach(btn => {
  btn.addEventListener("click", () => showTab(btn.dataset.tab));
});

/* ---------- Show / hide password ---------- */
document.querySelectorAll(".show-pass").forEach(btn => {
  btn.addEventListener("click", () => {
    const input = $(btn.dataset.target);
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    btn.textContent = show ? "Hide" : "Show";
  });
});

/* ---------- Login ---------- */
$("loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  const email = $("loginEmail").value.trim().toLowerCase();
  const password = $("loginPassword").value;
  const errorBox = $("loginError");

  if (!email || !password) { errorBox.textContent = "Please enter your Gmail address and password."; return; }
  if (!isGmail(email)) { errorBox.textContent = GMAIL_ERROR; return; }

  const button = e.submitter || e.target.querySelector("[type=submit]");
  button.disabled = true;
  errorBox.textContent = "";
  try {
    const { token } = await sendAuth("/auth/login", { email, password });
    goToDashboard(token);
  } catch (err) {
    errorBox.textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

/* ---------- Register ---------- */
$("registerForm").addEventListener("submit", async e => {
  e.preventDefault();
  const details = {
    name: $("regName").value.trim(),
    email: $("regEmail").value.trim().toLowerCase(),
    course: $("regCourse").value.trim(),
    year: $("regYear").value,
    college: $("regCollege").value.trim(),
    password: $("regPassword").value
  };
  const confirm = $("regConfirm").value;
  const errorBox = $("registerError");

  let error = "";
  if (!details.name) error = "Please enter your full name.";
  else if (!isGmail(details.email)) error = GMAIL_ERROR;
  else if (details.password.length < MIN_PASSWORD) error = `Password must be at least ${MIN_PASSWORD} characters.`;
  else if (details.password !== confirm) error = "Passwords do not match.";
  errorBox.textContent = error;
  if (error) return;

  const button = e.submitter || e.target.querySelector("[type=submit]");
  button.disabled = true;
  button.textContent = "Sending code…";
  try {
    // Step 1: the server emails a 6-digit code (no account yet)
    await sendAuth("/auth/register/start", details);
    showVerifyStep(details.email);
  } catch (err) {
    errorBox.textContent = err.message;
  } finally {
    button.disabled = false;
    button.textContent = "Send Verification Code";
  }
});

/* ---------- Verify email code ---------- */
const RESEND_SECONDS = 60;
let pendingEmail = "";
let resendTimer = null;

function showVerifyStep(email) {
  pendingEmail = email;
  $("registerForm").hidden = true;
  $("verifyForm").hidden = false;
  $("verifyEmail").textContent = email;
  $("verifyCode").value = "";
  $("verifyError").textContent = "";
  $("verifyCode").focus();
  startResendCountdown();
}

// Disable "Resend code" for 60 seconds
function startResendCountdown() {
  const btn = $("resendBtn");
  let left = RESEND_SECONDS;
  clearInterval(resendTimer);
  btn.disabled = true;
  btn.textContent = `Resend code (${left}s)`;
  resendTimer = setInterval(() => {
    left--;
    if (left <= 0) {
      clearInterval(resendTimer);
      btn.disabled = false;
      btn.textContent = "Resend code";
    } else {
      btn.textContent = `Resend code (${left}s)`;
    }
  }, 1000);
}

// Only allow digits in the code box
$("verifyCode").addEventListener("input", () => {
  $("verifyCode").value = $("verifyCode").value.replace(/\D/g, "").slice(0, 6);
});

$("verifyForm").addEventListener("submit", async e => {
  e.preventDefault();
  const code = $("verifyCode").value.trim();
  const errorBox = $("verifyError");
  if (!/^\d{6}$/.test(code)) { errorBox.textContent = "Please enter the 6-digit code from your email."; return; }

  const button = e.submitter || e.target.querySelector("[type=submit]");
  button.disabled = true;
  errorBox.textContent = "";
  try {
    // Step 2: correct code -> account is created and we are logged in
    const { token } = await sendAuth("/auth/register/verify", { email: pendingEmail, code });
    goToDashboard(token);
  } catch (err) {
    errorBox.textContent = err.message;
    $("verifyCode").select();
  } finally {
    button.disabled = false;
  }
});

$("resendBtn").addEventListener("click", async () => {
  $("verifyError").textContent = "";
  $("resendBtn").disabled = true;
  try {
    const { message } = await sendAuth("/auth/register/resend", { email: pendingEmail });
    showToast(message);
    startResendCountdown();
  } catch (err) {
    $("verifyError").textContent = err.message;
    $("resendBtn").disabled = false;
  }
});

$("changeEmailBtn").addEventListener("click", () => {
  clearInterval(resendTimer);
  $("verifyForm").hidden = true;
  $("registerForm").hidden = false;
  $("regEmail").focus();
});

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 3000);
}

// "Forgot password?" takes the typed email along to the reset page
$("forgotLink").addEventListener("click", e => {
  const email = $("loginEmail").value.trim().toLowerCase();
  if (email) {
    e.preventDefault();
    location.href = "reset-password.html?email=" + encodeURIComponent(email);
  }
});

const params = new URLSearchParams(location.search);
// Open the Register tab when coming from "Register" on the home page (login.html?tab=register)
if (params.get("tab") === "register") showTab("register");
// Coming back from the reset page after a successful reset
if (params.get("reset") === "1") {
  $("loginSuccess").textContent = "✅ Your password has been reset. Please log in with your new password.";
  $("loginSuccess").hidden = false;
  if (params.get("email")) $("loginEmail").value = params.get("email");
  $("loginPassword").focus();
}
// Coming from "Delete Account"
if (params.get("deleted") === "1") {
  $("loginSuccess").textContent = "Your account and all its data have been deleted.";
  $("loginSuccess").hidden = false;
}

/* ---------- Already logged in? Go straight to the dashboard ---------- */
(async function checkExistingLogin() {
  const token = getToken();
  if (!token) return;
  try {
    const response = await fetch(API_URL + "/profile", { headers: { Authorization: "Bearer " + token } });
    if (response.ok) location.replace("dashboard.html");
  } catch (e) { /* server offline – stay on the login page */ }
})();
