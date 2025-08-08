// server.js
// npm i express multer dotenv googleapis node-fetch@2 cors
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const crypto = require('crypto');
const fetch = require('node-fetch');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
const upload = multer({ storage: multer.memoryStorage() });

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID; // чат супер-группы (без :thread)
const THREAD_ID = process.env.TELEGRAM_THREAD_ID ? Number(process.env.TELEGRAM_THREAD_ID) : undefined; // id треда
const ADMIN_IDS = (process.env.ADMIN_IDS||'').split(',').map(s=>s.trim()).filter(Boolean);
const SHEET_ID = process.env.SHEET_ID; // Google Sheet ID

// ===== Google Sheets =====
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_JSON),
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
const sheets = google.sheets({ version: 'v4', auth });
const RANGE = 'Reports!A:Z'; // сделай лист "Reports" и первую строку с заголовками

async function ensureHeader(){
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Reports!A1:K1' });
  if(!res.data.values || !res.data.values.length){
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: 'Reports!A1:K1', valueInputOption: 'RAW',
      requestBody: { values: [[
        'id','created_at','user_id','user_name','park','station','title','description','incident_at','images','message_link'
      ]]}
    });
  }
}

function uid(){ return Math.random().toString(36).slice(2)+Date.now().toString(36); }

// ===== Проверка initData (Telegram WebApp auth) =====
function checkInitData(initData){
  if(!initData || !BOT_TOKEN) return null;
  const urlParams = new URLSearchParams(initData);
  const hash = urlParams.get('hash');
  urlParams.delete('hash');
  const dataCheck = Array.from(urlParams.entries()).sort((a,b)=>a[0].localeCompare(b[0]))
    .map(([k,v])=>`${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256','WebAppData').update(BOT_TOKEN).digest();
  const _hash = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
  if(_hash !== hash) return null;
  try{ return JSON.parse(urlParams.get('user')); }catch(e){ return null; }
}

// ===== Telegram helpers =====
async function sendTelegramMessage(text){
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const body = { chat_id: CHAT_ID, text, parse_mode:'HTML', disable_web_page_preview:true };
  if (THREAD_ID) body.message_thread_id = THREAD_ID; // отправка в ветку
  const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  return r.json();
}
async function sendTelegramPhotos(captions){
  const form = new (require('form-data'))();
  const media = captions.map((c,i)=>({ type:'photo', media:`attach://f${i}`, caption: i===0 ? 'Фото до звіту' : undefined }));
  form.append('chat_id', CHAT_ID);
  if (THREAD_ID) form.append('message_thread_id', String(THREAD_ID)); // отправка в ветку
  form.append('media', JSON.stringify(media));
  captions.forEach((c,i)=> form.append(`f${i}`, c.fileBuf, { filename: c.filename }));
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMediaGroup`, { method:'POST', body: form });
  return r.json();
}

// ===== Admin check =====
app.get('/api/is-admin', async (req,res)=>{
  const user = checkInitData(req.query.initData);
  return res.json({ ok: true, is_admin: !!(user && ADMIN_IDS.includes(String(user.id))) });
});

// ===== Create report =====
app.post('/api/report', upload.array('images', 10), async (req,res)=>{
  try{
    const user = checkInitData(req.body.initData);
    if(!user) return res.status(401).json({ ok:false, error:'bad auth' });

    await ensureHeader();
    const id = uid();
    const payload = {
      id,
      created_at: new Date().toISOString(),
      user_id: user.id,
      user_name: `${user.first_name||''} ${user.last_name||''}`.trim(),
      park: req.body.park||'',
      station: req.body.station||'',
      title: req.body.title||'',
      description: req.body.description||'',
      incident_at: req.body.incident_at||'',
    };

    // 1) уведомление в чат
    let text = `<b>Новий акт дефекту</b>\n`+
      `Від: <a href="https://t.me/${user.username||''}">${payload.user_name}</a> (id ${user.id})\n`+
      `Парк: <b>${payload.park}</b>\nСтанція: <b>${payload.station}</b>\n`+
      (payload.title?`Заголовок: <b>${payload.title}</b>\n`:``)+
      (payload.description?`Опис: ${payload.description}\n`:``)+
      (payload.incident_at?`Дата інциденту: ${payload.incident_at}`:``);
    const msg = await sendTelegramMessage(text);
    const message_link = msg?.result ? `https://t.me/c/${String(msg.result.chat.id).replace('-100','')}/${msg.result.message_id}` : '';

    // 2) фото (если есть)
    let imagePlaceholders = [];
    if(req.files && req.files.length){
      const caps = req.files.map((f,i)=>({ fileBuf: f.buffer, filename: f.originalname||`img${i}.jpg` }));
      const photos = await sendTelegramPhotos(caps);
      // сохраним file_id'шники первой медиа-группы
      imagePlaceholders = (photos.result||[]).map(m=>m.photo?.[m.photo.length-1]?.file_id).filter(Boolean);
    }

    // 3) запись в Google Sheets
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Reports!A:K', valueInputOption: 'RAW',
      requestBody: { values: [[
        payload.id, payload.created_at, payload.user_id, payload.user_name,
        payload.park, payload.station, payload.title, payload.description,
        payload.incident_at, imagePlaceholders.join(','), message_link
      ]]}
    });

    res.json({ ok:true, id });
  }catch(e){ console.error(e); res.status(500).json({ ok:false, error: e.message }); }
});

