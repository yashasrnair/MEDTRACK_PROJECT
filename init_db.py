import sqlite3
import os

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "database.db")

def init_db():
    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()

    cur.executescript("""
        CREATE TABLE IF NOT EXISTS user (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            phone TEXT NOT NULL,
            age INTEGER NOT NULL,
            gender TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS medicines (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            dosage TEXT NOT NULL,
            type TEXT NOT NULL,
            amount TEXT NOT NULL,
            time TEXT NOT NULL,
            start_date TEXT NOT NULL,
            finish_date TEXT NOT NULL,
            taken INTEGER DEFAULT 0,
            notification_enabled INTEGER DEFAULT 1,
            FOREIGN KEY(user_id) REFERENCES user(id)
        );

        CREATE TABLE IF NOT EXISTS medicine_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            medicine_id INTEGER NOT NULL,
            medicine_name TEXT NOT NULL,
            dosage TEXT NOT NULL,
            scheduled_time TEXT NOT NULL,
            taken INTEGER DEFAULT 0,
            date TEXT DEFAULT (DATE('now')),
            FOREIGN KEY(user_id) REFERENCES user(id),
            FOREIGN KEY(medicine_id) REFERENCES medicines(id)
        );
    """)

    con.commit()
    con.close()
    print("Database initialized successfully.")

if __name__ == "__main__":
    init_db()