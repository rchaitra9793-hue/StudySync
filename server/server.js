/* =========================================
   StudySync – Backend Server
   Node.js + Express
   Data: MongoDB when deployed, data/db.json on your own computer (see store.js)
   ========================================= */

const express = require("express");
const nodemailer = require("nodemailer");
const path = require("path");
const crypto = require("crypto");

// Load settings (database, email login, ...) from server/.env if it exists
try {
  process.loadEnvFile(path.join(__dirname, ".env"));
} catch (e) { /* no .env file – use defaults */ }

const { createStore, withDefaults } = require("./store");

const app = express();
const store = createStore();
const PORT = process.env.PORT || 3000;
const CLIENT_DIR = path.join(__dirname, "..", "client");
const SESSION_DAYS = 7; // how long a login stays valid

// Lets route handlers be async: any error goes to the error handler at the bottom
const route = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function makeId() {
  return crypto.randomUUID();
}

/* =========================================
   Password & login helpers
   ========================================= */
// scrypt is slow on purpose (to stop password guessing), so it runs in the
// background with a promise instead of blocking the whole server
function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, key) => {
      if (err) reject(err);
      else resolve({ salt, hash: key.toString("hex") });
    });
  });
}

async function checkPassword(password, user) {
  if (!user || typeof password !== "string") return false;
  const { hash } = await hashPassword(password, user.salt);
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(user.passwordHash || "", "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Only the hash of a login token is stored, so leaked data can't be used to log in
function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// Create a new login session and return its token
async function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  await store.addSession({
    tokenHash: hashToken(token),
    userId,
    expiresAt: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000
  });
  return token;
}

// Never send the password hash to the browser
function publicUser(user) {
  const { passwordHash, salt, ...rest } = user;
  return rest;
}

// Middleware: only let logged-in students through
const requireAuth = route(async (req, res, next) => {
  const header = req.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Please log in." });

  const tokenHash = hashToken(token);
  const session = await store.getSession(tokenHash);
  const user = session && session.expiresAt > Date.now() ? await store.getUserById(session.userId) : null;
  if (!user) {
    return res.status(401).json({ error: "Your session has expired. Please log in again." });
  }

  req.user = user;
  req.userId = user.id;
  req.tokenHash = tokenHash;
  next();
});

// Slow down password guessing: after 10 wrong passwords an email is locked for 15 minutes
const MAX_LOGIN_FAILS = 10;
const LOCK_MINUTES = 15;
const failedLogins = new Map(); // email -> { count, lockedUntil }

function loginLockMinutes(email) {
  const entry = failedLogins.get(email);
  if (!entry || !entry.lockedUntil) return 0;
  const left = entry.lockedUntil - Date.now();
  if (left <= 0) { failedLogins.delete(email); return 0; }
  return Math.ceil(left / 60000);
}

function recordFailedLogin(email) {
  const entry = failedLogins.get(email) || { count: 0, lockedUntil: 0 };
  entry.count++;
  if (entry.count >= MAX_LOGIN_FAILS) {
    entry.count = 0;
    entry.lockedUntil = Date.now() + LOCK_MINUTES * 60 * 1000;
  }
  failedLogins.set(email, entry);
}

/* =========================================
   Email (6-digit codes for registration and password reset)

   Ways to send, picked automatically:
   1. Brevo   – set BREVO_API_KEY and EMAIL_FROM (works on Render's free plan)
   2. Gmail   – set SMTP_USER and SMTP_PASS (works on your own computer)
   3. Neither – the code is printed in the server terminal (for testing)
   ========================================= */
const CODE_MINUTES = 10;   // code is valid for 10 minutes
const RESEND_SECONDS = 60; // wait before asking for a new code
const MAX_CODE_TRIES = 5;  // wrong guesses allowed

const EMAIL_FROM = process.env.EMAIL_FROM || process.env.SMTP_USER || "";
const EMAIL_METHOD = process.env.BREVO_API_KEY ? "brevo"
  : process.env.SMTP_USER && process.env.SMTP_PASS ? "gmail"
  : "none";

const gmail = EMAIL_METHOD === "gmail"
  ? nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    })
  : null;

