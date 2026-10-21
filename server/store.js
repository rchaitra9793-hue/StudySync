/* =========================================
   StudySync – Data storage

   Two ways to store data, with the same functions:
   - MongoDB   (when MONGODB_URI is set)  → used when deployed online
   - JSON file (data/db.json)             → used on your own computer

   Every function is async, so server.js works the same with both.
   ========================================= */

const fs = require("fs");
const path = require("path");

const EMPTY_DATA = () => ({ attendance: null, subjects: [], assignments: [], exams: [], notes: [] });

// Fill in lists that older accounts may not have yet
function withDefaults(data) {
  const full = { ...EMPTY_DATA(), ...(data || {}) };
  for (const key of ["subjects", "assignments", "exams", "notes"]) {
    if (!Array.isArray(full[key])) full[key] = [];
  }
  return full;
}

/* =========================================
   1) JSON file storage

   db.json looks like:
   {
     users:    [{ id, name, email, passwordHash, salt, college, course, year, semester, createdAt }],
     sessions: [{ tokenHash, userId, expiresAt }],
     codes:    [{ purpose: "register" | "reset", email, codeHash, expiresAt, attempts, sentAt, ... }],
     data:     { "<userId>": { attendance, subjects, assignments, exams, notes } }
   }
   ========================================= */
function createFileStore(file) {
  function read() {
    let db;
    try {
      db = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      db = {}; // file missing or broken: start empty
    }

    // Very old single-user format (before logins): keep it for the first student who registers
    if (!db.users && (db.attendance || (db.subjects || []).length || (db.assignments || []).length)) {
      db = { legacy: { attendance: db.attendance || null, subjects: db.subjects || [], assignments: db.assignments || [] } };
    }

    // Older versions kept registration codes in "pending"
    const oldPending = Array.isArray(db.pending) ? db.pending.map(p => ({ purpose: "register", ...p })) : [];

    return {
      users: Array.isArray(db.users) ? db.users : [],
      sessions: Array.isArray(db.sessions) ? db.sessions : [],
      codes: (Array.isArray(db.codes) ? db.codes : []).concat(oldPending),
      data: db.data && typeof db.data === "object" ? db.data : {},
      legacy: db.legacy || null
    };
  }

  // Write to a temp file first, then rename, so the file is never half-written
  function write(db) {
    if (!db.legacy) delete db.legacy;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = file + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(db, null, 2));
    fs.renameSync(temp, file);
  }

  // Read, change, save in one step
  function change(fn) {
    const db = read();
    const result = fn(db);
    write(db);
    return result;
  }

  return {
    name: `JSON file (${file})`,
    async init() {},

    // ----- Users -----
    async getUserByEmail(email) {
      return read().users.find(u => u.email === email) || null;
    },
    async getUserById(id) {
      return read().users.find(u => u.id === id) || null;
    },
    async countUsers() {
      return read().users.length;
    },
    async addUser(user) {
      change(db => { db.users.push(user); });
    },
    async updateUser(id, changes, removeFields = []) {
      return change(db => {
        const user = db.users.find(u => u.id === id);
        if (!user) return null;
        Object.assign(user, changes);
        removeFields.forEach(f => delete user[f]);
        return user;
      });
    },
    async deleteUser(id) {
      change(db => {
        const user = db.users.find(u => u.id === id);
        db.users = db.users.filter(u => u.id !== id);
        db.sessions = db.sessions.filter(s => s.userId !== id);
        if (user) db.codes = db.codes.filter(c => c.email !== user.email);
        delete db.data[id];
      });
    },

    // ----- Login sessions -----
    async addSession(session) {
      change(db => {
        db.sessions = db.sessions.filter(s => s.expiresAt > Date.now()); // remove expired logins
        db.sessions.push(session);
      });
    },
    async getSession(tokenHash) {
      return read().sessions.find(s => s.tokenHash === tokenHash) || null;
    },
    async deleteSession(tokenHash) {
      change(db => { db.sessions = db.sessions.filter(s => s.tokenHash !== tokenHash); });
    },
    // Log out every device of a student, except the one with keepTokenHash
    async deleteUserSessions(userId, keepTokenHash = null) {
      change(db => { db.sessions = db.sessions.filter(s => s.userId !== userId || s.tokenHash === keepTokenHash); });
    },

    // ----- Email codes (registration & password reset) -----
    async getCode(purpose, email) {
      return read().codes.find(c => c.purpose === purpose && c.email === email) || null;
    },
    async saveCode(entry) {
      change(db => {
        db.codes = db.codes.filter(c =>
          c.expiresAt > Date.now() && !(c.purpose === entry.purpose && c.email === entry.email));
        db.codes.push(entry);
      });
    },
    async deleteCode(purpose, email) {
      change(db => { db.codes = db.codes.filter(c => !(c.purpose === purpose && c.email === email)); });
    },

    // ----- Student data -----
    async getData(userId) {
      return withDefaults(read().data[userId]);
    },
    async saveData(userId, data) {
      change(db => { db.data[userId] = data; });
    },

    // Data saved before logins existed (only the first student gets it)
    async takeLegacyData() {
      return change(db => {
        const legacy = db.legacy;
        db.legacy = null;
        return legacy;
      });
    }
  };
}

