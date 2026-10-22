/* =========================================
   StudySync on Vercel
   Vercel runs this file for every /api/... request (see vercel.json).
   The website files in client/ are served by Vercel directly.
   ========================================= */

const { app, ready } = require("../server/server");
const { mongoUri } = require("../server/store");

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

// Helps find setup mistakes. Shows only NAMES of settings, never their values.
function setupInfo() {
  return {
    deployment: (process.env.VERCEL_GIT_COMMIT_SHA || "").slice(0, 7) || "unknown",
    environment: process.env.VERCEL_ENV || "unknown",
    settingsFound: Object.keys(process.env)
      .filter(name => /MONGO|SMTP|BREVO|EMAIL/i.test(name))
      .sort()
      .map(name => (process.env[name] || "").trim() ? name : `${name} (empty)`)
  };
}

module.exports = async (req, res) => {
  // On Vercel the files are read-only, so data must go to MongoDB
  if (!mongoUri()) {
    sendJson(res, 500, {
      error: "The database is not set up. Add MONGODB_URI in Vercel → Settings → Environment Variables (Production), then redeploy.",
      ...setupInfo()
    });
    return;
  }

  try {
    await ready(); // connect to MongoDB (only the first time)
  } catch (err) {
    console.error("Could not connect to the database:", err.message);
    // Common causes, without showing the connection string itself
    let hint = "Check the MONGODB_URI value in Vercel.";
    if (/auth|password|credential/i.test(err.message)) hint = "MongoDB rejected the username or password inside MONGODB_URI.";
    else if (/ENOTFOUND|querySrv|ENODATA/i.test(err.message)) hint = "The cluster address inside MONGODB_URI looks wrong.";
    else if (/timed out|ECONNREFUSED|Server selection/i.test(err.message)) hint = "MongoDB did not answer. Check Network Access allows 0.0.0.0/0.";
    else if (/Invalid scheme|Invalid connection string|URI/i.test(err.message)) hint = "MONGODB_URI is not a valid mongodb+srv:// link.";
    sendJson(res, 503, { error: "Could not connect to the database. " + hint, ...setupInfo() });
    return;
  }

  return app(req, res);
};
