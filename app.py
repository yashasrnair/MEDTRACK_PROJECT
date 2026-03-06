from flask import Flask, render_template, request, redirect, session, url_for, jsonify, send_from_directory
import sqlite3
import os
from datetime import date
from init_db import init_db, DB_PATH

app = Flask(__name__)
app.secret_key = os.urandom(24)

init_db()

def get_db():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con

# ── Serve service worker from root scope ──────────────────────────────────────
@app.route("/sw.js")
def service_worker():
    return send_from_directory(
        os.path.join(app.root_path, "static"),
        "sw.js",
        mimetype="application/javascript"
    )


# ── Landing ──────────────────────────────────────────────────────────────────
@app.route("/")
def landing():
    if "user_id" in session:
        return redirect(url_for("dashboard"))
    return render_template("landing.html")

# ── Register ─────────────────────────────────────────────────────────────────
@app.route("/register", methods=["GET", "POST"])
def register():
    if request.method == "POST":
        name     = request.form["name"].strip()
        phone    = request.form["phone"].strip()
        age      = request.form["age"].strip()
        gender   = request.form["gender"].strip()
        email    = request.form["email"].strip().lower()
        password = request.form["password"].strip()
        con = get_db()
        cur = con.cursor()
        try:
            cur.execute(
                "INSERT INTO user (name,phone,age,gender,email,password) VALUES (?,?,?,?,?,?)",
                (name, phone, age, gender, email, password)
            )
            con.commit()
        except sqlite3.IntegrityError:
            con.close()
            return render_template("register.html", error="Email already registered.")
        con.close()
        return redirect(url_for("login"))
    return render_template("register.html")

# ── Login ─────────────────────────────────────────────────────────────────────
@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        email    = request.form["email"].strip().lower()
        password = request.form["password"].strip()
        con = get_db()
        cur = con.cursor()
        cur.execute("SELECT * FROM user WHERE email=? AND password=?", (email, password))
        user = cur.fetchone()
        con.close()
        if user:
            session["user_id"]    = user["id"]
            session["user_name"]  = user["name"]
            session["user_phone"] = user["phone"]
            return redirect(url_for("dashboard"))
        return render_template("login.html", error="Invalid email or password.")
    return render_template("login.html")

# ── Logout ────────────────────────────────────────────────────────────────────
@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("landing"))

# ── Dashboard ─────────────────────────────────────────────────────────────────
@app.route("/dashboard")
def dashboard():
    if "user_id" not in session:
        return redirect(url_for("login"))
    user_id = session["user_id"]
    today   = date.today().isoformat()
    con     = get_db()
    cur     = con.cursor()
    cur.execute("""
        SELECT * FROM medicines
        WHERE user_id=? AND start_date<=? AND finish_date>=?
        ORDER BY time
    """, (user_id, today, today))
    medicines = [dict(r) for r in cur.fetchall()]
    con.close()
    return render_template("dashboard.html", medicines=medicines,
                           user_name=session["user_name"])

# ── Schedule ──────────────────────────────────────────────────────────────────
@app.route("/schedule")
def schedule():
    if "user_id" not in session:
        return redirect(url_for("login"))
    user_id = session["user_id"]
    con     = get_db()
    cur     = con.cursor()
    cur.execute("SELECT * FROM medicines WHERE user_id=? ORDER BY start_date DESC", (user_id,))
    medicines = [dict(r) for r in cur.fetchall()]
    con.close()
    return render_template("schedule.html", medicines=medicines,
                           user_name=session["user_name"])

# ── Add Medicine ──────────────────────────────────────────────────────────────
@app.route("/addmedicine", methods=["GET", "POST"])
def addmedicine():
    if "user_id" not in session:
        return redirect(url_for("login"))
    if request.method == "POST":
        user_id     = session["user_id"]
        name        = request.form["name"].strip()
        dosage      = request.form["dosage"].strip()
        med_type    = request.form["type"].strip()
        amount      = request.form["amount"].strip()
        time_val    = request.form["time"].strip()
        start_date  = request.form["start_date"].strip()
        finish_date = request.form["finish_date"].strip()
        con = get_db()
        cur = con.cursor()
        cur.execute("""
            INSERT INTO medicines (user_id,name,dosage,type,amount,time,start_date,finish_date)
            VALUES (?,?,?,?,?,?,?,?)
        """, (user_id, name, dosage, med_type, amount, time_val, start_date, finish_date))
        con.commit()
        con.close()
        return redirect(url_for("schedule"))
    return render_template("addmedicine.html", user_name=session["user_name"])

