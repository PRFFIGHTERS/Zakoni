-- Схема совместима с SQLite и PostgreSQL (с минимальными правками типов)

CREATE TABLE IF NOT EXISTS legal_documents (
    id              TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    doc_type        TEXT NOT NULL,
    authority       TEXT,
    number          TEXT,
    adoption_date   TEXT,
    publication_date TEXT,
    effective_date  TEXT,
    expiration_date TEXT,
    current_version TEXT,
    status          TEXT DEFAULT 'unknown',
    is_official     INTEGER DEFAULT 0,
    source_url      TEXT,
    last_checked_at TEXT,
    created_at      TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS document_versions (
    id              TEXT PRIMARY KEY,
    document_id     TEXT NOT NULL REFERENCES legal_documents(id),
    version_label   TEXT,
    effective_from  TEXT,
    effective_to    TEXT,
    source_hash     TEXT,
    is_current      INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS legal_articles (
    id              TEXT PRIMARY KEY,
    document_id     TEXT NOT NULL REFERENCES legal_documents(id),
    version_id      TEXT REFERENCES document_versions(id),
    chapter         TEXT,
    section         TEXT,
    article_number  TEXT NOT NULL,
    article_title   TEXT,
    body            TEXT NOT NULL,
    notes           TEXT,
    status          TEXT DEFAULT 'active',
    sort_order      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_articles_doc_num
    ON legal_articles(document_id, article_number);

CREATE INDEX IF NOT EXISTS idx_articles_body
    ON legal_articles(body);

CREATE TABLE IF NOT EXISTS import_files (
    id              TEXT PRIMARY KEY,
    filename        TEXT,
    source_url      TEXT,
    retrieved_at    TEXT,
    sha256          TEXT NOT NULL,
    structure_check TEXT,
    record_count    INTEGER,
    status          TEXT DEFAULT 'pending',
    report          TEXT
);

CREATE TABLE IF NOT EXISTS document_relations (
    id              TEXT PRIMARY KEY,
    from_document   TEXT NOT NULL,
    to_document     TEXT NOT NULL,
    relation_type   TEXT
);

CREATE TABLE IF NOT EXISTS search_history (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    query           TEXT NOT NULL,
    created_at      TEXT DEFAULT CURRENT_TIMESTAMP
);
