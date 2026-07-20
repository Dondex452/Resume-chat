import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import Database from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ limit: '10mb' }));

// Initialize SQLite database
const dbPath = path.join(__dirname, '..', 'data', 'resume.db');

// Create data directory if it doesn't exist
import fs from 'fs';
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(dbPath, (err) => {
  if (err) {
    console.error('Database error:', err);
  } else {
    console.log('Connected to SQLite database');
  }
});

// Promisify database methods
const dbAsync = {
  run: (sql, params) => new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  }),
  get: (sql, params) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  }),
  all: (sql, params) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  }),
  exec: (sql) => new Promise((resolve, reject) => {
    db.exec(sql, (err) => {
      if (err) reject(err);
      else resolve();
    });
  })
};

// Create tables
await dbAsync.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT,
    status TEXT DEFAULT 'draft',
    resume_json TEXT,
    template_id TEXT DEFAULT 'template-1',
    cover_letter_json TEXT,
    cover_letter_text TEXT,
    source_text TEXT,
    job_text TEXT,
    created_at TEXT,
    updated_at TEXT
  )
`);

await dbAsync.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    role TEXT,
    content TEXT,
    created_at TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  )
`);

// AI Provider wrapper (placeholder - will be implemented with actual provider)
const aiProvider = {
  async chat(messages, tools) {
    // This is a placeholder - will be replaced with actual OpenAI/Anthropic implementation
    const apiKey = process.env.AI_API_KEY;
    const provider = process.env.AI_PROVIDER || 'openai';
    
    if (!apiKey) {
      throw new Error('AI API key not configured. Please set AI_API_KEY in settings.');
    }
    
    // Placeholder response for development
    return {
      content: 'AI integration pending. Please configure your API key in settings.',
      toolCalls: []
    };
  }
};

// Resume JSON schema helper
const createEmptyResume = () => ({
  basics: { fullName: '', email: '', phone: '', location: '', summary: '', links: [] },
  work: [],
  education: [],
  skills: [],
  projects: [],
  certifications: [],
  languages: []
});

const createEmptyCoverLetter = () => ({
  recipient: { name: '', company: '', role: '' },
  intro: '',
  body: '',
  closing: '',
  tone: 'professional'
});

// ==================== SESSION ENDPOINTS ====================

