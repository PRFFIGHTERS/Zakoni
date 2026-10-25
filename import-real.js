import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'pravosfera.db');

export async function importRealLaws() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // Очищаем демо-данные
  db.prepare('DELETE FROM legal_articles').run();
  db.prepare('DELETE FROM legal_documents').run();

  console.log('Скачиваем реальные законы...');

  // Мы используем открытый датасет с GitHub, где собраны законы РФ
  // Скачиваем Уголовный кодекс (УК РФ)
  try {
    const response = await fetch('https://raw.githubusercontent.com/Totopolis/laws/master/codes/uk_rf.json');
    if (!response.ok) throw new Error('Сеть недоступна');
    const data = await response.json();

    const insertDoc = db.prepare(`
      INSERT INTO legal_documents (id, title, doc_type, number, current_version, status, is_official, source_url, last_checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertArticle = db.prepare(`
      INSERT INTO legal_articles (id, document_id, chapter, article_number, article_title, body, status, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertDoc.run(
      'uk-rf', 
      'Уголовный кодекс Российской Федерации', 
      'Кодекс', 
      '63-ФЗ', 
      'актуальная редакция', 
      'active', 
      1, // Официальный (в датасете)
      'https://pravo.gov.ru', 
      new Date().toISOString()
    );

    let count = 0;
    // Проходимся по скачанным статьям и сохраняем в нашу базу
    for (const [index, article] of data.articles.entries()) {
      insertArticle.run(
        `uk-${article.number}-${index}`,
        'uk-rf',
        article.chapter || 'Без главы',
        article.number,
        article.title,
        article.text,
        'active',
        index
      );
      count++;
    }

    console.log(`Успешно загружено статей УК РФ: ${count}`);
    db.close();
    return { success: true, count };
  } catch (error) {
    console.error(error);
    db.close();
    throw error;
  }
}
