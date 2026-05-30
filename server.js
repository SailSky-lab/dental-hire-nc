import express from "express";
import { DatabaseSync } from "node:sqlite";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3002;

// ── Database ──
const DATA_DIR = process.env.DATABASE_PATH
  ? dirname(process.env.DATABASE_PATH)
  : join(__dirname, "data");
mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(
  process.env.DATABASE_PATH || join(DATA_DIR, "dental.db")
);

db.exec(`
  CREATE TABLE IF NOT EXISTS dental_jobs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    practice      TEXT NOT NULL,
    position      TEXT NOT NULL,
    job_type      TEXT NOT NULL,
    city          TEXT NOT NULL,
    pay_rate      TEXT,
    dates         TEXT,
    description   TEXT,
    contact_name  TEXT NOT NULL,
    contact_email TEXT NOT NULL,
    status        TEXT DEFAULT 'active',
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS dental_workers (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name     TEXT NOT NULL,
    last_name      TEXT NOT NULL,
    role           TEXT NOT NULL,
    city           TEXT NOT NULL,
    experience     TEXT,
    license_number TEXT,
    software       TEXT,
    temp_open      TEXT,
    email          TEXT NOT NULL,
    phone          TEXT,
    status         TEXT DEFAULT 'active',
    created_at     TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS dental_applications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id     INTEGER NOT NULL,
    name       TEXT NOT NULL,
    email      TEXT NOT NULL,
    phone      TEXT,
    message    TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(job_id) REFERENCES dental_jobs(id)
  );
`);

app.use(express.json());
app.use(express.static(join(__dirname, "public")));

// ── Jobs ──
app.get("/api/jobs", (req, res) => {
  const { city, type, keyword } = req.query;
  let sql = "SELECT * FROM dental_jobs WHERE status = 'active'";
  const params = [];
  if (city)    { sql += " AND city = ?";                              params.push(city); }
  if (type)    { sql += " AND job_type = ?";                          params.push(type); }
  if (keyword) { sql += " AND (position LIKE ? OR description LIKE ?)"; params.push(`%${keyword}%`, `%${keyword}%`); }
  sql += " ORDER BY created_at DESC";
  try {
    res.json({ jobs: db.prepare(sql).all(...params) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/jobs", (req, res) => {
  const { practice, position, job_type, city, pay_rate, dates, description, contact_name, contact_email } = req.body;
  if (!practice || !position || !job_type || !city || !contact_name || !contact_email) {
    return res.status(400).json({ error: "Missing required fields." });
  }
  try {
    const result = db.prepare(`
      INSERT INTO dental_jobs (practice, position, job_type, city, pay_rate, dates, description, contact_name, contact_email)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(practice, position, job_type, city, pay_rate || null, dates || null, description || null, contact_name, contact_email);
    res.status(201).json({ job: db.prepare("SELECT * FROM dental_jobs WHERE id = ?").get(result.lastInsertRowid) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Workers ──
app.get("/api/workers", (req, res) => {
  const { city, role } = req.query;
  let sql = "SELECT id,first_name,last_name,role,city,experience,license_number,software,temp_open,created_at FROM dental_workers WHERE status='active'";
  const params = [];
  if (city) { sql += " AND city = ?"; params.push(city); }
  if (role) { sql += " AND role LIKE ?"; params.push(`%${role}%`); }
  sql += " ORDER BY created_at DESC";
  try {
    res.json({ workers: db.prepare(sql).all(...params) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/workers", (req, res) => {
  const { first_name, last_name, role, city, experience, license_number, software, temp_open, email, phone } = req.body;
  if (!first_name || !last_name || !role || !city || !email) {
    return res.status(400).json({ error: "Missing required fields." });
  }
  try {
    const result = db.prepare(`
      INSERT INTO dental_workers (first_name, last_name, role, city, experience, license_number, software, temp_open, email, phone)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(first_name, last_name, role, city, experience || null, license_number || null, software || null, temp_open || null, email, phone || null);
    res.status(201).json({ id: result.lastInsertRowid, message: "Profile created successfully!" });
  } catch (err) {
    if (err.message.includes("UNIQUE")) return res.status(409).json({ error: "An account with this email already exists." });
    res.status(500).json({ error: err.message });
  }
});

// ── Applications ──
app.post("/api/apply", (req, res) => {
  const { job_id, name, email, phone, message } = req.body;
  if (!job_id || !name || !email) return res.status(400).json({ error: "Missing required fields." });
  const job = db.prepare("SELECT id, position, practice FROM dental_jobs WHERE id = ? AND status='active'").get(job_id);
  if (!job) return res.status(404).json({ error: "Job not found or no longer active." });
  try {
    db.prepare("INSERT INTO dental_applications (job_id, name, email, phone, message) VALUES (?, ?, ?, ?, ?)")
      .run(job_id, name, email, phone || null, message || null);
    res.status(201).json({ message: `Application submitted for ${job.position} at ${job.practice}!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin ──
app.get("/api/admin/jobs",         (_req, res) => res.json({ jobs:         db.prepare("SELECT * FROM dental_jobs ORDER BY created_at DESC").all() }));
app.get("/api/admin/workers",      (_req, res) => res.json({ workers:      db.prepare("SELECT * FROM dental_workers ORDER BY created_at DESC").all() }));
app.get("/api/admin/applications", (_req, res) => res.json({ applications: db.prepare("SELECT a.*, j.position, j.practice, j.city FROM dental_applications a JOIN dental_jobs j ON a.job_id=j.id ORDER BY a.created_at DESC").all() }));

// Catch-all → index.html
app.get("*", (_req, res) => res.sendFile(join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`DentalHire NC running on http://localhost:${PORT}`));