# ── Delete Medicine ───────────────────────────────────────────────────────────
@app.route("/delete_medicine/<int:med_id>")
def delete_medicine(med_id):
    if "user_id" not in session:
        return redirect(url_for("login"))
    user_id = session["user_id"]
    con = get_db()
    cur = con.cursor()
    cur.execute("DELETE FROM medicines WHERE id=? AND user_id=?", (med_id, user_id))
    con.commit()
    con.close()
    return redirect(url_for("schedule"))

# ── Mark Taken ────────────────────────────────────────────────────────────────
@app.route("/taken/<int:med_id>")
def taken(med_id):
    if "user_id" not in session:
        return redirect(url_for("login"))
    user_id = session["user_id"]
    today   = date.today().isoformat()
    con     = get_db()
    cur     = con.cursor()
    cur.execute("UPDATE medicines SET taken=1 WHERE id=? AND user_id=?", (med_id, user_id))
    cur.execute("SELECT * FROM medicines WHERE id=? AND user_id=?", (med_id, user_id))
    med = cur.fetchone()
    if med:
        cur.execute("""
            INSERT OR IGNORE INTO medicine_history
                (user_id,medicine_id,medicine_name,dosage,scheduled_time,taken,date)
            VALUES (?,?,?,?,?,1,?)
        """, (user_id, med_id, med["name"], med["dosage"], med["time"], today))
    con.commit()
    con.close()
    return redirect(url_for("dashboard"))

# ── Toggle Notification ───────────────────────────────────────────────────────
@app.route("/toggle_notification/<int:med_id>")
def toggle_notification(med_id):
    if "user_id" not in session:
        return redirect(url_for("login"))
    user_id = session["user_id"]
    con     = get_db()
    cur     = con.cursor()
    cur.execute("SELECT notification_enabled FROM medicines WHERE id=? AND user_id=?", (med_id, user_id))
    row = cur.fetchone()
    if row:
        new_val = 0 if row["notification_enabled"] == 1 else 1
        cur.execute("UPDATE medicines SET notification_enabled=? WHERE id=? AND user_id=?",
                    (new_val, med_id, user_id))
        con.commit()
    con.close()
    return redirect(url_for("dashboard"))

# ── Mark Not Taken (JS callback after deadline passes) ────────────────────────
@app.route("/mark_not_taken/<int:med_id>", methods=["POST"])
def mark_not_taken(med_id):
    if "user_id" not in session:
        return jsonify({"status": "error"}), 401
    user_id = session["user_id"]
    today   = date.today().isoformat()
    con     = get_db()
    cur     = con.cursor()
    cur.execute("SELECT * FROM medicines WHERE id=? AND user_id=?", (med_id, user_id))
    med = cur.fetchone()
    if med and med["taken"] == 0:
        cur.execute("""
            INSERT OR IGNORE INTO medicine_history
                (user_id,medicine_id,medicine_name,dosage,scheduled_time,taken,date)
            VALUES (?,?,?,?,?,0,?)
        """, (user_id, med_id, med["name"], med["dosage"], med["time"], today))
        con.commit()
    con.close()
    return jsonify({"status": "ok"})

# ── API: medicines JSON for reminder engine ───────────────────────────────────
@app.route("/api/medicines")
def api_medicines():
    if "user_id" not in session:
        return jsonify([])
    user_id = session["user_id"]
    today   = date.today().isoformat()
    con     = get_db()
    cur     = con.cursor()
    cur.execute("""
        SELECT id,name,time,notification_enabled,taken
        FROM medicines WHERE user_id=? AND start_date<=? AND finish_date>=?
    """, (user_id, today, today))
    data = [dict(r) for r in cur.fetchall()]
    con.close()
    return jsonify(data)

# ── History ───────────────────────────────────────────────────────────────────
@app.route("/history")
def history():
    if "user_id" not in session:
        return redirect(url_for("login"))
    user_id = session["user_id"]
    con     = get_db()
    cur     = con.cursor()
    cur.execute("""
        SELECT * FROM medicine_history WHERE user_id=?
        ORDER BY date DESC, scheduled_time DESC
    """, (user_id,))
    history_data = [dict(r) for r in cur.fetchall()]
    con.close()
    return render_template("history.html", history_data=history_data,
                           user_name=session["user_name"])

# icon--
@app.route('/favicon.ico')
def favicon():
    return send_from_directory(os.path.join(app.root_path, 'static', 'images'),
                               'logo.jpg', mimetype='image/jpeg')

if __name__ == "__main__":
    app.run(debug=True, use_reloader=False)