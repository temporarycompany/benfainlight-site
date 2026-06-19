const express = require('express');
const multer  = require('multer');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Config ────────────────────────────────────────────────────────────────────
// Set ADMIN_PASSWORD as an environment variable before deploying.
// On Railway: Settings → Variables → ADMIN_PASSWORD = yourpassword
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';

const CONTENT_FILE = path.join(__dirname, 'content.json');
const UPLOADS_DIR  = path.join(__dirname, 'public', 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── File uploads ──────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const name = Date.now() + '-' + crypto.randomBytes(4).toString('hex') + ext;
    cb(null, name);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpeg|png|gif|webp|svg\+xml)$/.test(file.mimetype);
    cb(ok ? null : new Error('Only image files allowed'), ok);
  }
});

// ── Session store (in-memory, 24 h TTL) ──────────────────────────────────────
const sessions = new Map(); // token → expiryMs

function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'No token' });
  const expiry = sessions.get(token);
  if (!expiry || Date.now() > expiry) {
    sessions.delete(token);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Auth routes ───────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + 24 * 60 * 60 * 1000);
  res.json({ token });
});

app.post('/api/logout', requireAuth, (req, res) => {
  const token = (req.headers['authorization'] || '').slice(7);
  sessions.delete(token);
  res.json({ ok: true });
});

// ── Content routes ────────────────────────────────────────────────────────────
// Public read — the main site fetches this on load
app.get('/api/content', (req, res) => {
  try {
    res.json(JSON.parse(fs.readFileSync(CONTENT_FILE, 'utf8')));
  } catch (e) {
    res.status(500).json({ error: 'Could not read content.json' });
  }
});

// Protected write — admin panel posts the full content object
app.put('/api/content', requireAuth, (req, res) => {
  try {
    fs.writeFileSync(CONTENT_FILE, JSON.stringify(req.body, null, 2), 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not save content.json' });
  }
});

// ── Upload route ──────────────────────────────────────────────────────────────
app.post('/api/upload', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  res.json({ url: '/uploads/' + req.file.filename });
});

// ── Admin panel ───────────────────────────────────────────────────────────────
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

// ── Fallback: serve main site for any non-API path ───────────────────────────
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api') && !req.path.startsWith('/uploads')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

app.listen(PORT, () => {
  console.log(`\n  ✦ Site    → http://localhost:${PORT}`);
  console.log(`  ✦ Admin   → http://localhost:${PORT}/admin`);
  console.log(`  ✦ Press Ctrl+C to stop\n`);
});
