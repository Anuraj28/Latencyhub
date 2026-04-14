'use strict';

const express    = require('express');
const cors       = require('cors');
const Database   = require('better-sqlite3');
const path       = require('path');
const crypto     = require('crypto');
const { exec }   = require('child_process');
const os         = require('os');
const net        = require('net');
const session    = require('express-session');
const bcrypt     = require('bcrypt');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Database ─────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'netdiag.db'));

// Drop existing to match new schema
db.exec('DROP TABLE IF EXISTS network_checks');

db.exec(`
  CREATE TABLE IF NOT EXISTS network_checks (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    check_id       TEXT    UNIQUE,
    timestamp      TEXT    NOT NULL,
    user_ip        TEXT    NOT NULL,
    latency_avg    REAL,
    latency_min    REAL,
    latency_max    REAL,
    jitter         REAL,
    packet_loss    REAL,
    download_speed REAL,
    upload_speed   REAL,
    traceroute     TEXT
  );

  CREATE TABLE IF NOT EXISTS admins (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    username       TEXT    UNIQUE NOT NULL,
    password_hash  TEXT    NOT NULL
  );
`);

// ── Middleware ────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '25mb' }));

app.use(session({
  secret: 'supersecretkey',
  resave: false,
  saveUninitialized: true,
}));

function hasAdmin() {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM admins').get();
  return row.cnt > 0;
}

// Block Normal Login Until Setup
app.use((req, res, next) => {
  if (req.path === '/admin.html' || req.path === '/login.html' || req.path === '/login') {
    if (!hasAdmin()) {
      return res.redirect('/setup.html');
    }
  }
  if (req.path === '/setup.html' || req.path === '/setup') {
    if (hasAdmin()) {
      return res.redirect('/login.html');
    }
  }
  next();
});