async function sendEmail({ to, subject, text, html }) {
  if (EMAIL_METHOD === "brevo") {
    // Brevo's web API uses normal HTTPS, which hosting sites don't block
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": process.env.BREVO_API_KEY,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        sender: { name: "StudySync", email: EMAIL_FROM },
        to: [{ email: to }],
        subject,
        textContent: text,
        htmlContent: html
      })
    });
    if (!response.ok) throw new Error(`Brevo error ${response.status}: ${await response.text()}`);
    return;
  }
  if (EMAIL_METHOD === "gmail") {
    await gmail.sendMail({ from: `"StudySync" <${EMAIL_FROM}>`, to, subject, text, html });
    return;
  }
  // Email not set up yet: show the code in this terminal so you can still test
  console.log(`\n[Email not set up] To: ${to} | ${subject}\n`);
}

function makeCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

// Codes are stored hashed, like passwords
function hashCode(email, code) {
  return crypto.createHash("sha256").update(email + ":" + code).digest("hex");
}

function escapeHTML(text) {
  return String(text).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const CODE_EMAILS = {
  register: {
    subject: code => `${code} is your StudySync verification code`,
    intro: "Use this code to verify your email and finish creating your account:",
    ignore: "If you didn't try to register, you can ignore this email."
  },
  reset: {
    subject: code => `${code} is your StudySync password reset code`,
    intro: "Use this code to reset your StudySync password:",
    ignore: "If you didn't ask to reset your password, you can ignore this email. Your password won't change."
  }
};

function sendCodeEmail(purpose, to, name, code) {
  const t = CODE_EMAILS[purpose];
  return sendEmail({
    to,
    subject: t.subject(code),
    text: `Hi ${name},\n\n${t.intro} ${code}\n\nIt expires in ${CODE_MINUTES} minutes.\n${t.ignore}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:460px;margin:auto;padding:24px;border:1px solid #e5e7eb;border-radius:12px">
        <h2 style="color:#4f46e5;margin:0 0 12px">StudySync</h2>
        <p>Hi ${escapeHTML(name)},</p>
        <p>${t.intro}</p>
        <p style="font-size:32px;font-weight:bold;letter-spacing:8px;text-align:center;background:#eef2ff;padding:14px;border-radius:10px">${code}</p>
        <p style="color:#6b7280;font-size:13px">It expires in ${CODE_MINUTES} minutes. ${t.ignore}</p>
      </div>`
  });
}

// Seconds left before a new code may be sent (0 = can send now)
function resendWait(entry) {
  if (!entry || entry.expiresAt <= Date.now()) return 0;
  return Math.max(0, Math.ceil((entry.sentAt + RESEND_SECONDS * 1000 - Date.now()) / 1000));
}

// Email a new code and remember it. Returns an error message, or "" when sent.
async function issueCode(purpose, email, name, extra = {}) {
  const code = makeCode();
  try {
    await sendCodeEmail(purpose, email, name, code);
  } catch (err) {
    console.error("Email error:", err.message);
    return "Could not send the email. Please check the address and try again.";
  }
  if (EMAIL_METHOD === "none") console.log(`[Email not set up] ${purpose} code for ${email}: ${code}\n`);

  await store.saveCode({
    ...extra,
    purpose,
    email,
    codeHash: hashCode(email, code),
    expiresAt: Date.now() + CODE_MINUTES * 60 * 1000,
    attempts: 0,
    sentAt: Date.now()
  });
  return "";
}

// Check a code the student typed in. Returns { entry } when correct, otherwise { status, error }
async function checkCode(purpose, email, code, startAgain) {
  if (!/^\d{6}$/.test(code)) return { status: 400, error: "Please enter the 6-digit code from your email." };

  const entry = await store.getCode(purpose, email);
  if (!entry) return { status: 404, error: `This code has expired or was already used. ${startAgain}` };
  if (entry.expiresAt <= Date.now()) {
    return { status: 400, error: "This code has expired. Click \"Resend code\" to get a new one." };
  }
  if (entry.codeHash !== hashCode(email, code)) {
    const attempts = (entry.attempts || 0) + 1;
    if (attempts >= MAX_CODE_TRIES) {
      await store.deleteCode(purpose, email);
      return { status: 429, error: `Too many wrong codes. ${startAgain}` };
    }
    await store.saveCode({ ...entry, attempts });
    const left = MAX_CODE_TRIES - attempts;
    return { status: 400, error: `Incorrect code. ${left} attempt${left === 1 ? "" : "s"} left.` };
  }
  return { entry };
}

/* =========================================
   Validation helpers (same rules as the website)
   ========================================= */
const MAX_CLASSES = 5000;
const MIN_PASSWORD = 6;

function isWholeNumber(value) {
  return Number.isInteger(value) && value >= 0;
}

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function cleanEmail(value) {
  return cleanText(value, 100).toLowerCase();
}

// Only Gmail addresses are allowed.
// Gmail usernames: 6–30 letters, numbers or dots (not at the start/end, no "..")
function isGmail(email) {
  return /^[a-z0-9](?:[a-z0-9]|\.(?!\.)){4,28}[a-z0-9]@gmail\.com$/.test(email);
}
const GMAIL_ERROR = "Please enter a valid Gmail address (example: yourname@gmail.com).";

// Today's date as YYYY-MM-DD in India time, even when the host's clock is UTC
const APP_TIMEZONE = process.env.APP_TIMEZONE || "Asia/Kolkata";
function todayStr() {
  // "en-CA" formats dates as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone: APP_TIMEZONE }).format(new Date());
}

function isValidDateStr(str) {
  if (typeof str !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const [y, m, d] = str.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

function validateClasses(total, attended, minTotal) {
  if (!isWholeNumber(total) || !isWholeNumber(attended)) return "Classes must be whole numbers (no decimals or negative values).";
  if (total < minTotal) return `Total classes conducted must be at least ${minTotal}.`;
  if (total > MAX_CLASSES) return "Total classes looks too large. Please check the value.";
  if (attended > total) return "Classes attended cannot be more than classes conducted.";
  return "";
}

function validatePassword(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) {
    return `Password must be at least ${MIN_PASSWORD} characters.`;
  }
  if (password.length > 100) return "Password is too long.";
  return "";
}

// Check and clean the optional profile fields. Returns { error } or { profile }
function readProfileFields(body) {
  const profile = {
    college: cleanText(body.college, 80),
    course: cleanText(body.course, 60),
    year: body.year === "" || body.year == null ? null : Number(body.year),
    semester: body.semester === "" || body.semester == null ? null : Number(body.semester)
  };

  if (profile.year !== null && !(Number.isInteger(profile.year) && profile.year >= 1 && profile.year <= 4)) {
    return { error: "Year must be between 1 and 4." };
  }
  if (profile.semester !== null && !(Number.isInteger(profile.semester) && profile.semester >= 1 && profile.semester <= 8)) {
    return { error: "Semester must be between 1 and 8." };
  }
  return { profile };
}

/* =========================================
   Middleware
   ========================================= */
app.set("trust proxy", 1); // running behind Render's proxy
app.use(express.json({ limit: "100kb" }));

// Allow the website to call the API even when a page is opened directly from disk
app.use("/api", (req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Cache-Control", "no-store"); // never cache personal data
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Serve the website (client folder)
app.use(express.static(CLIENT_DIR));

/* =========================================
   API routes
   ========================================= */

// Health check (Render uses this to see that the app is running)
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

/* ---------- Register (step 1: send code, step 2: verify code) ---------- */
// Step 1: check the details and email a 6-digit code. No account is created yet.
app.post("/api/auth/register/start", route(async (req, res) => {
  const name = cleanText(req.body.name, 50);
  const email = cleanEmail(req.body.email);
  const { password } = req.body;

  if (!name) return res.status(400).json({ error: "Please enter your full name." });
  if (!isGmail(email)) return res.status(400).json({ error: GMAIL_ERROR });
  const passwordError = validatePassword(password);
  if (passwordError) return res.status(400).json({ error: passwordError });
  const { error, profile } = readProfileFields(req.body);
  if (error) return res.status(400).json({ error });

  if (await store.getUserByEmail(email)) {
    return res.status(409).json({ error: "An account with this email already exists. Please log in." });
  }
  const wait = resendWait(await store.getCode("register", email));
  if (wait > 0) return res.status(429).json({ error: `Please wait ${wait} seconds before requesting a new code.` });

  const { salt, hash } = await hashPassword(password);
  const sendError = await issueCode("register", email, name, { name, ...profile, passwordHash: hash, salt });
  if (sendError) return res.status(502).json({ error: sendError });
  res.json({ message: `We sent a 6-digit code to ${email}.`, email });
}));

// Send a new code for a registration that is still waiting
app.post("/api/auth/register/resend", route(async (req, res) => {
  const email = cleanEmail(req.body.email);
  const pending = await store.getCode("register", email);
  if (!pending || pending.expiresAt <= Date.now()) {
    return res.status(404).json({ error: "Your registration has expired. Please register again." });
  }
  const wait = resendWait(pending);
  if (wait > 0) return res.status(429).json({ error: `Please wait ${wait} seconds before requesting a new code.` });

  const { purpose, codeHash, expiresAt, attempts, sentAt, ...details } = pending;
  const sendError = await issueCode("register", email, pending.name, details);
  if (sendError) return res.status(502).json({ error: sendError });
  res.json({ message: `A new code was sent to ${email}.` });
}));

// Step 2: check the code and create the account
app.post("/api/auth/register/verify", route(async (req, res) => {
  const email = cleanEmail(req.body.email);
  const code = String(req.body.code || "").trim();

  const result = await checkCode("register", email, code, "Please register again.");
  if (result.error) return res.status(result.status).json({ error: result.error });

  await store.deleteCode("register", email);
  if (await store.getUserByEmail(email)) {
    return res.status(409).json({ error: "An account with this email already exists. Please log in." });
  }

  // Code is correct: create the account
  const { purpose, codeHash, expiresAt, attempts, sentAt, ...details } = result.entry;
  const user = {
    id: makeId(),
    ...details, // name, email, profile and password hash from step 1
    emailVerified: true,
    createdAt: new Date().toISOString()
  };

  // Give data saved before logins existed to the very first student (local db.json only)
  if ((await store.countUsers()) === 0) {
    const legacy = await store.takeLegacyData();
    if (legacy) await store.saveData(user.id, withDefaults(legacy));
  }

  await store.addUser(user);
  const token = await createSession(user.id);
  res.status(201).json({ token, user: publicUser(user) });
}));

/* ---------- Login / Logout ---------- */
app.post("/api/auth/login", route(async (req, res) => {
  const email = cleanEmail(req.body.email);
  const { password } = req.body;
  if (!email || typeof password !== "string" || !password) {
    return res.status(400).json({ error: "Please enter your Gmail address and password." });
  }
  if (!isGmail(email)) return res.status(400).json({ error: GMAIL_ERROR });

  const locked = loginLockMinutes(email);
  if (locked) {
    return res.status(429).json({ error: `Too many wrong passwords. Try again in ${locked} minute${locked === 1 ? "" : "s"}, or reset your password.` });
  }

  const user = await store.getUserByEmail(email);
  // Only registered emails can log in
  if (!user) {
    return res.status(404).json({ error: "No account found with this email. Please register first." });
  }
  if (!(await checkPassword(password, user))) {
    recordFailedLogin(email);
    return res.status(401).json({ error: "Incorrect password. Please try again." });
  }

  failedLogins.delete(email);
  const token = await createSession(user.id);
  res.json({ token, user: publicUser(user) });
}));

app.post("/api/auth/logout", requireAuth, route(async (req, res) => {
  await store.deleteSession(req.tokenHash);
  res.sendStatus(204);
}));

/* ---------- Forgot password (step 1: email a code, step 2: set new password) ---------- */
app.post("/api/auth/forgot", route(async (req, res) => {
  const email = cleanEmail(req.body.email);
  if (!isGmail(email)) return res.status(400).json({ error: GMAIL_ERROR });

  const user = await store.getUserByEmail(email);
  if (!user) {
    return res.status(404).json({ error: "No account found with this email. Please register first." });
  }
  const wait = resendWait(await store.getCode("reset", email));
  if (wait > 0) return res.status(429).json({ error: `Please wait ${wait} seconds before requesting a new code.` });

  const sendError = await issueCode("reset", email, user.name);
  if (sendError) return res.status(502).json({ error: sendError });
  res.json({ message: `We sent a 6-digit code to ${email}.`, email });
}));

app.post("/api/auth/reset", route(async (req, res) => {
  const email = cleanEmail(req.body.email);
  const code = String(req.body.code || "").trim();
  const { newPassword } = req.body;

  const passwordError = validatePassword(newPassword);
  if (passwordError) return res.status(400).json({ error: passwordError });

  const result = await checkCode("reset", email, code, "Please request a new code.");
  if (result.error) return res.status(result.status).json({ error: result.error });

  const user = await store.getUserByEmail(email);
  await store.deleteCode("reset", email);
  if (!user) return res.status(404).json({ error: "No account found with this email." });

  const { salt, hash } = await hashPassword(newPassword);
  await store.updateUser(user.id, { salt, passwordHash: hash });
  await store.deleteUserSessions(user.id); // log out everywhere
  failedLogins.delete(email);
  res.json({ message: "Your password has been reset. Please log in with your new password." });
}));

/* ---------- Student profile ---------- */
app.get("/api/profile", requireAuth, (req, res) => {
  res.json(publicUser(req.user));
});

// The email can't be changed here, because it was verified with a code
app.put("/api/profile", requireAuth, route(async (req, res) => {
  const name = cleanText(req.body.name, 50);
  if (!name) return res.status(400).json({ error: "Please enter your full name." });
  const { error, profile } = readProfileFields(req.body);
  if (error) return res.status(400).json({ error });

  const user = await store.updateUser(req.userId, { name, ...profile }, ["rollNo", "phone"]);
  res.json(publicUser(user));
}));

app.put("/api/profile/password", requireAuth, route(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!(await checkPassword(currentPassword, req.user))) {
    return res.status(400).json({ error: "Your current password is incorrect." });
  }
  const passwordError = validatePassword(newPassword);
  if (passwordError) return res.status(400).json({ error: passwordError });

  const { salt, hash } = await hashPassword(newPassword);
  await store.updateUser(req.userId, { salt, passwordHash: hash });
  // Log out every other device, keep this one logged in
  await store.deleteUserSessions(req.userId, req.tokenHash);
  res.json({ message: "Password changed." });
}));

app.delete("/api/profile", requireAuth, route(async (req, res) => {
  if (!(await checkPassword(req.body.password, req.user))) {
    return res.status(400).json({ error: "Password is incorrect." });
  }
  await store.deleteUser(req.userId);
  res.sendStatus(204);
}));

/* ---------- Everything below needs a logged-in student ---------- */
app.use("/api", (req, res, next) => {
  if (req.path.startsWith("/auth/") || req.path === "/health") return next();
  requireAuth(req, res, next);
});

// Get all of this student's data at once (used when the page loads)
app.get("/api/data", route(async (req, res) => {
  const data = await store.getData(req.userId);
  res.json({ user: publicUser(req.user), ...data });
}));

/* ---------- Overall attendance ---------- */
app.get("/api/attendance", route(async (req, res) => {
  res.json((await store.getData(req.userId)).attendance);
}));

app.put("/api/attendance", route(async (req, res) => {
  const { total, attended } = req.body;
  const error = validateClasses(total, attended, 1);
  if (error) return res.status(400).json({ error });

  const data = await store.getData(req.userId);
  data.attendance = { total, attended, updatedAt: new Date().toISOString() };
  await store.saveData(req.userId, data);
  res.json(data.attendance);
}));

app.delete("/api/attendance", route(async (req, res) => {
  const data = await store.getData(req.userId);
  data.attendance = null;
  await store.saveData(req.userId, data);
  res.sendStatus(204);
}));

/* ---------- Subjects ---------- */
app.get("/api/subjects", route(async (req, res) => {
  res.json((await store.getData(req.userId)).subjects);
}));

app.post("/api/subjects", route(async (req, res) => {
  const name = cleanText(req.body.name, 40);
  const { total, attended } = req.body;

  if (!name) return res.status(400).json({ error: "Please enter the subject name." });
  const error = validateClasses(total, attended, 0);
  if (error) return res.status(400).json({ error });

  const data = await store.getData(req.userId);
  if (data.subjects.some(s => s.name.toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ error: "This subject is already added." });
  }

  const subject = { id: makeId(), name, total, attended };
  data.subjects.push(subject);
  await store.saveData(req.userId, data);
  res.status(201).json(subject);
}));

// Mark one class as present or absent
app.patch("/api/subjects/:id", route(async (req, res) => {
  const data = await store.getData(req.userId);
  const subject = data.subjects.find(s => s.id === req.params.id);
  if (!subject) return res.status(404).json({ error: "Subject not found." });

  const { action } = req.body;
  if (action !== "present" && action !== "absent") {
    return res.status(400).json({ error: "Action must be 'present' or 'absent'." });
  }
  if (subject.total >= MAX_CLASSES) {
    return res.status(400).json({ error: "Maximum number of classes reached." });
  }

  subject.total++;
  if (action === "present") subject.attended++;
  await store.saveData(req.userId, data);
  res.json(subject);
}));

app.delete("/api/subjects/:id", route(async (req, res) => {
  const data = await store.getData(req.userId);
  const before = data.subjects.length;
  data.subjects = data.subjects.filter(s => s.id !== req.params.id);
  if (data.subjects.length === before) return res.status(404).json({ error: "Subject not found." });
  await store.saveData(req.userId, data);
  res.sendStatus(204);
}));

/* ---------- Assignments ---------- */
app.get("/api/assignments", route(async (req, res) => {
  res.json((await store.getData(req.userId)).assignments);
}));

app.post("/api/assignments", route(async (req, res) => {
  const name = cleanText(req.body.name, 60);
  const subject = cleanText(req.body.subject, 40);
  const { start, deadline } = req.body;

  let error = "";
  if (!name) error = "Please enter the assignment name.";
  else if (!subject) error = "Please enter the subject.";
  else if (!isValidDateStr(start)) error = "Please choose a valid starting date.";
  else if (!isValidDateStr(deadline)) error = "Please choose a valid submission deadline.";
  else if (deadline < start) error = "The deadline cannot be before the starting date.";
  else if (deadline < todayStr()) error = "The deadline has already passed. Please choose today or a future date.";
  if (error) return res.status(400).json({ error });

  const data = await store.getData(req.userId);
  const assignment = {
    id: makeId(),
    name,
    subject,
    start,
    deadline,
    completed: false,
    createdAt: new Date().toISOString()
  };
  data.assignments.push(assignment);
  await store.saveData(req.userId, data);
  res.status(201).json(assignment);
}));

// Mark as completed / pending
app.patch("/api/assignments/:id", route(async (req, res) => {
  const { completed } = req.body;
  if (typeof completed !== "boolean") {
    return res.status(400).json({ error: "'completed' must be true or false." });
  }

  const data = await store.getData(req.userId);
  const assignment = data.assignments.find(a => a.id === req.params.id);
  if (!assignment) return res.status(404).json({ error: "Assignment not found." });

  assignment.completed = completed;
  await store.saveData(req.userId, data);
  res.json(assignment);
}));

app.delete("/api/assignments/:id", route(async (req, res) => {
  const data = await store.getData(req.userId);
  const before = data.assignments.length;
  data.assignments = data.assignments.filter(a => a.id !== req.params.id);
  if (data.assignments.length === before) return res.status(404).json({ error: "Assignment not found." });
  await store.saveData(req.userId, data);
  res.sendStatus(204);
}));

/* ---------- Exams (countdown) ---------- */
app.get("/api/exams", route(async (req, res) => {
  res.json((await store.getData(req.userId)).exams);
}));

app.post("/api/exams", route(async (req, res) => {
  const name = cleanText(req.body.name, 60);
  const subject = cleanText(req.body.subject, 40);
  const { date } = req.body;
  const time = typeof req.body.time === "string" ? req.body.time.trim() : "";

  let error = "";
  if (!name) error = "Please enter the exam name.";
  else if (!subject) error = "Please enter the subject.";
  else if (!isValidDateStr(date)) error = "Please choose a valid exam date.";
  else if (date < todayStr()) error = "The exam date has already passed. Please choose today or a future date.";
  else if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) error = "Please choose a valid time.";
  if (error) return res.status(400).json({ error });

  const data = await store.getData(req.userId);
  const exam = { id: makeId(), name, subject, date, time, createdAt: new Date().toISOString() };
  data.exams.push(exam);
  await store.saveData(req.userId, data);
  res.status(201).json(exam);
}));

