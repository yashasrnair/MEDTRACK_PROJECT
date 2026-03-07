from flask import Flask, render_template, request, redirect, session, url_for, jsonify, send_from_directory
import sqlite3
import os
from datetime import date, datetime
from init_db import init_db, DB_PATH

app = Flask(__name__)
app.secret_key = "medtrack-secret-2025"

init_db()

def get_db():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con

def login_required(f):
    from functools import wraps
    @wraps(f)
    def decorated(*args, **kwargs):
        if "user_id" not in session:
            return redirect(url_for("login"))
        return f(*args, **kwargs)
    return decorated

def admin_required(f):
    from functools import wraps
    @wraps(f)
    def decorated(*args, **kwargs):
        if "user_id" not in session or session.get("user_role") != "admin":
            return redirect(url_for("login"))
        return f(*args, **kwargs)
    return decorated

# ── Service worker (root scope) ──────────────────────────────────────────────
@app.route("/sw.js")
def service_worker():
    return send_from_directory(
        os.path.join(app.root_path, "static"), "sw.js",
        mimetype="application/javascript"
    )

@app.route('/favicon.ico')
def favicon():
    return send_from_directory(
        os.path.join(app.root_path, 'static', 'images'),
        'logo.jpg', mimetype='image/jpeg'
    )

# ── Landing ──────────────────────────────────────────────────────────────────
@app.route("/")
def landing():
    if "user_id" in session:
        if session.get("user_role") == "admin":
            return redirect(url_for("admin_dashboard"))
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
        cg_name  = request.form.get("caregiver_name", "").strip()
        cg_phone = request.form.get("caregiver_phone", "").strip()
        cg_email = request.form.get("caregiver_email", "").strip()
        con = get_db()
        cur = con.cursor()
        try:
            cur.execute("""
                INSERT INTO user (name,phone,age,gender,email,password,caregiver_name,caregiver_phone,caregiver_email)
                VALUES (?,?,?,?,?,?,?,?,?)
            """, (name, phone, age, gender, email, password, cg_name, cg_phone, cg_email))
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
            session["user_email"] = user["email"]
            session["user_role"]  = user["role"] if user["role"] else "user"
            if session["user_role"] == "admin":
                return redirect(url_for("admin_dashboard"))
            return redirect(url_for("dashboard"))
        return render_template("login.html", error="Invalid email or password.")
    return render_template("login.html")

# ── Logout ────────────────────────────────────────────────────────────────────
@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("landing"))

# ════════════════════════════════════════════════════
#  USER ROUTES
# ════════════════════════════════════════════════════

# ── Dashboard ─────────────────────────────────────────────────────────────────
@app.route("/dashboard")
@login_required
def dashboard():
    user_id = session["user_id"]
    today   = date.today().isoformat()
    con     = get_db()
    cur     = con.cursor()

    # All medicines active today
    cur.execute("""
        SELECT m.*,
               CASE WHEN m.finish_date < ? THEN 1 ELSE 0 END as is_expired
        FROM medicines m
        WHERE m.user_id=? AND m.start_date<=? AND m.finish_date>=?
        ORDER BY m.time
    """, (today, user_id, today, today))
    medicines = [dict(r) for r in cur.fetchall()]

    # Get today's history to show taken_at times and not-taken status
    cur.execute("""
        SELECT medicine_id, taken, taken_at FROM medicine_history
        WHERE user_id=? AND date=?
    """, (user_id, today))
    history_map = {}
    for h in cur.fetchall():
        history_map[h["medicine_id"]] = {"taken": h["taken"], "taken_at": h["taken_at"]}

    # Merge history info into medicines
    for med in medicines:
        h = history_map.get(med["id"])
        if h:
            med["history_taken"]  = h["taken"]
            med["history_taken_at"] = h["taken_at"]
            med["in_history"] = True
        else:
            med["history_taken"]    = None
            med["history_taken_at"] = None
            med["in_history"] = False

    # Inventory: calculate days/doses remaining using actual dose amount
    import re as _re
    for med in medicines:
        if med["total_quantity"] > 0 and med["quantity_remaining"] is not None:
            _m = _re.match(r'[\s]*(\d+(?:\.\d+)?)', str(med.get("amount") or "1"))
            dose_units = max(1, int(float(_m.group(1)))) if _m else 1
            doses_left = med["quantity_remaining"] // dose_units if dose_units > 0 else med["quantity_remaining"]
            med["doses_left"]  = doses_left
            med["days_left"]   = doses_left   # 1 dose per day assumed
            med["stock_empty"] = med["quantity_remaining"] <= 0
            # Warn if stock runs out before finish_date
            from datetime import date as _date, timedelta
            try:
                finish = _date.fromisoformat(med["finish_date"])
                days_remaining_in_course = (finish - _date.today()).days + 1
                med["stock_before_end"] = doses_left < days_remaining_in_course
            except Exception:
                med["stock_before_end"] = False
            med["refill_soon"] = (0 < med["quantity_remaining"] <= dose_units * 5) or med["stock_before_end"]
        else:
            med["doses_left"]       = None
            med["days_left"]        = None
            med["stock_empty"]      = False
            med["stock_before_end"] = False
            med["refill_soon"]      = False

    # Caregiver info
    cur.execute("SELECT caregiver_name,caregiver_phone,caregiver_email FROM user WHERE id=?", (user_id,))
    u = cur.fetchone()
    caregiver = dict(u) if u else {}
    con.close()

    return render_template("dashboard.html", medicines=medicines,
                           user_name=session["user_name"],
                           caregiver=caregiver)

