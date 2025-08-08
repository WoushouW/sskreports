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
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads'));

// Мульти-параметричний storage для multer
const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        const uploadDir = 'uploads';
        try {
            await fs.mkdir(uploadDir, { recursive: true });
        } catch (err) {
            console.error('Error creating upload directory:', err);
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1E9)}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
    }
});

const upload = multer({ 
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Тільки зображення дозволені!'), false);
        }
    }
});

// Константи з environment
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const THREAD_ID = process.env.TELEGRAM_THREAD_ID ? Number(process.env.TELEGRAM_THREAD_ID) : undefined;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const SHEET_ID = process.env.SHEET_ID;
const PORT = process.env.PORT || 3000;

// Google Sheets налаштування
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

// Функція перевірки Telegram підпису
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

// Функція відправки в Telegram
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

        const payload = {
            chat_id: CHAT_ID,
            text,
            parse_mode: 'HTML'
        };
        
        if (THREAD_ID) payload.message_thread_id = THREAD_ID;
        
        const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        const result = await response.json();
        
        // Відправка зображень окремими повідомленнями
        for (const imageUrl of imageUrls) {
            const imagePayload = {
                chat_id: CHAT_ID,
                photo: imageUrl,
                caption: `📸 Фото до акту #${report.id}`
            };
            
            if (THREAD_ID) imagePayload.message_thread_id = THREAD_ID;
            
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(imagePayload)
            });
        }
        
        return { ok: result.ok };
    } catch (err) {
        console.error('Помилка відправки в Telegram:', err);
        return { ok: false, error: err.message };
    }
}

// Функція збереження в Google Sheets
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

// API Endpoints

// Перевірка чи адмін
app.get('/api/is-admin', (req, res) => {
    const user = validateTelegramData(req.query.initData);
    if (!user) return res.json({ ok: false, error: 'Недійсні дані' });
    
    const isAdmin = ADMIN_IDS.includes(String(user.id));
    res.json({ ok: true, is_admin: isAdmin });
});

// Створення нового звіту
app.post('/api/report', upload.array('images', 10), async (req, res) => {
    const user = validateTelegramData(req.body.initData);
    if (!user) return res.json({ ok: false, error: 'Недійсні дані користувача' });
    
    const { title, description, park, station, incident_at } = req.body;
    
    if (!park || !station) {
        return res.json({ ok: false, error: 'Парк та станція обовязкові' });
    }
    
    // Генеруємо ID звіту
    const reportId = `DEF-${Date.now()}`;
    
    // Створюємо URLs для зображень
    const imageUrls = (req.files || []).map(file => 
        `${req.protocol}://${req.get('host')}/uploads/${file.filename}`
    );
    
    const report = {
        id: reportId,
        user_id: user.id,
        user_name: `${user.first_name || ''} ${user.last_name || ''}`.trim(),
        title,
        description,
        park,
        station,
        incident_at: incident_at || new Date().toISOString(),
        created_at: new Date().toISOString()
    };
    
    // Зберігаємо в базу даних (тут можна використовувати будь-яку БД)
    try {
        // Простий JSON файл як база даних
        let reports = [];
        try {
            const data = await fs.readFile('reports.json', 'utf8');
            reports = JSON.parse(data);
        } catch (err) {
            // Файл не існує, створюємо новий масив
        }
        
        reports.push({ ...report, image_urls: imageUrls });
        await fs.writeFile('reports.json', JSON.stringify(reports, null, 2));
        
        // Відправляємо в Telegram
        await sendToTelegram(report, imageUrls);
        
        // Зберігаємо в Google Sheets
        await saveToSheets(report, imageUrls);
        
        res.json({ ok: true, id: reportId });
    } catch (err) {
        console.error('Помилка збереження звіту:', err);
        res.json({ ok: false, error: 'Помилка збереження' });
    }
});

