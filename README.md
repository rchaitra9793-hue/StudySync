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
│   └── .env.example        # Settings template (copy to .env)
├── api/index.js            # Runs the server on Vercel
├── vercel.json             # Vercel settings
└── package.json
```

## Run on your own computer

You need [Node.js](https://nodejs.org) 22 or newer. In the project folder:

```bash
npm install
npm start
```

Open **http://localhost:3000**. Data is saved in `server/data/db.json`.

## Settings (`server/.env`)

Copy `server/.env.example` to `server/.env` and fill in what you need:

| Setting | What it's for |
|---|---|
| `MONGODB_URI` | MongoDB connection string. Empty = use `data/db.json` |
| `SMTP_USER`, `SMTP_PASS` | Send emails with Gmail + App Password (works locally and on Vercel) |
| `BREVO_API_KEY`, `EMAIL_FROM` | Optional: send emails with Brevo instead of Gmail |

With no email set up, verification and reset codes are printed in the server terminal.

## Accounts

- Only `@gmail.com` addresses can register or log in. An email that isn't registered shows "No account found".
- **Email verification:** registering sends a 6-digit code. The account is only created after the correct code is entered.
- **Forgot password:** "Forgot password?" on the login page → enter Gmail → enter the emailed code and a new password. All devices are logged out.
- Codes expire after 10 minutes, allow 5 tries, and can be resent once a minute.
- After 10 wrong passwords, that email is locked for 15 minutes.
- Passwords are hashed with `crypto.scrypt`. Logins last 7 days.

## Deploy for free (Vercel + MongoDB Atlas + Gmail)

**1. Database – MongoDB Atlas (free M0)**
1. Sign up at https://www.mongodb.com/cloud/atlas/register and create a free **M0** cluster (region: Mumbai).
2. *Database Access* → add a database user with a password.
3. *Network Access* → add IP address `0.0.0.0/0` (lets Vercel connect).
4. *Connect → Drivers* → copy the connection string and put your password in it.

**2. Website – Vercel (free Hobby plan)**
1. Sign up at https://vercel.com with your GitHub account.
2. *Add New → Project* → import the `StudySync` repository. Leave the settings as they are.
3. Under *Environment Variables* add:
   - `MONGODB_URI` – the string from step 1
   - `SMTP_USER` – your Gmail address
   - `SMTP_PASS` – your Gmail App Password
4. Click *Deploy*. Your site is live at `https://<project>.vercel.app`.

**3. (Optional) Move your existing accounts**
Put `MONGODB_URI` in `server/.env`, then run `npm run migrate` in the project folder.

Note: Vercel starts the server fresh when needed, so the "10 wrong passwords" lock may reset sooner than 15 minutes.

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