/* =========================================
   2) MongoDB storage
   Collections: users, sessions, codes, data (one document per student)
   ========================================= */
function createMongoStore(uri) {
  const { MongoClient } = require("mongodb");
  const client = new MongoClient(uri);
  let users, sessions, codes, data;
  const noId = { projection: { _id: 0 } }; // don't send MongoDB's own _id field around

  return {
    name: "MongoDB",
    async init() {
      await client.connect();
      const db = client.db(process.env.MONGODB_DB || "studysync");
      users = db.collection("users");
      sessions = db.collection("sessions");
      codes = db.collection("codes");
      data = db.collection("data");
      await Promise.all([
        users.createIndex({ email: 1 }, { unique: true }),
        users.createIndex({ id: 1 }, { unique: true }),
        sessions.createIndex({ tokenHash: 1 }, { unique: true }),
        sessions.createIndex({ userId: 1 }),
        codes.createIndex({ purpose: 1, email: 1 }, { unique: true })
      ]);
    },

    // ----- Users -----
    async getUserByEmail(email) {
      return users.findOne({ email }, noId);
    },
    async getUserById(id) {
      return users.findOne({ id }, noId);
    },
    async countUsers() {
      return users.countDocuments();
    },
    async addUser(user) {
      await users.insertOne({ ...user });
    },
    async updateUser(id, changes, removeFields = []) {
      const update = { $set: changes };
      if (removeFields.length) update.$unset = Object.fromEntries(removeFields.map(f => [f, ""]));
      return users.findOneAndUpdate({ id }, update, { returnDocument: "after", projection: { _id: 0 } });
    },
    async deleteUser(id) {
      const user = await users.findOne({ id });
      await Promise.all([
        users.deleteOne({ id }),
        sessions.deleteMany({ userId: id }),
        data.deleteOne({ _id: id }),
        user ? codes.deleteMany({ email: user.email }) : null
      ]);
    },

    // ----- Login sessions -----
    async addSession(session) {
      await sessions.deleteMany({ expiresAt: { $lt: Date.now() } });
      await sessions.insertOne({ ...session });
    },
    async getSession(tokenHash) {
      return sessions.findOne({ tokenHash }, noId);
    },
    async deleteSession(tokenHash) {
      await sessions.deleteOne({ tokenHash });
    },
    async deleteUserSessions(userId, keepTokenHash = null) {
      await sessions.deleteMany({ userId, tokenHash: { $ne: keepTokenHash } });
    },

    // ----- Email codes -----
    async getCode(purpose, email) {
      return codes.findOne({ purpose, email }, noId);
    },
    async saveCode(entry) {
      await codes.deleteMany({ expiresAt: { $lt: Date.now() } });
      await codes.replaceOne({ purpose: entry.purpose, email: entry.email }, { ...entry }, { upsert: true });
    },
    async deleteCode(purpose, email) {
      await codes.deleteOne({ purpose, email });
    },

    // ----- Student data -----
    async getData(userId) {
      const doc = await data.findOne({ _id: userId });
      if (!doc) return EMPTY_DATA();
      const { _id, ...rest } = doc;
      return withDefaults(rest);
    },
    async saveData(userId, studentData) {
      await data.replaceOne({ _id: userId }, { ...studentData }, { upsert: true });
    },

    async takeLegacyData() {
      return null; // only the JSON file can have data from before logins
    }
  };
}

/* =========================================
   Pick the storage to use
   ========================================= */
function createStore() {
  if (process.env.MONGODB_URI) return createMongoStore(process.env.MONGODB_URI);
  const file = process.env.DATA_FILE || path.join(__dirname, "data", "db.json");
  return createFileStore(file);
}

module.exports = { createStore, createFileStore, withDefaults };
