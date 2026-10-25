import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import Database from 'better-sqlite3';
import { GoogleGenAI } from '@google/genai';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'pravosfera.db');

// ---------- База ----------
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
db.exec(schema);

// ---------- Gemini ----------
const geminiKey = process.env.GEMINI_API_KEY;
const geminiModel = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
let ai = null;
if (geminiKey) {
  ai = new GoogleGenAI({ apiKey: geminiKey });
}

// ---------- Express ----------
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '256kb' }));
app.use(express.static(__dirname));

const limiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много запросов. Попробуйте позже.' },
});
app.use('/api', limiter);

// ---------- Health ----------
app.get('/api/health', (_req, res) => {
  const docs = db.prepare('SELECT COUNT(*) AS n FROM legal_documents').get().n;
  const articles = db.prepare('SELECT COUNT(*) AS n FROM legal_articles').get().n;
  res.json({
    ok: true,
    database: 'ok',
    documents: docs,
    articles,
    geminiConfigured: Boolean(geminiKey),
    geminiModel: geminiKey ? geminiModel : null,
  });
});

// ---------- Поиск (локальный, без ИИ) ----------
app.get('/api/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Пустой запрос' });
  if (q.length > 500) return res.status(400).json({ error: 'Слишком длинный запрос' });

  const like = `%${q}%`;

  // 1. Точное совпадение по номеру статьи
  const exactArticle = db.prepare(`
    SELECT a.*, d.title AS document_title, d.status AS doc_status,
           d.current_version, d.source_url, d.is_official, d.last_checked_at
    FROM legal_articles a
    JOIN legal_documents d ON d.id = a.document_id
    WHERE a.article_number = ?
    LIMIT 5
  `).all(q);

  // 2. Поиск по заголовкам и телу статей
  const articleHits = db.prepare(`
    SELECT a.*, d.title AS document_title, d.status AS doc_status,
           d.current_version, d.source_url, d.is_official, d.last_checked_at,
           CASE
             WHEN a.article_title LIKE ? THEN 2
             ELSE 1
           END AS rank
    FROM legal_articles a
    JOIN legal_documents d ON d.id = a.document_id
    WHERE a.article_title LIKE ? OR a.body LIKE ?
    ORDER BY rank DESC, a.sort_order ASC
    LIMIT 30
  `).all(`%${q}%`, like, like);

  // 3. Поиск по названиям документов
  const docHits = db.prepare(`
    SELECT id, title, doc_type, number, current_version, status,
           source_url, is_official, last_checked_at
    FROM legal_documents
    WHERE title LIKE ? OR number LIKE ?
    LIMIT 10
  `).all(like, like);

  // 4. История (анонимно, без привязки к пользователю)
  try {
    db.prepare('INSERT INTO search_history (query) VALUES (?)').run(q);
  } catch { /* ignore */ }

  res.json({
    query: q,
    exact: exactArticle,
    articles: articleHits,
    documents: docHits,
    notice: 'Результаты получены из локальной базы. Если база пуста, выполните импорт официального файла.',
  });
});

// ---------- Список документов ----------
app.get('/api/documents', (_req, res) => {
  const rows = db.prepare(`
    SELECT id, title, doc_type, number, adoption_date,
           current_version, status, is_official, source_url, last_checked_at
    FROM legal_documents
    ORDER BY title
  `).all();
  res.json(rows);
});

// ---------- Документ + статьи ----------
app.get('/api/documents/:id', (req, res) => {
  const doc = db.prepare('SELECT * FROM legal_documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Документ не найден' });

  const articles = db.prepare(`
    SELECT id, chapter, section, article_number, article_title, status, sort_order
    FROM legal_articles
    WHERE document_id = ?
    ORDER BY sort_order ASC
  `).all(req.params.id);

  res.json({ document: doc, articles });
});

// ---------- Статья ----------
app.get('/api/articles/:id', (req, res) => {
  const row = db.prepare(`
    SELECT a.*, d.title AS document_title, d.doc_type, d.number,
           d.current_version, d.status AS doc_status,
           d.source_url, d.is_official, d.last_checked_at
    FROM legal_articles a
    JOIN legal_documents d ON d.id = a.document_id
    WHERE a.id = ?
  `).get(req.params.id);

  if (!row) return res.status(404).json({ error: 'Статья не найдена' });
  res.json(row);
});

// ---------- ИИ-объяснение ----------
app.post('/api/explain', async (req, res) => {
  if (!ai) {
    return res.status(503).json({
      error: 'ИИ временно не настроен. Администратор должен указать GEMINI_API_KEY.',
    });
  }

  const { articleId } = req.body || {};
  if (!articleId || typeof articleId !== 'string') {
    return res.status(400).json({ error: 'Некорректный articleId' });
  }

  const article = db.prepare(`
    SELECT a.*, d.title AS document_title, d.current_version, d.status AS doc_status,
           d.source_url, d.is_official
    FROM legal_articles a
    JOIN legal_documents d ON d.id = a.document_id
    WHERE a.id = ?
  `).get(articleId);

  if (!article) return res.status(404).json({ error: 'Статья не найдена' });

  // Отправляем модели ТОЛЬКО оригинальный текст из базы, без генерации права
  const prompt = `Ты — помощник по праву. Объясни простыми словами содержание следующей нормы.
Не придумывай новые статьи, номера или наказания. Опирайся строго на приведённый текст.
Если данных недостаточно для вывода, укажи неопределённость.
Раздели ответ на: что регулирует норма, условия, исключения, от чего зависит применение, связанные нормы (если очевидны).

Документ: ${article.document_title}
Статья ${article.article_number}. ${article.article_title || ''}
Редакция: ${article.current_version || 'не указана'}
Статус: ${article.doc_status || 'неизвестен'}

Оригинальный текст:
${article.body}

${article.notes ? `Примечания: ${article.notes}` : ''}

Ответ дай на русском языке, нейтрально, без юридических консультаций от первого лица.`;

  try {
    const response = await ai.models.generateContent({
      model: geminiModel,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });

    const explanation = response.text || 'Модель не вернула текст.';

    res.json({
      articleId: article.id,
      articleNumber: article.article_number,
      documentTitle: article.document_title,
      explanation,
      disclaimer: 'Объяснение сгенерировано ИИ и носит информационный характер. Оно не заменяет профессиональную юридическую консультацию и не является официальным толкованием права.',
      originalSource: article.source_url,
      isOfficial: Boolean(article.is_official),
      version: article.current_version,
    });
  } catch (err) {
    console.error('Gemini error:', err?.message || err);
    res.status(502).json({
      error: 'Не удалось получить объяснение от ИИ. Локальный поиск и тексты законов остаются доступны.',
    });
  }
});

// ---------- SPA fallback ----------
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ПРАВОСФЕРА запущена: http://localhost:${PORT}`);
  if (!geminiKey) console.warn('GEMINI_API_KEY не задан — ИИ-объяснения отключены.');
});
