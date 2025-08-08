// server.js
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const crypto = require('crypto');
const fetch = require('node-fetch');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs').promises;
require('dotenv').config();

const app = express();

// важливо для Render (проксі), щоб req.protocol був вірний
app.set('trust proxy', 1);

// CORS: дозволяємо свій фронт (той самий домен) + опціонально інші
app.use(cors());
app.use(express.json());

// статика
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR)); // віддає index.html та ресурси
app.use('/uploads', express.static('uploads')); // віддає завантажені фото

// Multer: збереження зображень
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = 'uploads';
    try { await fs.mkdir(uploadDir, { recursive: true }); } catch {}
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`;
    cb(null, unique);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => file.mimetype.startsWith('image/')
    ? cb(null, true) : cb(new Error('Тільки зображення дозволені!'), false)
});

// ENV
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const THREAD_ID = process.env.TELEGRAM_THREAD_ID ? Number(process.env.TELEGRAM_THREAD_ID) : undefined;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const SHEET_ID = process.env.SHEET_ID;
const PORT = process.env.PORT || 3000;

// Google Sheets
let sheets;
try {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_JSON),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  sheets = google.sheets({ version: 'v4', auth });
  console.log('✅ Google Sheets підключено');
} catch (err) {
  console.error('❌ Помилка підключення Google Sheets:', err.message);
}

// Хелпер: базовий URL (коректно за проксі)
function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.get('host');
  return `${proto}://${host}`;
}

// Перевірка підпису Telegram
function validateTelegramData(initData) {
  if (!initData) return null;
  try {
    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get('hash');
    urlParams.delete('hash');

    const dataCheckString = Array.from(urlParams.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    const secretKey = crypto.createHash('sha256').update(BOT_TOKEN).digest();
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (calculatedHash !== hash) return null;

    const user = JSON.parse(urlParams.get('user') || '{}');
    return user;
  } catch (err) {
    console.error('Помилка валідації Telegram даних:', err);
    return null;
  }
}

// Відправка в Telegram
async function sendToTelegram(report, imageUrls = []) {
  if (!BOT_TOKEN || !CHAT_ID) return { ok: false, error: 'Telegram не налаштовано' };
  try {
    const text = `🚨 Новий акт дефекту

👤 Користувач: ${report.user_name} (ID: ${report.user_id})
🏢 Парк: ${report.park}
🏭 Станція: ${report.station}
📝 Заголовок: ${report.title || 'Не вказано'}
📅 Дата інциденту: ${new Date(report.incident_at).toLocaleString('uk-UA')}

📄 Опис:
${report.description || 'Не вказано'}

🆔 ID звіту: ${report.id}`;

    const payload = { chat_id: CHAT_ID, text, parse_mode: 'HTML' };
    if (THREAD_ID) payload.message_thread_id = THREAD_ID;

    const resp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    const result = await resp.json();

    // фото окремо
    for (const url of imageUrls) {
      const p = { chat_id: CHAT_ID, photo: url, caption: `📸 Фото до акту #${report.id}` };
      if (THREAD_ID) p.message_thread_id = THREAD_ID;
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p)
      });
    }
    return { ok: result.ok };
  } catch (err) {
    console.error('Помилка відправки в Telegram:', err);
    return { ok: false, error: err.message };
  }
}

// Збереження в Google Sheets
async function saveToSheets(report, imageUrls = []) {
  if (!sheets || !SHEET_ID) return { ok: false, error: 'Google Sheets не налаштовано' };
  try {
    const values = [[
      report.id,
      new Date().toISOString(),
      report.user_id,
      report.user_name || 'Невідомий',
      report.park,
      report.station,
      report.title || '',
      report.description || '',
      report.incident_at,
      imageUrls.join(', ')
    ]];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'A1:J1',
      valueInputOption: 'RAW',
      resource: { values }
    });
    return { ok: true };
  } catch (err) {
    console.error('Помилка збереження в Google Sheets:', err);
    return { ok: false, error: err.message };
  }
}

/* =====================  API  ===================== */

// admin check
app.get('/api/is-admin', (req, res) => {
  const user = validateTelegramData(req.query.initData);
  if (!user) return res.json({ ok: false, error: 'Недійсні дані' });
  const isAdmin = ADMIN_IDS.includes(String(user.id));
  res.json({ ok: true, is_admin: isAdmin });
});

