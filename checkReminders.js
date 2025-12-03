const sqlite3 = require("sqlite3").verbose();
const webpush = require("web-push");
require("dotenv").config();

// -------------------------------
// DATABASE
// -------------------------------
const db = new sqlite3.Database("./usoul.db", (err) => {
  if (err) console.error("❌ DB Error:", err);
  else console.log("📦 Connected to SQLite");
});

// -------------------------------
// VAPID CONFIG
// -------------------------------
webpush.setVapidDetails(
  "mailto:example@domain.com",
  process.env.VAPID_PUBLIC,
  process.env.VAPID_PRIVATE
);

// -------------------------------
// MAIN CHECK FUNCTION
// -------------------------------
function checkDueReminders() {
  console.log("\n⏳ Checking reminders...");

  const nowUTC = new Date().toISOString().slice(0, 16);
  console.log("🔎 Current UTC Time:", nowUTC);

  db.all(
    `
      SELECT reminders.*, users.push_sub 
      FROM reminders
      JOIN users ON reminders.user_id = users.id
      WHERE notified = 0 
      AND notify_at <= ?
    `,
    [nowUTC],
    (err, rows) => {
      if (err) return console.error("❌ DB lookup error:", err);

      if (rows.length === 0) {
        console.log("✔ No due reminders.");
        return;
      }

      console.log(`📌 Found ${rows.length} due reminder(s).`);

      rows.forEach((r) => {
        if (!r.push_sub) {
          console.log(`⚠ No push subscription for user ${r.user_id}`);
          return;
        }

        let sub;
        try {
          sub = JSON.parse(r.push_sub);
        } catch (e) {
          console.log("❌ Invalid push subscription format");
          return;
        }

        const payload = JSON.stringify({
          title: "⏰ Usoul Reminder",
          message: r.message,
          reminder_id: r.id
        });

        console.log("📤 Sending push:", payload);

        webpush.sendNotification(sub, payload)
          .then(() => {
            console.log("✅ Push sent successfully!");

            db.run(
              "UPDATE reminders SET notified = 1 WHERE id = ?",
              [r.id],
              (err2) => {
                if (err2) console.error("❌ Failed to update reminder:", err2);
                else console.log(`✔ Reminder ${r.id} marked as notified.`);
              }
            );
          })
          .catch((errPush) => {
            console.error("❌ Push error:", errPush);
          });
      });
    }
  );
}

// -------------------------------
// RUN EVERY 15 SECONDS
// -------------------------------
console.log("🚀 Reminder worker started!");
setInterval(checkDueReminders, 15000);

checkDueReminders();