app.post('/setup', async (req, res) => {
  if (hasAdmin()) return res.status(403).json({ error: "Admin already setup" });
  
  const { username, password, confirmPassword } = req.body;
  if (!username || !password || password !== confirmPassword) {
    return res.status(400).json({ error: "Invalid input" });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run(username, hash);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  
  try {
    const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
    if (admin && await bcrypt.compare(password, admin.password_hash)) {
      req.session.authenticated = true;
      return res.json({ success: true });
    }
    res.status(401).json({ error: "Invalid credentials" });
  } catch (err) {
    res.status(500).json({ error: "Database error" });
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

function requireAuth(req, res, next) {
  if (!req.session.authenticated) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  next();
}

app.use('/admin.html', (req, res, next) => {
  if (!req.session.authenticated) {
    return res.redirect('/login.html');
  }
  next();
});

app.get('/config.js', (req, res, next) => {
  if (process.env.TARGET_HOST) {
    res.type('application/javascript');
    res.send(`window.TARGET_HOST = "${process.env.TARGET_HOST}";`);
  } else {
    next();
  }
});

app.use(express.static(path.join(__dirname, 'public')));

function clientIP(req) {
  // Extract real IP, remove IPv4-mapped IPv6 prefix if present
  let ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
           req.headers['x-real-ip'] ||
           req.socket?.remoteAddress ||
           'unknown';
  if (ip.startsWith('::ffff:')) {
    ip = ip.substring(7);
  }
  return ip;
}

// ── /ping ───────────────────────────────────────
app.get('/ping', (_, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true });
});

// ── /my-ip ────────────────────────────────────────────────────────
app.get('/my-ip', (req, res) => res.json({ ip: clientIP(req) }));

// ── /download (Replacing /download-test) ──────────────────────────
const DL_SIZE = 10 * 1024 * 1024; // 10 MB
let dlBuf = null;
function getDLBuf() {
  if (!dlBuf) dlBuf = crypto.randomBytes(DL_SIZE);
  return dlBuf;
}
app.get('/download', (_, res) => {
  res.set({ 'Content-Type': 'application/octet-stream',
            'Content-Length': DL_SIZE, 'Cache-Control': 'no-store' });
  res.send(getDLBuf());
});

// ── /upload ───────────────────────────────────────────────────────
app.post('/upload', (req, res) => {
  req.on('data', () => {});
  req.on('end', () => res.json({ ok: true }));
});

// ── /traceroute ───────────────────────────────────────────────────
app.get('/traceroute', (req, res) => {
  const isWin = os.platform() === 'win32';
  const targetIp = clientIP(req);
  const mode = req.query.mode;
  let cmd   = isWin
    ? `tracert -h 20 ${targetIp}`
    : `traceroute -m 20 ${targetIp}`;

  if (mode === 'tcp' && !isWin) {
    cmd = `traceroute -T -p 80 ${targetIp}`;
  }

  res.set({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });

  exec(cmd, { timeout: 60000 }, (err, stdout, stderr) => {
    const raw = stdout || stderr || (err?.message ?? 'Traceroute failed');
    const hops = parseTraceroute(raw, isWin);
    res.json({ raw, hops, target: targetIp });
  });
});

function parseTraceroute(raw, isWin) {
  const hops = [];
  const lines = raw.split('\n');
  for (const line of lines) {
    const unixM = line.match(/^\s*(\d+)\s+([a-zA-Z0-9._-]+|\*)(?:\s+\([\d.]+\))?\s+([\d.]+|\*)\s*ms/);
    const winM  = line.match(/^\s*(\d+)\s+[\s\d<ms*]+\s+([a-zA-Z0-9._-]+)(?:\s+\[[\d.]+\])?\s*$/);

    if (unixM) {
      const hop = parseInt(unixM[1]);
      const ip  = unixM[2] === '*' ? '*' : unixM[2];
      const ms  = parseFloat(unixM[3]) || null;
      hops.push({ hop, ip, ms });
    } else if (winM) {
      hops.push({ hop: parseInt(winM[1]), ip: winM[2], ms: null });
    } else if (line.match(/^\s*\d+\s+\*\s+\*\s+\*/)) {
      const num = parseInt(line.match(/^\s*(\d+)/)[1]);
      hops.push({ hop: num, ip: '*', ms: null });
    }
  }
  return hops;
}

// ── /save-result ──────────────────────────────────────────────────
app.post('/save-result', (req, res) => {
  const { latency_avg, latency_min, latency_max, jitter, packet_loss, download_speed, upload_speed, traceroute } = req.body || {};
  const ip        = clientIP(req);
  const timestamp = new Date().toISOString();

  const txn = db.transaction(() => {
    let nextId = 1;
    const row = db.prepare('SELECT MAX(id) as maxId FROM network_checks').get();
    if (row && row.maxId) nextId = row.maxId + 1;
    
    const check_id = nextId.toString();

    const info = db.prepare(`
      INSERT INTO network_checks (check_id, timestamp, user_ip, latency_avg, latency_min, latency_max, jitter, packet_loss, download_speed, upload_speed, traceroute)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(check_id, timestamp, ip, latency_avg ?? null, latency_min ?? null, latency_max ?? null, jitter ?? null, packet_loss ?? null,
           download_speed ?? null, upload_speed ?? null, typeof traceroute === 'string' ? traceroute : JSON.stringify(traceroute ?? ''));

    return check_id;
  });

  const check_id = txn();
  res.json({ check_id, timestamp, ip });
});

// ── Admin APIs ────────────────────────────────────────────────────
app.get('/result/:id', requireAuth, (req, res) => {
  const id = req.params.id;
  const row = db.prepare('SELECT * FROM network_checks WHERE check_id = ?').get(id);
  if (!row) {
    return res.status(404).json({ error: "Check not found" });
  }
  res.json(row);
});

app.get('/results/latest', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM network_checks ORDER BY id DESC LIMIT 10').all();
  res.json(rows);
});

// ── /results ──────────────────────────────────────────────────────
app.get('/results', (_, res) => {
  const rows = db.prepare('SELECT * FROM network_checks ORDER BY id DESC LIMIT 100').all();
  res.json(rows);
});

app.get('/results/:check_id', (req, res) => {
  const row = db.prepare('SELECT * FROM network_checks WHERE check_id = ?').get(req.params.check_id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

// ── Start ─────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => console.log(`✅ NetDiag → http://0.0.0.0:${PORT}`));
