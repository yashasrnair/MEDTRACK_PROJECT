
CREATE TABLE user (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    phone TEXT,
    age INTEGER,
    email TEXT UNIQUE,
    password TEXT
);

DROP TABLE medicines;
CREATE TABLE IF NOT EXISTS medicine (
id INTEGER PRIMARY KEY AUTOINCREMENT,
name TEXT,
dosage TEXT,
amount INTEGER,
time TEXT,
start_date TEXT,
finish_date TEXT
);

-- Assign medicines to users


CREATE TABLE IF NOT EXISTS medicine_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    medicine_id INTEGER NOT NULL,
    taken INTEGER DEFAULT 0,          -- 0 = Not Taken, 1 = Taken
    date TEXT DEFAULT (DATE('now')),  -- record date
    FOREIGN KEY(user_id) REFERENCES user(id),
    FOREIGN KEY(medicine_id) REFERENCES medicine(id)
);