# ── Schedule ──────────────────────────────────────────────────────────────────
@app.route("/schedule")
@login_required
def schedule():
    user_id = session["user_id"]
    today   = date.today().isoformat()
    con = get_db()
    cur = con.cursor()
    cur.execute("SELECT * FROM medicines WHERE user_id=? ORDER BY start_date DESC", (user_id,))
    medicines = [dict(r) for r in cur.fetchall()]
    for m in medicines:
        m["is_expired"] = m["finish_date"] < today
    con.close()
    return render_template("schedule.html", medicines=medicines,
                           user_name=session["user_name"])

# ── Add Medicine ──────────────────────────────────────────────────────────────
@app.route("/addmedicine", methods=["GET", "POST"])
@login_required
def addmedicine():
    if request.method == "POST":
        user_id     = session["user_id"]
        name        = request.form["name"].strip()
        dosage      = request.form["dosage"].strip()
        med_type    = request.form["type"].strip()
        amount      = request.form["amount"].strip()
        time_val    = request.form["time"].strip()
        start_date  = request.form["start_date"].strip()
        finish_date = request.form["finish_date"].strip()
        total_qty   = int(request.form.get("total_quantity", 0) or 0)
        con = get_db()
        cur = con.cursor()
        cur.execute("""
            INSERT INTO medicines (user_id,name,dosage,type,amount,time,start_date,finish_date,
                                   total_quantity,quantity_remaining)
            VALUES (?,?,?,?,?,?,?,?,?,?)
        """, (user_id, name, dosage, med_type, amount, time_val, start_date, finish_date,
              total_qty, total_qty))
        con.commit()
        con.close()
        return redirect(url_for("schedule"))
    return render_template("addmedicine.html", user_name=session["user_name"])

# ── Delete Medicine ───────────────────────────────────────────────────────────
@app.route("/delete_medicine/<int:med_id>")
@login_required
def delete_medicine(med_id):
    user_id = session["user_id"]
    con = get_db()
    cur = con.cursor()
    cur.execute("DELETE FROM medicines WHERE id=? AND user_id=?", (med_id, user_id))
    con.commit()
    con.close()
    return redirect(url_for("schedule"))

# ── Mark Taken ────────────────────────────────────────────────────────────────
@app.route("/taken/<int:med_id>")
@login_required
def taken(med_id):
    user_id  = session["user_id"]
    today    = date.today().isoformat()
    taken_at = datetime.now().strftime("%H:%M")
    con = get_db()
    cur = con.cursor()
    cur.execute("SELECT * FROM medicines WHERE id=? AND user_id=?", (med_id, user_id))
    med = cur.fetchone()
    if med:
        # Do NOT permanently set taken=1 on medicines row.
        # Per-day taken state is derived from medicine_history.
        # Decrement by the actual dose amount (parse numeric from e.g. "2 tablets")
        if med["quantity_remaining"] and med["quantity_remaining"] > 0:
            import re as _re
            _m = _re.match(r'[\s]*(\d+(?:\.\d+)?)', str(med["amount"] or "1"))
            dose_units = int(float(_m.group(1))) if _m else 1
            dose_units = max(1, dose_units)
            cur.execute(
                "UPDATE medicines SET quantity_remaining=MAX(0,quantity_remaining-?) WHERE id=?",
                (dose_units, med_id)
            )
        cur.execute("""
            INSERT OR IGNORE INTO medicine_history
                (user_id,medicine_id,medicine_name,dosage,scheduled_time,taken,taken_at,date)
            VALUES (?,?,?,?,?,1,?,?)
        """, (user_id, med_id, med["name"], med["dosage"], med["time"], taken_at, today))
    con.commit()
    con.close()
    return redirect(url_for("dashboard"))