// Get all sessions
app.get('/api/sessions', async (req, res) => {
  try {
    const sessions = await dbAsync.all('SELECT * FROM sessions ORDER BY updated_at DESC', []);
    res.json(sessions.map(s => ({
      ...s,
      resume_json: s.resume_json ? JSON.parse(s.resume_json) : null,
      cover_letter_json: s.cover_letter_json ? JSON.parse(s.cover_letter_json) : null
    })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single session
app.get('/api/sessions/:id', async (req, res) => {
  try {
    const session = await dbAsync.get('SELECT * FROM sessions WHERE id = ?', [req.params.id]);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    const messages = await dbAsync.all('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC', [session.id]);
    
    res.json({
      ...session,
      resume_json: session.resume_json ? JSON.parse(session.resume_json) : createEmptyResume(),
      cover_letter_json: session.cover_letter_json ? JSON.parse(session.cover_letter_json) : null,
      messages
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create new session
app.post('/api/sessions', async (req, res) => {
  try {
    const id = uuidv4();
    const now = new Date().toISOString();
    const title = req.body.title || 'New Resume';
    
    await dbAsync.run(`
      INSERT INTO sessions (id, title, status, resume_json, template_id, created_at, updated_at)
      VALUES (?, ?, 'draft', ?, ?, ?, ?)
    `, [id, title, JSON.stringify(createEmptyResume()), 'template-1', now, now]);
    
    res.json({ id, title, created_at: now });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update session
app.put('/api/sessions/:id', async (req, res) => {
  try {
    const { title, status, resume_json, template_id, cover_letter_json, cover_letter_text, source_text, job_text } = req.body;
    const now = new Date().toISOString();
    
    const updates = [];
    const values = [];
    
    if (title !== undefined) { updates.push('title = ?'); values.push(title); }
    if (status !== undefined) { updates.push('status = ?'); values.push(status); }
    if (resume_json !== undefined) { updates.push('resume_json = ?'); values.push(JSON.stringify(resume_json)); }
    if (template_id !== undefined) { updates.push('template_id = ?'); values.push(template_id); }
    if (cover_letter_json !== undefined) { updates.push('cover_letter_json = ?'); values.push(JSON.stringify(cover_letter_json)); }
    if (cover_letter_text !== undefined) { updates.push('cover_letter_text = ?'); values.push(cover_letter_text); }
    if (source_text !== undefined) { updates.push('source_text = ?'); values.push(source_text); }
    if (job_text !== undefined) { updates.push('job_text = ?'); values.push(job_text); }
    
    updates.push('updated_at = ?');
    values.push(now);
    values.push(req.params.id);
    
    await dbAsync.run(`UPDATE sessions SET ${updates.join(', ')} WHERE id = ?`, values);
    
    res.json({ success: true, updated_at: now });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete session
app.delete('/api/sessions/:id', async (req, res) => {
  try {
    await dbAsync.run('DELETE FROM messages WHERE session_id = ?', [req.params.id]);
    await dbAsync.run('DELETE FROM sessions WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== MESSAGE ENDPOINTS ====================

// Add message to session
app.post('/api/sessions/:id/messages', async (req, res) => {
  try {
    const { role, content } = req.body;
    const id = uuidv4();
    const now = new Date().toISOString();
    
    await dbAsync.run(`
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `, [id, req.params.id, role, content, now]);
    
    // Update session timestamp
    await dbAsync.run('UPDATE sessions SET updated_at = ? WHERE id = ?', [now, req.params.id]);
    
    res.json({ id, role, content, created_at: now });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== CHAT ENDPOINT ====================

// Send message and get AI response
app.post('/api/chat', async (req, res) => {
  try {
    const { sessionId, message } = req.body;
    
    if (!sessionId || !message) {
      return res.status(400).json({ error: 'sessionId and message are required' });
    }
    
    // Get session
    const session = await dbAsync.get('SELECT * FROM sessions WHERE id = ?', [sessionId]);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    // Get message history
    const messages = await dbAsync.all('SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC', [sessionId]);
    
    // Parse current resume
    const currentResume = session.resume_json ? JSON.parse(session.resume_json) : createEmptyResume();
    
    // Add user message to history
    messages.push({ role: 'user', content: message });
    
    // Save user message
    const userMsgId = uuidv4();
    const now = new Date().toISOString();
    await dbAsync.run(`
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES (?, ?, 'user', ?, ?)
    `, [userMsgId, sessionId, message, now]);
    
    // Call AI (placeholder)
    const aiResponse = await aiProvider.chat(messages, ['update_resume', 'update_cover_letter']);
    
    // Save assistant message
    const assistantMsgId = uuidv4();
    await dbAsync.run(`
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES (?, ?, 'assistant', ?, ?)
    `, [assistantMsgId, sessionId, aiResponse.content, now]);
    
    res.json({
      response: aiResponse.content,
      resumeUpdated: false
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== TEMPLATE ENDPOINTS ====================

// Get available templates
app.get('/api/templates', (req, res) => {
  const templates = Array.from({ length: 10 }, (_, i) => ({
    id: `template-${i + 1}`,
    name: `Template ${i + 1}`,
    description: `Professional template layout ${i + 1}`
  }));
  res.json(templates);
});

// ==================== EXPORT ENDPOINTS ====================

// Export to PDF (placeholder)
app.post('/api/export/pdf', (req, res) => {
  try {
    const { resume_json, template_id } = req.body;
    // Placeholder - will implement with Puppeteer
    res.json({ success: true, message: 'PDF export coming soon' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== SETTINGS ENDPOINT ====================

// Get settings (API key status only, never return the key)
app.get('/api/settings', (req, res) => {
  res.json({
    aiProvider: process.env.AI_PROVIDER || 'openai',
    hasApiKey: !!process.env.AI_API_KEY
  });
});

// Update settings
app.post('/api/settings', (req, res) => {
  const { apiKey, provider } = req.body;
  // In production, this should be stored securely (keychain, encrypted file)
  // For now, we'll just validate and acknowledge
  res.json({ success: true, hasApiKey: !!apiKey });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Database: ${dbPath}`);
});

export default app;