// ===== List reports (admin) =====
app.get('/api/reports', async (req,res)=>{
  try{
    const user = checkInitData(req.query.initData);
    if(!user || !ADMIN_IDS.includes(String(user.id))) return res.status(403).json({ ok:false, error:'forbidden' });
    await ensureHeader();
    const out = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: RANGE });
    const rows = out.data.values||[]; rows.shift();
    const items = rows.map(r=>({
      id: r[0], created_at: r[1], user_id: r[2], user_name: r[3],
      park: r[4], station: r[5], title: r[6], description: r[7], incident_at: r[8], images: (r[9]||'').split(','), message_link: r[10]
    }));
    res.json({ ok:true, items });
  }catch(e){ res.status(500).json({ ok:false, error:e.message }); }
});

// ===== Update title (admin, минимально) =====
app.put('/api/report/:id', async (req,res)=>{
  try{
    const user = checkInitData(req.body.initData || req.query.initData);
    if(!user || !ADMIN_IDS.includes(String(user.id))) return res.status(403).json({ ok:false, error:'forbidden' });
    const id = req.params.id; const newTitle = req.body.title||'';
    const sheet = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: RANGE });
    const rows = sheet.data.values||[]; const header = rows.shift();
    const idx = rows.findIndex(r=>r[0]===id);
    if(idx<0) return res.json({ ok:false, error:'not found' });
    const rowNum = idx+2; // + header
    const titleCol = header.indexOf('title')+1; // 1-based
    await sheets.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: `Reports!${String.fromCharCode(64+titleCol)}${rowNum}`, valueInputOption:'RAW', requestBody: { values: [[newTitle]] } });
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ ok:false, error:e.message }); }
});

// ===== Delete (admin) =====
app.delete('/api/report/:id', async (req,res)=>{
  try{
    const user = checkInitData(req.query.initData);
    if(!user || !ADMIN_IDS.includes(String(user.id))) return res.status(403).json({ ok:false, error:'forbidden' });
    const id = req.params.id;
    const sheet = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: RANGE });
    const rows = sheet.data.values||[]; rows.shift();
    const idx = rows.findIndex(r=>r[0]===id);
    if(idx<0) return res.json({ ok:false, error:'not found' });
    // batchUpdate delete row
    await google.sheets('v4').spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ deleteDimension: { range: { sheetId: 0, dimension: 'ROWS', startIndex: idx+1, endIndex: idx+2 } } }] }
    });
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ ok:false, error:e.message }); }
});

app.get('/', (req,res)=>res.send('OK'));

const PORT = process.env.PORT||8080; app.listen(PORT, ()=>console.log('API on', PORT));