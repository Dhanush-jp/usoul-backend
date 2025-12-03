// server/index.js
require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const webpush = require("web-push");
const cron = require("node-cron");
const path = require("path");

const DB_FILE = path.join(__dirname, "usoul.db");
const JWT_SECRET = process.env.JWT_SECRET || "dev_jwt_secret_change_me";

const VAPID_PUBLIC =
  process.env.VAPID_PUBLIC ||
  "BB9GS8rajywuH8yyKcHNUsDjIvC_oAnhhtH28ERg6K7JmevhGSQ5ILsaRPuwati12QFhBzLTQR-3efmTBlzWCCQ";

const VAPID_PRIVATE =
  process.env.VAPID_PRIVATE ||
  "YVTssmwvxzBqYescnvbkYoQ71xUJ2uaN_mAi_AGfoTw";

webpush.setVapidDetails("mailto:dev@example.com", VAPID_PUBLIC, VAPID_PRIVATE);

// ============= DATABASE =============
const db = new sqlite3.Database(DB_FILE);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password_hash TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      endpoint TEXT,
      keys_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      message TEXT,
      notify_at DATETIME,
      timezone TEXT,
      notified INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ============= AUTH MIDDLEWARE ============
function authMiddleware(req, res, next) {
  const h = req.headers.authorization;
  if (!h) return res.status(401).json({ error: "no auth" });
  const token = h.split(" ")[1];

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: "invalid token" });
  }
}

// ============= AUTH ROUTES =============
app.post("/api/register", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: "missing" });

  try {
    const hash = await bcrypt.hash(password, 10);
    db.run(
      `INSERT INTO users (username, password_hash) VALUES (?, ?)`,
      [username, hash],
      function (err) {
        if (err) return res.status(400).json({ error: "username exists" });

        const user = { id: this.lastID, username };
        const token = jwt.sign(user, JWT_SECRET, { expiresIn: "30d" });
        res.json({ token, user });
      }
    );
  } catch (err) {
    res.status(500).json({ error: "server error" });
  }
});

app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: "missing" });

  db.get(
    `SELECT * FROM users WHERE username = ?`,
    [username],
    async (err, user) => {
      if (err || !user)
        return res.status(400).json({ error: "invalid credentials" });

      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) return res.status(400).json({ error: "invalid credentials" });

      const token = jwt.sign({ id: user.id, username }, JWT_SECRET, {
        expiresIn: "30d",
      });
      res.json({ token, user: { id: user.id, username } });
    }
  );
});

// ============= SUBSCRIBE FOR PUSH =============
app.post("/api/subscribe", authMiddleware, (req, res) => {
  const sub = req.body.subscription;
  if (!sub || !sub.endpoint)
    return res.status(400).json({ error: "invalid subscription" });

  db.run(
    `INSERT INTO subscriptions (user_id, endpoint, keys_json)
     VALUES (?, ?, ?)`,
    [req.user.id, sub.endpoint, JSON.stringify(sub.keys || {})],
    function (err) {
      if (err) return res.status(500).json({ error: "db error" });
      res.json({ ok: true });
    }
  );
});

// ============= REMINDERS CRUD =============
app.post("/api/reminders", authMiddleware, (req, res) => {
  const { message, notify_at, timezone } = req.body;
  if (!message || !notify_at)
    return res.status(400).json({ error: "missing" });

  db.run(
    `INSERT INTO reminders (user_id, message, notify_at, timezone)
     VALUES (?, ?, ?, ?)`,
    [req.user.id, message, notify_at, timezone || "UTC"],
    function (err) {
      if (err) return res.status(500).json({ error: "db error" });
      res.json({ id: this.lastID });
    }
  );
});

app.get("/api/reminders", authMiddleware, (req, res) => {
  db.all(
    `SELECT * FROM reminders WHERE user_id = ? ORDER BY notify_at ASC`,
    [req.user.id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "db error" });
      res.json({ reminders: rows });
    }
  );
});

// ⭐ NEW — UPDATE reminder
app.put("/api/reminders/:id", authMiddleware, (req, res) => {
  const { message, notify_at } = req.body;

  db.run(
    `UPDATE reminders SET message=?, notify_at=?
     WHERE id=? AND user_id=?`,
    [message, notify_at, req.params.id, req.user.id],
    function (err) {
      if (err) return res.status(500).json({ error: "db error" });
      res.json({ ok: true });
    }
  );
});

// ⭐ NEW — DELETE reminder
app.delete("/api/reminders/:id", authMiddleware, (req, res) => {
  db.run(
    `DELETE FROM reminders WHERE id=? AND user_id=?`,
    [req.params.id, req.user.id],
    function (err) {
      if (err) return res.status(500).json({ error: "db error" });
      res.json({ ok: true });
    }
  );
});

// ============= VAPID PUBLIC KEY =============
app.get("/api/vapidPublicKey", (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC });
});

// ============= PUSH SENDER =============
function sendPushToUser(user_id, payload) {
  db.all(
    `SELECT * FROM subscriptions WHERE user_id = ?`,
    [user_id],
    (err, rows) => {
      if (err) return;

      rows.forEach((r) => {
        const sub = {
          endpoint: r.endpoint,
          keys: JSON.parse(r.keys_json || "{}"),
        };

        webpush
          .sendNotification(sub, JSON.stringify(payload))
          .catch((e) => {
            console.warn("push failed", e.body);
          });
      });
    }
  );
}

// ============= CRON WORKER =============
cron.schedule("* * * * *", () => {
  const now = new Date().toISOString();

  db.all(
    `SELECT * FROM reminders WHERE notified = 0 AND notify_at <= ?`,
    [now],
    (err, rows) => {
      if (err) return;

      rows.forEach((r) => {
        db.run(`UPDATE reminders SET notified = 1 WHERE id = ?`, [r.id]);
        sendPushToUser(r.user_id, {
          title: "Usoul Reminder",
          message: r.message,
          reminder_id: r.id,
        });
      });
    }
  );
});

// ============= STATIC FILES =============
app.use("/static", express.static(path.join(__dirname, "static")));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log("Usoul server listening on", PORT));