app.delete("/api/exams/:id", route(async (req, res) => {
  const data = await store.getData(req.userId);
  const before = data.exams.length;
  data.exams = data.exams.filter(x => x.id !== req.params.id);
  if (data.exams.length === before) return res.status(404).json({ error: "Exam not found." });
  await store.saveData(req.userId, data);
  res.sendStatus(204);
}));

/* ---------- Quick notes ---------- */
const NOTE_CATEGORIES = ["subject", "reminder", "topic"];

app.get("/api/notes", route(async (req, res) => {
  res.json((await store.getData(req.userId)).notes);
}));

app.post("/api/notes", route(async (req, res) => {
  const title = cleanText(req.body.title, 60);
  const subject = cleanText(req.body.subject, 40);
  const content = cleanText(req.body.content, 1000);
  const { category } = req.body;

  let error = "";
  if (!title) error = "Please enter a title for the note.";
  else if (!NOTE_CATEGORIES.includes(category)) error = "Please choose a note type.";
  else if (!content) error = "Please write something in the note.";
  if (error) return res.status(400).json({ error });

  const data = await store.getData(req.userId);
  const note = { id: makeId(), title, category, subject, content, createdAt: new Date().toISOString() };
  data.notes.push(note);
  await store.saveData(req.userId, data);
  res.status(201).json(note);
}));

