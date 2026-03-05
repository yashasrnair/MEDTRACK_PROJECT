from flask import Flask, render_template, request, redirect, session, url_for
import sqlite3
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "database.db")
con = sqlite3.connect(DB_PATH)

app = Flask(__name__)
app.secret_key = "secret123"
def get_db():
    return sqlite3.connect(DB_PATH)
if not os.path.exists(DB_PATH):
    con = sqlite3.connect(DB_PATH)
    with open("dash.sql") as f:
        con.executescript(f.read())
    con.commit()
    con.close()
    def get_db():
        return sqlite3.connect(DB_PATH)


# ---------------- REGISTER ----------------
@app.route('/register', methods=['GET', 'POST'])
def register():
    if request.method == 'POST':
        name = request.form['name']
        phone = request.form['phone']
        age = request.form['age']
        email = request.form['email']
        password = request.form['password']

        con = get_db()
        cur = con.cursor()
        cur.execute("INSERT INTO user (name, phone, age, email, password) VALUES (?,?,?,?,?)",
                    (name, phone, age, email, password))
        con.commit()
        con.close()
        return redirect(url_for('login'))

    return render_template('register.html')

# ---------------- LOGIN ----------------
@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        email = request.form["email"]
        password = request.form["password"]

        con = get_db()
        cur = con.cursor()
        cur.execute("SELECT * FROM user WHERE email=? AND password=?", (email, password))
        user = cur.fetchone()
        con.close()

        if user:
            session["user_id"] = user[0]
            return redirect(url_for("home"))
        else:
            return "Invalid login"

    return render_template("login.html")

# ---------------- HOME ----------------
@app.route("/home")
def home():
    if "user_id" not in session:
        return redirect(url_for("login"))

    user_id = session["user_id"]
    con = get_db()
    cur = con.cursor()

    # Fetch user info
    cur.execute("SELECT * FROM user WHERE id=?", (user_id,))
    row = cur.fetchone()

    # Fetch medicines assigned to user
  
    con = sqlite3.connect('database.db')
    cur = con.cursor()

    cur.execute("""
    CREATE TABLE IF NOT EXISTS user_medicines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        medicine_name TEXT NOT NULL,
        dosage TEXT,
        time TEXT
    )
    """)
    medicines = cur.fetchall()
  

    con.commit()
    con.close()



    return render_template("home.html", row=row, medicines=medicines)

# ---------------- HISTORY ----------------


@app.route("/history2")
def history():
    # 1️⃣ Check if user is logged in
    if "user_id" not in session:
        return redirect(url_for("login"))

    user_id = session["user_id"]

    # 2️⃣ Connect to the database
    con = sqlite3.connect("database.db")
    cur = con.cursor()

    # 3️⃣ Fetch history using your SQL query
    cur.execute("""
        SELECT h.id, m.name, m.dosage, m.time, h.taken
        FROM medicine_history h
        INNER JOIN medicine m ON h.medicine_id = m.id
        WHERE h.user_id = ?
        ORDER BY m.time
    """, (user_id,))

    history_data = cur.fetchall()
    con.close()

    # 4️⃣ Pass to the template
    return render_template("history2.html", history2=history_data)

# ---------------- ADD MEDICINE ----------------
@app.route("/addmedicine",methods=["GET","POST"])
def addmedicine():
    if request.method == "POST":
        name = request.form["name"]
        dosage = request.form["dosage"]
        amount = request.form["amount"]
        time = request.form["time"]
        start_date = request.form["start_date"]
        finish_date = request.form["finish_date"]
    

        con = sqlite3.connect("database.db")
        cur = con.cursor()

        cur.execute("""
        INSERT INTO medicines
        (name,dosage,amount,time,start_date,finish_date)
        VALUES (?,?,?,?,?,?)
        """,(name,dosage,amount,time,start_date,finish_date))

        
        

        con.commit()
        con.close()

        return redirect("/home")

    return render_template("addmedicine.html")


@app.route("/taken/<int:id>")
def taken(id):
    con = sqlite3.connect("database.db")
    cur = con.cursor()

    cur.execute("UPDATE medicine SET taken=1 WHERE id=?", (id,))
    con.commit()
    con.close()

    return redirect(url_for("home"))

@app.route("/notification/<int:id>")
def notification(id):
    con = sqlite3.connect("database.db")
    cur = con.cursor()

    cur.execute("SELECT notification FROM medicine WHERE id=?", (id,))
    status = cur.fetchone()[0]

    if status == 1:
        cur.execute("UPDATE medicine SET notification=0 WHERE id=?", (id,))
    else:
        cur.execute("UPDATE medicine SET notification=1 WHERE id=?", (id,))

    con.commit()
    con.close()

    return redirect(url_for("home"))

# ---------------- LOGOUT ----------------
@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))

if __name__ == "__main__":
    app.run(debug=True, use_reloader=False)