// create report
app.post('/api/report', upload.array('images', 10), async (req, res) => {
  const user = validateTelegramData(req.body.initData);
  if (!user) return res.json({ ok: false, error: 'Недійсні дані користувача' });

  const { title, description, park, station, incident_at } = req.body;
  if (!park || !station) return res.json({ ok: false, error: 'Парк та станція обовязкові' });

  const reportId = `DEF-${Date.now()}`;
  const base = getBaseUrl(req);
  const imageUrls = (req.files || []).map(f => `${base}/uploads/${f.filename}`);

  const report = {
    id: reportId,
    user_id: user.id,
    user_name: `${user.first_name || ''} ${user.last_name || ''}`.trim(),
    title, description, park, station,
    incident_at: incident_at || new Date().toISOString(),
    created_at: new Date().toISOString()
  };

  try {
    // квазі-БД: JSON файл
    let reports = [];
    try {
      const data = await fs.readFile('reports.json', 'utf8');
      reports = JSON.parse(data);
    } catch {}

    reports.push({ ...report, image_urls: imageUrls });
    await fs.writeFile('reports.json', JSON.stringify(reports, null, 2));

    await sendToTelegram(report, imageUrls);
    await saveToSheets(report, imageUrls);

    res.json({ ok: true, id: reportId });
  } catch (err) {
    console.error('Помилка збереження звіту:', err);
    res.json({ ok: false, error: 'Помилка збереження' });
  }
});

// list reports (admin)
app.get('/api/reports', async (req, res) => {
  const user = validateTelegramData(req.query.initData);
  if (!user || !ADMIN_IDS.includes(String(user.id))) {
    return res.json({ ok: false, error: 'Немає доступу' });
  }
  try {
    const data = await fs.readFile('reports.json', 'utf8');
    const reports = JSON.parse(data);
    res.json({ ok: true, items: reports.slice().reverse() });
  } catch {
    res.json({ ok: true, items: [] });
  }
});

// delete report (admin)
app.delete('/api/report/:id', async (req, res) => {
  const user = validateTelegramData(req.query.initData);
  if (!user || !ADMIN_IDS.includes(String(user.id))) {
    return res.json({ ok: false, error: 'Немає доступу' });
  }
  try {
    const data = await fs.readFile('reports.json', 'utf8');
    let reports = JSON.parse(data);
    const idx = reports.findIndex(r => r.id === req.params.id);
    if (idx === -1) return res.json({ ok: false, error: 'Звіт не знайдено' });

    const report = reports[idx];
    if (report.image_urls) {
      for (const url of report.image_urls) {
        const filename = url.split('/').pop();
        try { await fs.unlink(path.join('uploads', filename)); } catch {}
      }
    }

    reports.splice(idx, 1);
    await fs.writeFile('reports.json', JSON.stringify(reports, null, 2));
    res.json({ ok: true });
  } catch (err) {
    console.error('Помилка видалення:', err);
    res.json({ ok: false, error: 'Помилка видалення' });
  }
});

// update report (admin)
app.put('/api/report/:id', async (req, res) => {
  const user = validateTelegramData(req.body.initData);
  if (!user || !ADMIN_IDS.includes(String(user.id))) {
    return res.json({ ok: false, error: 'Немає доступу' });
  }
  try {
    const data = await fs.readFile('reports.json', 'utf8');
    let reports = JSON.parse(data);
    const idx = reports.findIndex(r => r.id === req.params.id);
    if (idx === -1) return res.json({ ok: false, error: 'Звіт не знайдено' });

    const { title, description } = req.body;
    if (title !== undefined) reports[idx].title = title;
    if (description !== undefined) reports[idx].description = description;
    reports[idx].updated_at = new Date().toISOString();

    await fs.writeFile('reports.json', JSON.stringify(reports, null, 2));
    res.json({ ok: true });
  } catch (err) {
    console.error('Помилка оновлення:', err);
    res.json({ ok: false, error: 'Помилка оновлення' });
  }
});

/* --------- fallback на SPA --------- */
// Усі не-API маршрути віддають index.html
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// health/інфо
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// старт
app.listen(PORT, () => {
  console.log(`🚀 Сервер на порту ${PORT}`);
  console.log(`📊 Google Sheets: ${SHEET_ID ? '✅' : '❌'}`);
  console.log(`🤖 Telegram Bot: ${BOT_TOKEN ? '✅' : '❌'}`);
  console.log(`👥 Адміни: ${ADMIN_IDS.length ? ADMIN_IDS.join(', ') : '—'}`);
});

// загальні перехоплювачі
process.on('uncaughtException', err => console.error('Неперехоплена помилка:', err));
process.on('unhandledRejection', r => console.error('Необроблене відхилення:', r));