# ── Toggle Notification ───────────────────────────────────────────────────────
@app.route("/toggle_notification/<int:med_id>")
@login_required
def toggle_notification(med_id):
    user_id = session["user_id"]
    con = get_db()
    cur = con.cursor()
    cur.execute("SELECT notification_enabled FROM medicines WHERE id=? AND user_id=?", (med_id, user_id))
    row = cur.fetchone()
    if row:
        new_val = 0 if row["notification_enabled"] == 1 else 1
        cur.execute("UPDATE medicines SET notification_enabled=? WHERE id=? AND user_id=?",
                    (new_val, med_id, user_id))
        con.commit()
    con.close()
    return redirect(url_for("dashboard"))

# ── Mark Not Taken (JS callback) ──────────────────────────────────────────────
@app.route("/mark_not_taken/<int:med_id>", methods=["POST"])
@login_required
def mark_not_taken(med_id):
    user_id = session["user_id"]
    today   = date.today().isoformat()
    con = get_db()
    cur = con.cursor()
    # Only insert if not already in history for today
    cur.execute("""
        SELECT id FROM medicine_history
        WHERE user_id=? AND medicine_id=? AND date=?
    """, (user_id, med_id, today))
    if not cur.fetchone():
        cur.execute("SELECT * FROM medicines WHERE id=? AND user_id=?", (med_id, user_id))
        med = cur.fetchone()
        if med:  # taken state is derived from history, not the medicines row
            cur.execute("""
                INSERT INTO medicine_history
                    (user_id,medicine_id,medicine_name,dosage,scheduled_time,taken,taken_at,date)
                VALUES (?,?,?,?,?,0,'',?)
            """, (user_id, med_id, med["name"], med["dosage"], med["time"], today))
            con.commit()
    con.close()
    return jsonify({"status": "ok"})

# ── API: full medicine data for JS engine ─────────────────────────────────────
@app.route("/api/medicines")
@login_required
def api_medicines():
    user_id = session["user_id"]
    today   = date.today().isoformat()
    con = get_db()
    cur = con.cursor()
    # Join with today's history to derive per-day taken status.
    # This ensures medicines reset correctly each new day.
    cur.execute("""
        SELECT m.id, m.name, m.type, m.dosage, m.amount, m.time,
               m.start_date, m.finish_date,
               m.notification_enabled,
               m.total_quantity, m.quantity_remaining,
               CASE WHEN mh.id IS NOT NULL THEN mh.taken ELSE 0 END AS taken
        FROM medicines m
        LEFT JOIN medicine_history mh
            ON  mh.medicine_id = m.id
            AND mh.user_id     = m.user_id
            AND mh.date        = ?
        WHERE m.user_id=? AND m.start_date<=? AND m.finish_date>=?
    """, (today, user_id, today, today))
    data = [dict(r) for r in cur.fetchall()]

    # Also get caregiver info
    cur.execute("SELECT caregiver_name,caregiver_phone,caregiver_email FROM user WHERE id=?", (user_id,))
    u = cur.fetchone()
    caregiver = dict(u) if u else {}
    con.close()

    return jsonify({"medicines": data, "caregiver": caregiver})

# ── Caregiver settings ────────────────────────────────────────────────────────
@app.route("/settings", methods=["GET", "POST"])
@login_required
def settings():
    user_id = session["user_id"]
    con = get_db()
    cur = con.cursor()
    if request.method == "POST":
        cg_name  = request.form.get("caregiver_name", "").strip()
        cg_phone = request.form.get("caregiver_phone", "").strip()
        cg_email = request.form.get("caregiver_email", "").strip()
        cur.execute("""
            UPDATE user SET caregiver_name=?,caregiver_phone=?,caregiver_email=?
            WHERE id=?
        """, (cg_name, cg_phone, cg_email, user_id))
        con.commit()
        con.close()
        return redirect(url_for("settings"))
    cur.execute("SELECT * FROM user WHERE id=?", (user_id,))
    user = dict(cur.fetchone())
    con.close()
    return render_template("settings.html", user=user, user_name=session["user_name"])

