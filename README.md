# StudySync – Student Academic Planner

A planner for degree students: attendance (75% rule), assignment deadlines with smart priority, exam countdown and quick notes.

## Project structure

```
StudySync/
├── client/                 # Website (HTML, CSS, JavaScript)
│   ├── index.html          # Home (landing) page
│   ├── login.html          # Login / Register (+ email code)
│   ├── auth.js
│   ├── reset-password.html # Forgot password → reset with email code
│   ├── reset.js
│   ├── dashboard.html      # Dashboard, Attendance, Assignments, Exams, Notes, Calendar, Profile
│   ├── script.js
│   ├── style.css
│   └── favicon.svg
├── server/                 # Backend (Node.js + Express)
│   ├── server.js           # API routes, login, emails
│   ├── store.js            # Data storage: MongoDB online, data/db.json on your computer
│   ├── migrate-to-mongo.js # Copies data/db.json into MongoDB
│   ├── .env.example        # Settings template (copy to .env)
│   └── package.json
└── render.yaml             # Deploy settings for Render
```

## Run on your own computer

You need [Node.js](https://nodejs.org) 22 or newer.

```bash
cd server
npm install
npm start
```

Open **http://localhost:3000**. Data is saved in `server/data/db.json`.

## Settings (`server/.env`)

Copy `server/.env.example` to `server/.env` and fill in what you need:

| Setting | What it's for |
|---|---|
| `MONGODB_URI` | MongoDB connection string. Empty = use `data/db.json` |
| `BREVO_API_KEY`, `EMAIL_FROM` | Send emails with Brevo (needed on Render's free plan) |
| `SMTP_USER`, `SMTP_PASS` | Send emails with Gmail + App Password (works locally) |

With no email set up, verification and reset codes are printed in the server terminal.

## Accounts

- Only `@gmail.com` addresses can register or log in. An email that isn't registered shows "No account found".
- **Email verification:** registering sends a 6-digit code. The account is only created after the correct code is entered.
- **Forgot password:** "Forgot password?" on the login page → enter Gmail → enter the emailed code and a new password. All devices are logged out.
- Codes expire after 10 minutes, allow 5 tries, and can be resent once a minute.
- After 10 wrong passwords, that email is locked for 15 minutes.
- Passwords are hashed with `crypto.scrypt`. Logins last 7 days.

## Deploy (Render + MongoDB Atlas + Brevo, all free)

**1. Database – MongoDB Atlas**
1. Sign up at https://www.mongodb.com/cloud/atlas/register and create a free **M0** cluster.
2. *Database Access* → add a user with a password.
3. *Network Access* → add IP address `0.0.0.0/0` (lets Render connect).
4. *Connect → Drivers* → copy the connection string and put your password in it.

**2. Email – Brevo** (Render's free plan blocks Gmail's ports)
1. Sign up at https://www.brevo.com.
2. *Senders, Domains & Dedicated IPs → Senders* → add and verify your Gmail address.
3. *SMTP & API → API Keys* → create a key.

**3. Code – GitHub**
1. Create an empty repository at https://github.com/new.
2. Push this folder to it (`.env` and `db.json` are ignored, so no secrets are uploaded).

**4. Website – Render**
1. Sign up at https://render.com with GitHub.
2. *New → Blueprint* → pick your repository. Render reads `render.yaml`.
3. Fill in `MONGODB_URI`, `BREVO_API_KEY` and `EMAIL_FROM` when asked, then deploy.
4. Your site is live at `https://studysync-xxxx.onrender.com`.

**5. (Optional) Move your existing accounts**
Put `MONGODB_URI` in `server/.env`, then run `npm run migrate` in the `server` folder.

Note: on Render's free plan the site sleeps after 15 minutes without visitors; the first visit after that takes about a minute to wake up.

## API

All routes except `/api/auth/*` and `/api/health` need the `Authorization: Bearer <token>` header.

| Method | Route | Body | What it does |
|--------|-------|------|--------------|
| POST | `/api/auth/register/start` | `{ name, email, password, course?, year?, college? }` | Email a 6-digit code (no account yet) |
| POST | `/api/auth/register/resend` | `{ email }` | Send a new code (once per 60 s) |
| POST | `/api/auth/register/verify` | `{ email, code }` | Check the code, create the account, returns `{ token, user }` |
| POST | `/api/auth/login` | `{ email, password }` | Log in, returns `{ token, user }` |
| POST | `/api/auth/logout` | – | Log out this device |
| POST | `/api/auth/forgot` | `{ email }` | Email a password reset code |
| POST | `/api/auth/reset` | `{ email, code, newPassword }` | Set a new password with the code |
| GET | `/api/profile` | – | Get your profile |
| PUT | `/api/profile` | `{ name, college, course, year (1–4), semester (1–8) }` | Update your profile |
| PUT | `/api/profile/password` | `{ currentPassword, newPassword }` | Change password |
| DELETE | `/api/profile` | `{ password }` | Delete your account and all data |
| GET | `/api/data` | – | Get your profile and all your data at once |
| GET / PUT / DELETE | `/api/attendance` | `{ total, attended }` | Overall attendance |
| GET / POST | `/api/subjects` | `{ name, total, attended }` | List / add subjects |
| PATCH / DELETE | `/api/subjects/:id` | `{ action: "present" \| "absent" }` | Mark a class / delete |
| GET / POST | `/api/assignments` | `{ name, subject, start, deadline }` | List / add assignments |
| PATCH / DELETE | `/api/assignments/:id` | `{ completed }` | Mark completed / delete |
| GET / POST | `/api/exams` | `{ name, subject, date, time? }` | List / add exams |
| DELETE | `/api/exams/:id` | – | Delete an exam |
| GET / POST | `/api/notes` | `{ title, category, subject?, content }` | List / add notes (`subject`, `reminder`, `topic`) |
| DELETE | `/api/notes/:id` | – | Delete a note |

Every input is checked on the server; problems come back as `{ "error": "..." }` with status 400.
