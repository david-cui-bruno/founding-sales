PRAGMA user_version = 26;
CREATE TABLE handle (
    ROWID INTEGER PRIMARY KEY,
    id TEXT NOT NULL
);
CREATE TABLE message (
    ROWID INTEGER PRIMARY KEY,
    handle_id INTEGER NOT NULL,
    date INTEGER NOT NULL,
    is_from_me INTEGER NOT NULL,
    text TEXT,
    attributedBody BLOB
);
INSERT INTO handle (ROWID, id) VALUES (1, 'synthetic@example.invalid');
INSERT INTO message (handle_id, date, is_from_me, text) VALUES (1, 799999700000000000, 0, NULL);
INSERT INTO message (handle_id, date, is_from_me, text) VALUES (1, 799999940000000000, 1, 'Synthetic outgoing');
INSERT INTO message (handle_id, date, is_from_me, text) VALUES (1, 100000000000000000, 1, 'Outside bounded window');
