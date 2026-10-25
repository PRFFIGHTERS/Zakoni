/**
 * Воспроизводимый импорт официального файла.
 *
 * Поддерживается JSON следующего вида:
 * {
 *   "document": {
 *     "id": "uk-rf",
 *     "title": "Уголовный кодекс Российской Федерации",
 *     "doc_type": "Кодекс",
 *     "authority": "Государственная Дума РФ",
 *     "number": "63-ФЗ",
 *     "adoption_date": "1996-06-13",
 *     "current_version": "ред. от ...",
 *     "status": "active",
 *     "is_official": 1,
 *     "source_url": "https://pravo.gov.ru/...",
 *     "last_checked_at": "2026-10-25"
 *   },
 *   "articles": [
 *     {
 *       "id": "uk-rf-158",
 *       "chapter": "Глава 21",
 *       "section": "Раздел VIII",
 *       "article_number": "158",
 *       "article_title": "Кража",
 *       "body": "1. Кража, то есть ...",
 *       "notes": "Примечание. ...",
 *       "status": "active",
 *       "sort_order": 15800
 *     }
 *   ]
 * }
 *
 * Запуск:
 *   node importer/import.js path/to/official.json --source-url="..." --sha256="..." --structure="ok"
 *
 * Файл НЕ должен содержать сгенерированный текст. Он должен быть получен
 * из официального источника (pravo.gov.ru) или официальной выгрузки.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'pravosfera.db');

const args = process.argv.slice(2);
const filePath = args.find((a) => !a.startsWith('--'));
if (!filePath) {
  console.error('Укажите путь к JSON-файлу: node importer/import.js ./official.json');
  process.exit(1);
}

function getArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = args.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const raw = fs.readFileSync(filePath);
const sha256 = crypto.createHash('sha256').update(raw).digest('hex');
const expectedHash = getArg('sha256');

if (expectedHash && expectedHash !== sha256) {
  console.error(`Хеш не совпадает. Ожидался ${expectedHash}, получен ${sha256}. Импорт остановлен.`);
  process.exit(1);
}

let payload;
try {
  payload = JSON.parse(raw.toString('utf8'));
} catch (err) {
  console.error('Файл не является корректным JSON:', err.message);
  process.exit(1);
}

// ---------- Валидация структуры ----------
function validate(data) {
  const errors = [];
  if (!data.document?.id) errors.push('document.id отсутствует');
  if (!data.document?.title) errors.push('document.title отсутствует');
  if (!Array.isArray(data.articles) || data.articles.length === 0) {
    errors.push('articles пуст или не массив');
    return { ok: false, errors };
  }

  const seen = new Set();
  for (const [i, a] of data.articles.entries()) {
    if (!a.id) errors.push(`articles[${i}].id отсутствует`);
    if (!a.article_number) errors.push(`articles[${i}].article_number отсутствует`);
    if (!a.body || !String(a.body).trim()) errors.push(`articles[${i}].body пуст`);
    if (seen.has(a.article_number)) errors.push(`Дублирующийся номер статьи: ${a.article_number}`);
    seen.add(a.article_number);
  }

  if (errors.length) return { ok: false, errors };

  // Проверка сортировки и непрерывности не выполняется намеренно:
  // в реальных кодексах есть пропуски и статьи с дополнительными номерами.
  return { ok: true, errors: [] };
}

const validation = validate(payload);
const structureReport = validation.ok
  ? `OK: ${payload.articles.length} статей, уникальные номера`
  : `FAIL: ${validation.errors.join('; ')}`;

if (!validation.ok) {
  console.error('Импорт остановлен. Проверка структуры не пройдена:');
  console.error(validation.errors.join('\n'));
  process.exit(1);
}

// ---------- Запись в БД ----------
if (!fs.existsSync(path.dirname(DB_PATH))) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
db.exec(schema);

const importId = crypto.randomUUID();
const now = new Date().toISOString();

const insertFile = db.prepare(`
  INSERT INTO import_files (id, filename, source_url, retrieved_at, sha256, structure_check, record_count, status, report)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertDoc = db.prepare(`
  INSERT OR REPLACE INTO legal_documents
  (id, title, doc_type, authority, number, adoption_date, publication_date,
   effective_date, expiration_date, current_version, status, is_official,
   source_url, last_checked_at)
  VALUES (@id, @title, @doc_type, @authority, @number, @adoption_date, @publication_date,
          @effective_date, @expiration_date, @current_version, @status, @is_official,
          @source_url, @last_checked_at)
`);

const insertArticle = db.prepare(`
  INSERT OR REPLACE INTO legal_articles
  (id, document_id, version_id, chapter, section, article_number, article_title,
   body, notes, status, sort_order)
  VALUES (@id, @document_id, @version_id, @chapter, @section, @article_number, @article_title,
          @body, @notes, @status, @sort_order)
`);

const tx = db.transaction(() => {
  insertFile.run(
    importId,
    path.basename(filePath),
    getArg('source-url', payload.document.source_url || ''),
    getArg('retrieved-at', now),
    sha256,
    structureReport,
    payload.articles.length,
    'success',
    `Импорт выполнен. Структура: ${structureReport}`
  );

  const d = payload.document;
  insertDoc.run({
    id: d.id,
    title: d.title,
    doc_type: d.doc_type || 'Нормативный правовой акт',
    authority: d.authority || null,
    number: d.number || null,
    adoption_date: d.adoption_date || null,
    publication_date: d.publication_date || null,
    effective_date: d.effective_date || null,
    expiration_date: d.expiration_date || null,
    current_version: d.current_version || null,
    status: d.status || 'unknown',
    is_official: d.is_official ? 1 : 0,
    source_url: d.source_url || getArg('source-url', ''),
    last_checked_at: d.last_checked_at || now,
  });

  for (const [i, a] of payload.articles.entries()) {
    insertArticle.run({
      id: a.id,
      document_id: d.id,
      version_id: a.version_id || null,
      chapter: a.chapter || null,
      section: a.section || null,
      article_number: String(a.article_number),
      article_title: a.article_title || null,
      body: String(a.body),
      notes: a.notes || null,
      status: a.status || 'active',
      sort_order: Number.isInteger(a.sort_order) ? a.sort_order : i,
    });
  }
});

try {
  tx();
  console.log('Импорт завершён успешно.');
  console.log(`Документ: ${payload.document.title}`);
  console.log(`Статей: ${payload.articles.length}`);
  console.log(`SHA-256: ${sha256}`);
  console.log(`Отчёт структуры: ${structureReport}`);
} catch (err) {
  console.error('Ошибка записи в БД:', err.message);
  process.exit(1);
} finally {
  db.close();
}
