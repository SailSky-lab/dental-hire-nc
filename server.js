import "dotenv/config";
import express from "express";
import Stripe from "stripe";
import { DatabaseSync } from "node:sqlite";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3002;
// Stripe key is optional at boot so the rest of the site still works if billing isn't configured yet —
// only the checkout/webhook routes need it, and they'll error clearly if it's missing.
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
if (!stripe) console.warn("⚠️  STRIPE_SECRET_KEY not set — job payments and subscriptions are disabled until it's configured in .env");
const JOB_POST_PRICE_CENTS = 1000;   // $10
const SUBSCRIPTION_PRICE_CENTS = 8000; // $80/mo

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

  CREATE TABLE IF NOT EXISTS practice_invitations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id       INTEGER NOT NULL,
    practice_name   TEXT NOT NULL,
    practice_email  TEXT NOT NULL,
    role_needed     TEXT,
    message         TEXT,
    status          TEXT DEFAULT 'pending',
    created_at      TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(worker_id) REFERENCES dental_workers(id)
  );

  CREATE TABLE IF NOT EXISTS practice_subscriptions (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    email                  TEXT NOT NULL UNIQUE,
    practice_name          TEXT,
    phone                  TEXT,
    stripe_customer_id     TEXT,
    stripe_subscription_id TEXT,
    status                 TEXT DEFAULT 'incomplete',
    current_period_end     TEXT,
    created_at             TEXT DEFAULT (datetime('now')),
    updated_at             TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS dental_availability (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id      INTEGER,
    email          TEXT NOT NULL,
    role           TEXT NOT NULL,
    city           TEXT NOT NULL,
    job_type       TEXT NOT NULL,
    available_from TEXT NOT NULL,
    available_to   TEXT,
    notes          TEXT,
    status         TEXT DEFAULT 'active',
    created_at     TEXT DEFAULT (datetime('now'))
  );
`);

// ── Stripe webhook ── must be mounted with raw body BEFORE express.json(),
// otherwise the body arrives pre-parsed and signature verification fails.
app.post("/api/webhooks/stripe", express.raw({ type: "application/json" }), (req, res) => {
  if (!stripe) return res.status(503).json({ error: "Stripe is not configured on this server." });
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      if (session.mode === "payment" && session.metadata?.job_id) {
        db.prepare("UPDATE dental_jobs SET status='active' WHERE id = ?").run(session.metadata.job_id);
      } else if (session.mode === "subscription") {
        const email = (session.customer_details?.email || session.customer_email || "").toLowerCase().trim();
        if (email) {
          db.prepare(`
            INSERT INTO practice_subscriptions (email, practice_name, phone, stripe_customer_id, stripe_subscription_id, status, updated_at)
            VALUES (?, ?, ?, ?, ?, 'active', datetime('now'))
            ON CONFLICT(email) DO UPDATE SET
              practice_name=excluded.practice_name,
              phone=excluded.phone,
              stripe_customer_id=excluded.stripe_customer_id,
              stripe_subscription_id=excluded.stripe_subscription_id,
              status='active',
              updated_at=datetime('now')
          `).run(email, session.metadata?.practice_name || null, session.metadata?.phone || null, session.customer, session.subscription);
        }
      }
    } else if (event.type === "customer.subscription.updated") {
      const sub = event.data.object;
      const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;
      db.prepare(`
        UPDATE practice_subscriptions SET status=?, current_period_end=?, updated_at=datetime('now')
        WHERE stripe_subscription_id = ?
      `).run(sub.status, periodEnd, sub.id);
    } else if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object;
      db.prepare(`
        UPDATE practice_subscriptions SET status='canceled', updated_at=datetime('now')
        WHERE stripe_subscription_id = ?
      `).run(sub.id);
    }
    res.json({ received: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(express.json());
app.use(express.static(join(__dirname, "public")));

// ── Jobs ──
app.get("/api/jobs", (req, res) => {
  const { city, type, keyword } = req.query;
  let sql = "SELECT * FROM dental_jobs WHERE status = 'active'";
  const params = [];
  if (city)    { sql += " AND city = ?";                                params.push(city); }
  if (type)    { sql += " AND job_type = ?";                            params.push(type); }
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
      INSERT INTO dental_jobs (practice, position, job_type, city, pay_rate, dates, description, contact_name, contact_email, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_payment')
    `).run(practice, position, job_type, city, pay_rate || null, dates || null, description || null, contact_name, contact_email);
    res.status(201).json({ job: db.prepare("SELECT * FROM dental_jobs WHERE id = ?").get(result.lastInsertRowid) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Checkout: pay to activate a job listing ──
app.post("/api/checkout/job/:jobId", async (req, res) => {
  if (!stripe) return res.status(503).json({ error: "Payments are not configured on this server yet." });
  const job = db.prepare("SELECT id, position, practice, status FROM dental_jobs WHERE id = ?").get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found." });
  if (job.status === "active") return res.status(400).json({ error: "This job is already active." });
  try {
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{
        price_data: {
          currency: "usd",
          unit_amount: JOB_POST_PRICE_CENTS,
          product_data: { name: `Job Posting — ${job.position} at ${job.practice}` },
        },
        quantity: 1,
      }],
      metadata: { job_id: String(job.id) },
      success_url: `${baseUrl}/?job_paid=1`,
      cancel_url: `${baseUrl}/?job_canceled=1`,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Checkout: monthly practice subscription ──
app.post("/api/checkout/subscribe", async (req, res) => {
  if (!stripe) return res.status(503).json({ error: "Payments are not configured on this server yet." });
  const { practice_name, email, phone } = req.body;
  if (!practice_name || !email) return res.status(400).json({ error: "Practice name and email are required." });
  try {
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: email.toLowerCase().trim(),
      line_items: [{
        price_data: {
          currency: "usd",
          unit_amount: SUBSCRIPTION_PRICE_CENTS,
          recurring: { interval: "month" },
          product_data: { name: "DentalHire NC — Monthly Unlimited" },
        },
        quantity: 1,
      }],
      metadata: { practice_name, phone: phone || "" },
      success_url: `${baseUrl}/?sub_active=1`,
      cancel_url: `${baseUrl}/?sub_canceled=1`,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Workers ──
// Public endpoint — NO contact info returned, NO real names (role + city only for anonymous cards)
app.get("/api/workers", (req, res) => {
  const { city, role } = req.query;
  let sql = `SELECT id, role, city, experience, software, temp_open, created_at
             FROM dental_workers WHERE status='active'`;
  const params = [];
  if (city) { sql += " AND city = ?";       params.push(city); }
  if (role) { sql += " AND role LIKE ?";    params.push(`%${role}%`); }
  sql += " ORDER BY created_at DESC";
  try {
    res.json({ workers: db.prepare(sql).all(...params) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Subscriber-only endpoint — shows first name + last initial, still no email/phone
app.get("/api/workers/profiles", (req, res) => {
  const email = (req.headers["x-subscriber-email"] || "").toLowerCase().trim();
  const sub = email
    ? db.prepare("SELECT status FROM practice_subscriptions WHERE email = ?").get(email)
    : null;
  if (!sub || sub.status !== "active") {
    return res.status(401).json({ error: "An active practice subscription is required." });
  }
  const { city, role } = req.query;
  let sql = `SELECT id, first_name, last_name, role, city, experience, license_number, software, temp_open, created_at
             FROM dental_workers WHERE status='active'`;
  const params = [];
  if (city) { sql += " AND city = ?";    params.push(city); }
  if (role) { sql += " AND role LIKE ?"; params.push(`%${role}%`); }
  sql += " ORDER BY created_at DESC";
  try {
    const workers = db.prepare(sql).all(...params).map(w => ({
      ...w,
      last_name: w.last_name ? w.last_name[0] + "." : "",  // only last initial
    }));
    res.json({ workers });
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

// ── Worker: look up own profile by email ──
app.post("/api/workers/login", (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email is required." });
  const worker = db.prepare(`
    SELECT id, first_name, last_name, role, city, experience, license_number, software, temp_open, status, created_at
    FROM dental_workers WHERE email = ?
  `).get(email.toLowerCase().trim());
  if (!worker) return res.status(404).json({ error: "No profile found with that email. Make sure you use the same email you signed up with." });
  const applications = db.prepare(`
    SELECT a.created_at, j.position, j.practice, j.city, j.job_type
    FROM dental_applications a
    JOIN dental_jobs j ON a.job_id = j.id
    WHERE a.email = ?
    ORDER BY a.created_at DESC
  `).all(email.toLowerCase().trim());
  const invitations = db.prepare(`
    SELECT practice_name, role_needed, message, status, created_at
    FROM practice_invitations WHERE worker_id = ?
    ORDER BY created_at DESC
  `).all(worker.id);
  res.json({ worker, applications, invitations });
});

// ── Worker: update own profile ──
app.patch("/api/workers/update", (req, res) => {
  const { email, software, temp_open, experience, city } = req.body;
  if (!email) return res.status(400).json({ error: "Email is required." });
  const existing = db.prepare("SELECT id FROM dental_workers WHERE email = ?").get(email.toLowerCase().trim());
  if (!existing) return res.status(404).json({ error: "Profile not found." });
  try {
    db.prepare(`
      UPDATE dental_workers SET software=?, temp_open=?, experience=?, city=?
      WHERE email=?
    `).run(software || null, temp_open || null, experience || null, city || null, email.toLowerCase().trim());
    res.json({ message: "Profile updated successfully!" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Applications (worker → job) ──
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

// ── Availability Board ──
// Public: no email, no name — role/city/job_type/dates only
app.get("/api/availability", (req, res) => {
  const { city, role, job_type } = req.query;
  let sql = `SELECT id, role, city, job_type, available_from, available_to, notes, created_at
             FROM dental_availability WHERE status='active'`;
  const params = [];
  if (city)     { sql += " AND city = ?";          params.push(city); }
  if (role)     { sql += " AND role LIKE ?";        params.push(`%${role}%`); }
  if (job_type) { sql += " AND job_type = ?";       params.push(job_type); }
  sql += " ORDER BY created_at DESC";
  try {
    res.json({ availability: db.prepare(sql).all(...params) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/availability", (req, res) => {
  const { email, role, city, job_type, available_from, available_to, notes } = req.body;
  if (!email || !role || !city || !job_type || !available_from) {
    return res.status(400).json({ error: "email, role, city, job_type, and available_from are required." });
  }
  // optionally link to existing worker account
  const worker = db.prepare("SELECT id FROM dental_workers WHERE email = ?").get(email.toLowerCase().trim());
  try {
    const result = db.prepare(`
      INSERT INTO dental_availability (worker_id, email, role, city, job_type, available_from, available_to, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(worker ? worker.id : null, email.toLowerCase().trim(), role, city, job_type, available_from, available_to || null, notes || null);
    res.status(201).json({ id: result.lastInsertRowid, message: "Availability posted! Practices can now see when you're free." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Worker removes their own listing (verified by email)
app.delete("/api/availability/:id", (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email is required to remove your listing." });
  const row = db.prepare("SELECT id FROM dental_availability WHERE id = ? AND email = ?")
    .get(req.params.id, email.toLowerCase().trim());
  if (!row) return res.status(404).json({ error: "Listing not found or email does not match." });
  db.prepare("DELETE FROM dental_availability WHERE id = ?").run(req.params.id);
  res.json({ message: "Your availability listing has been removed." });
});

// ── Invitations (practice → worker via platform) ──
app.post("/api/invite/:workerId", (req, res) => {
  const workerId = parseInt(req.params.workerId);
  const { practice_name, practice_email, role_needed, message } = req.body;
  if (!practice_name || !practice_email) {
    return res.status(400).json({ error: "Practice name and email are required." });
  }
  const worker = db.prepare("SELECT id, role, city FROM dental_workers WHERE id = ? AND status='active'").get(workerId);
  if (!worker) return res.status(404).json({ error: "Professional not found." });
  try {
    db.prepare(`
      INSERT INTO practice_invitations (worker_id, practice_name, practice_email, role_needed, message)
      VALUES (?, ?, ?, ?, ?)
    `).run(workerId, practice_name, practice_email, role_needed || null, message || null);
    res.status(201).json({ message: "Invitation sent! The professional will be notified and will reach out if interested." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin Auth Middleware ──
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin2026";

function adminAuth(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (token !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized." });
  }
  next();
}

app.post("/api/admin/login", (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ token: ADMIN_PASSWORD, message: "Welcome, Admin!" });
  } else {
    res.status(401).json({ error: "Incorrect password." });
  }
});

// ── Admin: read ──
app.get("/api/admin/jobs",         adminAuth, (_req, res) => res.json({ jobs:         db.prepare("SELECT * FROM dental_jobs ORDER BY created_at DESC").all() }));
app.get("/api/admin/workers",      adminAuth, (_req, res) => res.json({ workers:      db.prepare("SELECT * FROM dental_workers ORDER BY created_at DESC").all() }));
app.get("/api/admin/applications", adminAuth, (_req, res) => res.json({ applications: db.prepare("SELECT a.*, j.position, j.practice, j.city FROM dental_applications a JOIN dental_jobs j ON a.job_id=j.id ORDER BY a.created_at DESC").all() }));
app.get("/api/admin/invitations",  adminAuth, (_req, res) => res.json({ invitations:  db.prepare("SELECT i.*, w.role, w.city FROM practice_invitations i JOIN dental_workers w ON i.worker_id=w.id ORDER BY i.created_at DESC").all() }));
app.get("/api/admin/availability", adminAuth, (_req, res) => res.json({ availability: db.prepare("SELECT * FROM dental_availability ORDER BY created_at DESC").all() }));
app.get("/api/admin/subscriptions", adminAuth, (_req, res) => res.json({ subscriptions: db.prepare("SELECT * FROM practice_subscriptions ORDER BY created_at DESC").all() }));
app.delete("/api/admin/availability/:id", adminAuth, (req, res) => {
  db.prepare("DELETE FROM dental_availability WHERE id = ?").run(req.params.id);
  res.json({ message: "Availability listing deleted." });
});

// ── Admin: create job manually ──
app.post("/api/admin/jobs", adminAuth, (req, res) => {
  const { practice, position, job_type, city, pay_rate, dates, description, contact_name, contact_email } = req.body;
  if (!practice || !position || !job_type || !city) {
    return res.status(400).json({ error: "practice, position, job_type and city are required." });
  }
  try {
    const result = db.prepare(`
      INSERT INTO dental_jobs (practice, position, job_type, city, pay_rate, dates, description, contact_name, contact_email, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
    `).run(practice, position, job_type, city, pay_rate || null, dates || null, description || null, contact_name || "Admin", contact_email || "admin@thedentalhire.com");
    res.status(201).json({ job: db.prepare("SELECT * FROM dental_jobs WHERE id = ?").get(result.lastInsertRowid) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: update job status ──
app.patch("/api/admin/jobs/:id", adminAuth, (req, res) => {
  const { status } = req.body;
  if (!["active", "inactive", "filled"].includes(status)) {
    return res.status(400).json({ error: "status must be active, inactive, or filled." });
  }
  db.prepare("UPDATE dental_jobs SET status = ? WHERE id = ?").run(status, req.params.id);
  res.json({ message: "Job updated." });
});

// ── Admin: delete job ──
app.delete("/api/admin/jobs/:id", adminAuth, (req, res) => {
  db.prepare("DELETE FROM dental_jobs WHERE id = ?").run(req.params.id);
  res.json({ message: "Job deleted." });
});

// ── Admin: delete worker ──
app.delete("/api/admin/workers/:id", adminAuth, (req, res) => {
  db.prepare("DELETE FROM dental_workers WHERE id = ?").run(req.params.id);
  res.json({ message: "Worker deleted." });
});

// Catch-all → index.html
app.get("*", (_req, res) => res.sendFile(join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`DentalHire NC running on http://localhost:${PORT}`));
