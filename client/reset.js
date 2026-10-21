/* =========================================
   StudySync – Reset Password page
   Step 1: email → server sends a 6-digit code
   Step 2: code + new password → password is changed
   ========================================= */

// Use the local server when the page is opened straight from disk
const API_URL = location.protocol === "file:" ? "http://localhost:3000/api" : "/api";
const MIN_PASSWORD = 6;
const RESEND_SECONDS = 60;

let resetEmail = "";
let resendTimer = null;

function $(id) { return document.getElementById(id); }

// Gmail usernames: 6–30 letters, numbers or dots (not at the start/end, no "..")
function isGmail(email) {
  return /^[a-z0-9](?:[a-z0-9]|\.(?!\.)){4,28}[a-z0-9]@gmail\.com$/.test(email);
}

async function post(path, body) {
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

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 3000);
}

function submitButton(e) {
  return e.submitter || e.target.querySelector("[type=submit]");
}

/* ---------- Step 1: send code ---------- */
$("emailForm").addEventListener("submit", async e => {
  e.preventDefault();
  const email = $("resetEmail").value.trim().toLowerCase();
  const errorBox = $("emailError");

  if (!isGmail(email)) {
    errorBox.textContent = "Please enter a valid Gmail address (example: yourname@gmail.com).";
    return;
  }

  const button = submitButton(e);
  button.disabled = true;
  button.textContent = "Sending code…";
  errorBox.textContent = "";
  try {
    await post("/auth/forgot", { email });
    showCodeStep(email);
  } catch (err) {
    errorBox.textContent = err.message;
  } finally {
    button.disabled = false;
    button.textContent = "Send Reset Code";
  }
});

function showCodeStep(email) {
  resetEmail = email;
  $("emailForm").hidden = true;
  $("resetForm").hidden = false;
  $("sentTo").textContent = email;
  $("resetForm").reset();
  $("resetError").textContent = "";
  $("resetCode").focus();
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

/* ---------- Step 2: new password ---------- */
// Only allow digits in the code box
$("resetCode").addEventListener("input", () => {
  $("resetCode").value = $("resetCode").value.replace(/\D/g, "").slice(0, 6);
});

$("resetForm").addEventListener("submit", async e => {
  e.preventDefault();
  const code = $("resetCode").value.trim();
  const newPassword = $("newPassword").value;
  const errorBox = $("resetError");

  let error = "";
  if (!/^\d{6}$/.test(code)) error = "Please enter the 6-digit code from your email.";
  else if (newPassword.length < MIN_PASSWORD) error = `Password must be at least ${MIN_PASSWORD} characters.`;
  else if (newPassword !== $("confirmPassword").value) error = "Passwords do not match.";
  errorBox.textContent = error;
  if (error) return;

  const button = submitButton(e);
  button.disabled = true;
  try {
    await post("/auth/reset", { email: resetEmail, code, newPassword });
    clearInterval(resendTimer);
    // Old logins on this browser are no longer valid
    try { localStorage.removeItem("studysync_token"); localStorage.removeItem("studysync_cache"); } catch (err) { /* ignore */ }
    location.replace("login.html?reset=1&email=" + encodeURIComponent(resetEmail));
  } catch (err) {
    errorBox.textContent = err.message;
    $("resetCode").select();
  } finally {
    button.disabled = false;
  }
});

$("resendBtn").addEventListener("click", async () => {
  $("resetError").textContent = "";
  $("resendBtn").disabled = true;
  try {
    await post("/auth/forgot", { email: resetEmail });
    showToast(`A new code was sent to ${resetEmail}.`);
    startResendCountdown();
  } catch (err) {
    $("resetError").textContent = err.message;
    $("resendBtn").disabled = false;
  }
});

$("changeEmailBtn").addEventListener("click", () => {
  clearInterval(resendTimer);
  $("resetForm").hidden = true;
  $("emailForm").hidden = false;
  $("resetEmail").focus();
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

// Email typed on the login page comes along as ?email=...
const startEmail = new URLSearchParams(location.search).get("email");
if (startEmail) $("resetEmail").value = startEmail;
