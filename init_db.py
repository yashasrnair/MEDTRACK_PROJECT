import sqlite3
import os

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "database.db")

con = sqlite3.connect(DB_PATH)
cur = con.cursor()


# Users table
cur.execute("""
CREATE TABLE IF NOT EXISTS user (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    phone TEXT,
    age TEXT,
    gender TEXT,
    email TEXT UNIQUE,
    password TEXT
)
""")

# User-Medicine assignment table
cur.execute("""
CREATE TABLE medicines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    dosage TEXT,
    amount TEXT,
    time TEXT,
    start_date TEXT,
    finish_date TEXT
    taken INTEGER DEFAULT 0,
    notification INTEGER DEFAULT 1
)
""")

# Medicine history table
cur.execute("""
CREATE TABLE IF NOT EXISTS medicine_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    medicine_id INTEGER NOT NULL,
    taken INTEGER DEFAULT 0,
    date TEXT DEFAULT (DATE('now')),
    FOREIGN KEY(user_id) REFERENCES user(id),
    FOREIGN KEY(medicine_id) REFERENCES medicines(id)
)
""")

cur.execute('''
INSERT OR IGNORE INTO user (name, phone, age, email, password)
VALUES (?, ?, ?, ?, ?)
''', ("Test User", "1234567890", "25", "test@gmail.com", "1234"))


cur.execute("SELECT * FROM medicines")
data = cur.fetchall()

print(data)

con.close()
print("Table created successfully!")
