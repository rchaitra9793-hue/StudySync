/* =========================================
   StudySync on Vercel
   Vercel runs this file for every /api/... request (see vercel.json).
   The website files in client/ are served by Vercel directly.
   ========================================= */

const { app, ready } = require("../server/server");

module.exports = async (req, res) => {
  // On Vercel the files are read-only, so data must go to MongoDB
  if (!process.env.MONGODB_URI) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "The database is not set up. Add MONGODB_URI in Vercel → Settings → Environment Variables." }));
    return;
  }

  try {
    await ready(); // connect to MongoDB (only the first time)
  } catch (err) {
    console.error("Could not connect to the database:", err.message);
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Could not connect to the database. Please try again in a moment." }));
    return;
  }

  return app(req, res);
};
