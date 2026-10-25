import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'pravosfera.db');

const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const schema = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
db.exec(schema);

const count = db.prepare('SELECT COUNT(*) AS n FROM legal_documents').get().n;

if (count === 0) {
  console.log('База пуста. Добавляем демонстрационные данные...');

  const insertDoc = db.prepare(`
    INSERT INTO legal_documents (id, title, doc_type, number, current_version, status, is_official, source_url, last_checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertArticle = db.prepare(`
    INSERT INTO legal_articles (id, document_id, chapter, article_number, article_title, body, status, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertDoc.run(
    'demo-code', 
    'Демонстрационный кодекс (Тест)', 
    'Кодекс', 
    '00-ФЗ', 
    'ред. от 2026 года', 
    'active', 
    0, 
    'https://pravo.gov.ru', 
    new Date().toISOString()
  );

  insertArticle.run(
    'demo-art-1',
    'demo-code',
    'Глава 1. Основы',
    '1',
    'Понятие и основные принципы',
    '1. Настоящая статья является демонстрационной и создана исключительно для проверки работы интерфейса ПРАВОСФЕРА.\n\n2. Она не является нормативным правовым актом и не несет юридической силы.\n\n3. Вы можете проверить работу поиска, введя в строку "статья 1" или "принципы".\n\n4. А также протестировать кнопку "Объяснить простыми словами", чтобы увидеть, как отвечает искусственный интеллект Gemini.',
    'active',
    1
  );

  console.log('Демо-данные успешно добавлены!');
} else {
  console.log('В базе уже есть документы. Пропускаем добавление демо-данных.');
}
db.close();