// Отримання всіх звітів (тільки для адміна)
app.get('/api/reports', async (req, res) => {
    const user = validateTelegramData(req.query.initData);
    if (!user || !ADMIN_IDS.includes(String(user.id))) {
        return res.json({ ok: false, error: 'Немає доступу' });
    }
    
    try {
        const data = await fs.readFile('reports.json', 'utf8');
        const reports = JSON.parse(data);
        res.json({ ok: true, items: reports.reverse() }); // Останні спочатку
    } catch (err) {
        res.json({ ok: true, items: [] }); // Порожня база
    }
});

// Видалення звіту
app.delete('/api/report/:id', async (req, res) => {
    const user = validateTelegramData(req.query.initData);
    if (!user || !ADMIN_IDS.includes(String(user.id))) {
        return res.json({ ok: false, error: 'Немає доступу' });
    }
    
    try {
        const data = await fs.readFile('reports.json', 'utf8');
        let reports = JSON.parse(data);
        
        const reportIndex = reports.findIndex(r => r.id === req.params.id);
        if (reportIndex === -1) {
            return res.json({ ok: false, error: 'Звіт не знайдено' });
        }
        
        // Видаляємо файли зображень
        const report = reports[reportIndex];
        if (report.image_urls) {
            for (const url of report.image_urls) {
                const filename = url.split('/').pop();
                try {
                    await fs.unlink(path.join('uploads', filename));
                } catch (err) {
                    console.log('Файл вже видалено:', filename);
                }
            }
        }
        
        reports.splice(reportIndex, 1);
        await fs.writeFile('reports.json', JSON.stringify(reports, null, 2));
        
        res.json({ ok: true });
    } catch (err) {
        console.error('Помилка видалення:', err);
        res.json({ ok: false, error: 'Помилка видалення' });
    }
});

// Редагування звіту
app.put('/api/report/:id', async (req, res) => {
    const user = validateTelegramData(req.body.initData);
    if (!user || !ADMIN_IDS.includes(String(user.id))) {
        return res.json({ ok: false, error: 'Немає доступу' });
    }
    
    try {
        const data = await fs.readFile('reports.json', 'utf8');
        let reports = JSON.parse(data);
        
        const reportIndex = reports.findIndex(r => r.id === req.params.id);
        if (reportIndex === -1) {
            return res.json({ ok: false, error: 'Звіт не знайдено' });
        }
        
        // Оновлюємо дані
        const { title, description } = req.body;
        if (title !== undefined) reports[reportIndex].title = title;
        if (description !== undefined) reports[reportIndex].description = description;
        reports[reportIndex].updated_at = new Date().toISOString();
        
        await fs.writeFile('reports.json', JSON.stringify(reports, null, 2));
        
        res.json({ ok: true });
    } catch (err) {
        console.error('Помилка оновлення:', err);
        res.json({ ok: false, error: 'Помилка оновлення' });
    }
});

// Статичні файли
app.get('/', (req, res) => {
    res.send(`
        🚀 Backend сервер актів дефектів
        Сервер працює на порту ${PORT}
        📋 Доступні endpoints:
        
            GET /api/is-admin - Перевірка адмін прав
            POST /api/report - Створення звіту
            GET /api/reports - Список звітів (адмін)
            DELETE /api/report/:id - Видалення звіту (адмін)
            PUT /api/report/:id - Редагування звіту (адмін)
        
    `);
});

// Запуск сервера
app.listen(PORT, () => {
    console.log(`🚀 Сервер запущено на порту ${PORT}`);
    console.log(`📊 Google Sheets: ${SHEET_ID ? '✅ Підключено' : '❌ Не налаштовано'}`);
    console.log(`🤖 Telegram Bot: ${BOT_TOKEN ? '✅ Підключено' : '❌ Не налаштовано'}`);
    console.log(`👥 Адміни: ${ADMIN_IDS.length > 0 ? ADMIN_IDS.join(', ') : 'Не налаштовано'}`);
});

// Обробка помилок
process.on('uncaughtException', (err) => {
    console.error('Неперехоплена помилка:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Необроблене відхилення:', reason);
});