# ── History ───────────────────────────────────────────────────────────────────
@app.route("/history")
@login_required
def history():
    user_id = session["user_id"]
    con = get_db()
    cur = con.cursor()
    cur.execute("""
        SELECT * FROM medicine_history WHERE user_id=?
        ORDER BY date DESC, scheduled_time DESC
    """, (user_id,))
    history_data = [dict(r) for r in cur.fetchall()]
    con.close()
    return render_template("history.html", history_data=history_data,
                           user_name=session["user_name"])

# ════════════════════════════════════════════════════
#  ADMIN ROUTES
# ════════════════════════════════════════════════════

@app.route("/admin")
@admin_required
def admin_dashboard():
    con = get_db()
    cur = con.cursor()

    # All users (non-admin)
    cur.execute("SELECT * FROM user WHERE role!='admin' ORDER BY id DESC")
    users = [dict(r) for r in cur.fetchall()]

    # System stats
    cur.execute("SELECT COUNT(*) as c FROM user WHERE role!='admin'")
    total_users = cur.fetchone()["c"]
    cur.execute("SELECT COUNT(*) as c FROM medicines")
    total_medicines = cur.fetchone()["c"]
    cur.execute("SELECT COUNT(*) as c FROM medicine_history")
    total_history = cur.fetchone()["c"]
    cur.execute("SELECT COUNT(*) as c FROM medicine_history WHERE taken=1")
    taken_count = cur.fetchone()["c"]
    cur.execute("SELECT COUNT(*) as c FROM medicine_history WHERE taken=0")
    missed_count = cur.fetchone()["c"]

    adherence = int(taken_count / total_history * 100) if total_history > 0 else 0

    # Recent history (last 50 entries across all users)
    cur.execute("""
        SELECT mh.*, u.name as user_name FROM medicine_history mh
        JOIN user u ON mh.user_id=u.id
        ORDER BY mh.date DESC, mh.scheduled_time DESC LIMIT 50
    """)
    recent_history = [dict(r) for r in cur.fetchall()]

    # Notification engine health: check last 5 mins of activity
    # (We track this via history recency)
    cur.execute("""
        SELECT date, COUNT(*) as c FROM medicine_history
        GROUP BY date ORDER BY date DESC LIMIT 7
    """)
    daily_stats = [dict(r) for r in cur.fetchall()]

    con.close()
    return render_template("admin_dashboard.html",
                           users=users,
                           total_users=total_users,
                           total_medicines=total_medicines,
                           total_history=total_history,
                           taken_count=taken_count,
                           missed_count=missed_count,
                           adherence=adherence,
                           recent_history=recent_history,
                           daily_stats=daily_stats,
                           user_name=session["user_name"])

@app.route("/admin/user/<int:uid>")
@admin_required
def admin_user_detail(uid):
    con = get_db()
    cur = con.cursor()
    cur.execute("SELECT * FROM user WHERE id=?", (uid,))
    user = dict(cur.fetchone())
    cur.execute("SELECT * FROM medicines WHERE user_id=? ORDER BY start_date DESC", (uid,))
    medicines = [dict(r) for r in cur.fetchall()]
    cur.execute("""
        SELECT * FROM medicine_history WHERE user_id=?
        ORDER BY date DESC, scheduled_time DESC
    """, (uid,))
    history = [dict(r) for r in cur.fetchall()]
    taken  = sum(1 for h in history if h["taken"] == 1)
    missed = sum(1 for h in history if h["taken"] == 0)
    adherence = int(taken / len(history) * 100) if history else 0
    con.close()
    return render_template("admin_user_detail.html",
                           profile=user,
                           medicines=medicines,
                           history=history,
                           taken=taken,
                           missed=missed,
                           adherence=adherence,
                           user_name=session["user_name"])

@app.route("/admin/delete_user/<int:uid>")
@admin_required
def admin_delete_user(uid):
    con = get_db()
    cur = con.cursor()
    cur.execute("DELETE FROM medicine_history WHERE user_id=?", (uid,))
    cur.execute("DELETE FROM medicines WHERE user_id=?", (uid,))
    cur.execute("DELETE FROM user WHERE id=? AND role!='admin'", (uid,))
    con.commit()
    con.close()
    return redirect(url_for("admin_dashboard"))

@app.route("/admin/reset_password/<int:uid>", methods=["POST"])
@admin_required
def admin_reset_password(uid):
    new_pass = request.form.get("new_password", "").strip()
    if new_pass:
        con = get_db()
        cur = con.cursor()
        cur.execute("UPDATE user SET password=? WHERE id=? AND role!='admin'", (new_pass, uid))
        con.commit()
        con.close()
    return redirect(url_for("admin_user_detail", uid=uid))

if __name__ == "__main__":
    app.run(debug=True, use_reloader=False)