app.delete("/api/notes/:id", route(async (req, res) => {
  const data = await store.getData(req.userId);
  const before = data.notes.length;
  data.notes = data.notes.filter(n => n.id !== req.params.id);
  if (data.notes.length === before) return res.status(404).json({ error: "Note not found." });
  await store.saveData(req.userId, data);
  res.sendStatus(204);
}));

/* ---------- Errors ---------- */
// Unknown API route
app.use("/api", (req, res) => {
  res.status(404).json({ error: "API route not found." });
});

// Bad JSON or unexpected server error
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Invalid JSON in request body." });
  }
  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: "That is too much data at once." });
  }
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server. Please try again." });
});

/* =========================================
   Start
   ========================================= */
// Connect to the database once; later calls reuse the same connection
let readyPromise = null;
function ready() {
  if (!readyPromise) {
    readyPromise = store.init().catch(err => {
      readyPromise = null; // try again on the next request
      throw err;
    });
  }
  return readyPromise;
}

// Used by Vercel (api/index.js), which runs the app without app.listen()
module.exports = { app, ready };

// "npm start" on your own computer: start a normal server
if (require.main === module) {
  ready()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`StudySync server running at http://localhost:${PORT}`);
        console.log(`Data is stored in: ${store.name}`);
        if (EMAIL_METHOD === "brevo") console.log(`Emails are sent with Brevo from ${EMAIL_FROM}`);
        else if (EMAIL_METHOD === "gmail") console.log(`Emails are sent from ${EMAIL_FROM}`);
        else console.log("Email is not set up (see server/.env.example). Codes will be printed here instead.");
      });
    })
    .catch(err => {
      console.error("Could not connect to the database:", err.message);
      process.exit(1);
    });
}
