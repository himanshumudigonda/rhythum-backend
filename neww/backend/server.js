require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const ytdl = require('ytdl-core');
const ytSearch = require('yt-search');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;
const JIOSAAVN_NODE_URL = process.env.JIOSAAVN_NODE_URL || 'http://localhost:3000';
const DATABASE_URL = process.env.DATABASE_URL || null;

let pool = null;
async function initDb() {
  if (!DATABASE_URL) {
    console.log('No DATABASE_URL provided — running without DB (playlists & history will be in-memory).');
    return;
  }
  pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  // Create simple tables if they do not exist
  await pool.query(`
    CREATE TABLE IF NOT EXISTS playlists (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      tracks JSONB DEFAULT '[]'::jsonb,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS history (
      id SERIAL PRIMARY KEY,
      track JSONB NOT NULL,
      played_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('Connected to Postgres and ensured tables exist.');
}

initDb().catch(err => console.error('DB init error', err));

// In-memory fallback storage if no DB
const inMemory = { playlists: [], history: [] };

// Health
app.get('/health', (req, res) => res.json({status: 'ok'}));

// Unified search: jiosaavn + yt-search (hybrid)
app.get('/search', async (req, res) => {
  const q = req.query.q || '';
  const limit = parseInt(req.query.limit || '25');
  const sources = (req.query.sources || 'hybrid');

  let jioResults = [];
  let ytResults = [];
  const errors = [];

  if (!q) return res.status(400).json({error: 'q is required'});

  if (sources === 'jiosaavn' || sources === 'hybrid') {
    try {
      const r = await axios.get(`${JIOSAAVN_NODE_URL}/search`, { params: { q, limit } });
      jioResults = r.data.results || r.data || [];
      jioResults = jioResults.map(item => ({
        id: item.id || item.song_id || item.trackId || item.token || '',
        title: item.title || item.name || item.song || '',
        subtitle: item.subtitle || item.artists || item.singers || '',
        image: item.image || item.thumbnail || '',
        _source: 'jiosaavn',
        raw: item
      }));
    } catch (e) {
      errors.push({ jiosaavn: e.message });
    }
  }

  if (sources === 'yt' || sources === 'hybrid') {
    try {
      const r = await ytSearch(q);
      ytResults = (r.videos || []).slice(0, limit).map(v => ({
        id: v.videoId,
        title: v.title,
        subtitle: v.author ? v.author.name : '',
        image: v.thumbnail,
        duration: v.timestamp,
        _source: 'yt',
        raw: v
      }));
    } catch (e) {
      errors.push({ yt: e.message });
    }
  }

  const seen = new Set();
  const merged = [];
  const pushIfNew = (it) => {
    const key = (it.title + '|' + (it.subtitle || '')).replace(/[^a-zA-Z0-9]/g,'').toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(it);
    }
  };
  jioResults.forEach(pushIfNew);
  ytResults.forEach(pushIfNew);

  res.json({ query: q, count: merged.length, results: merged, errors });
});

// Get metadata for a song (proxy to source)
app.get('/song/:source/:id', async (req, res) => {
  const { source, id } = req.params;
  try {
    if (source === 'yt') {
      const info = await ytdl.getInfo(id);
      return res.json({ source:'yt', id, info });
    } else if (source === 'jiosaavn') {
      const r = await axios.get(`${JIOSAAVN_NODE_URL}/song/${id}`);
      return res.json({ source:'jiosaavn', id, data: r.data });
    } else {
      return res.status(400).json({ error: 'unknown source' });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Stream direct audio URL (best-effort) - returns JSON with audio_url
app.get('/stream/:source/:id', async (req, res) => {
  const { source, id } = req.params;
  try {
    if (source === 'yt') {
      const info = await ytdl.getInfo(id);
      const formats = info.formats.filter(f => f.mimeType && f.mimeType.includes('audio'));
      formats.sort((a,b) => (b.bitrate||0) - (a.bitrate||0));
      const chosen = formats[0];
      if (chosen && chosen.url) return res.json({ source:'yt', id, audio_url: chosen.url });
      if (info.videoDetails && info.videoDetails.streamingData && info.videoDetails.streamingData.adaptiveFormats) {
        const af = info.videoDetails.streamingData.adaptiveFormats.find(f => f.mimeType && f.mimeType.includes('audio'));
        if (af && af.url) return res.json({ source:'yt', id, audio_url: af.url });
      }
      return res.status(500).json({ error: 'no audio url found' });
    } else if (source === 'jiosaavn') {
      const r = await axios.get(`${JIOSAAVN_NODE_URL}/song/${id}`);
      const data = r.data;
      const mediaUrl = data.media_url || data.url || (data.media && data.media[0] && data.media[0].url) || null;
      if (mediaUrl) return res.json({ source:'jiosaavn', id, audio_url: mediaUrl });
      return res.status(500).json({ error: 'jiosaavn audio url not found' });
    } else {
      return res.status(400).json({ error: 'unknown source' });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Proxy stream: stable URL that forwards bytes (use this for mobile playback)
app.get('/proxy-stream/:source/:id', async (req, res) => {
  const { source, id } = req.params;
  try {
    let origin;
    if (source === 'yt') {
      const info = await ytdl.getInfo(id);
      const formats = info.formats.filter(f => f.mimeType && f.mimeType.includes('audio'));
      formats.sort((a,b) => (b.bitrate||0) - (a.bitrate||0));
      origin = formats[0].url || null;
    } else if (source === 'jiosaavn') {
      const r = await axios.get(`${JIOSAAVN_NODE_URL}/song/${id}`);
      const data = r.data;
      origin = data.media_url || data.url || (data.media && data.media[0] && data.media[0].url) || null;
    }
    if (!origin) return res.status(500).json({ error: 'origin url not found' });

    const response = await axios.get(origin, { responseType: 'stream', headers: { Range: req.headers.range || '' } });
    res.setHeader('content-type', response.headers['content-type'] || 'audio/mpeg');
    if (response.headers['content-length']) res.setHeader('content-length', response.headers['content-length']);
    if (response.headers['accept-ranges']) res.setHeader('accept-ranges', response.headers['accept-ranges']);
    response.data.pipe(res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Simple recommend endpoint: content-based using title/subtitle overlap
app.post('/recommend', async (req, res) => {
  const recent = req.body || [];
  const tokenize = (s='') => (s||'').toString().toLowerCase().replace(/[^a-z0-9 ]/g,' ').split(/\s+/).filter(Boolean);
  const profile = {};
  recent.forEach(r => {
    tokenize(r.title).forEach(t => profile[t]=(profile[t]||0)+2);
    tokenize(r.subtitle).forEach(t => profile[t]=(profile[t]||0)+1);
  });
  let pool = [];
  try {
    const jr = await axios.get(`${JIOSAAVN_NODE_URL}/search`, { params: { q: 'trending', limit: 40 } });
    const jpool = jr.data.results || jr.data || [];
    pool = pool.concat(jpool.map(item=>({...item, _source:'jiosaavn'})));
  } catch(e) {}
  const topTokens = Object.keys(profile).slice(0,3);
  for (const t of topTokens) {
    try {
      const r = await ytSearch(t);
      pool = pool.concat((r.videos || []).slice(0,10).map(v=>({...v, _source:'yt'})));
    } catch(e){}
  }
  const score = (item) => {
    const title = (item.title||item.name||'').toString();
    const subtitle = (item.subtitle||item.author||'').toString();
    let s=0;
    tokenize(title).forEach(tok => s+= (profile[tok]||0)*2 );
    tokenize(subtitle).forEach(tok => s+= (profile[tok]||0) );
    if (item._source==='jiosaavn') s+=1;
    return s;
  };
  const scored = pool.map(p=>({score:score(p), item:p})).sort((a,b)=>b.score-a.score).slice(0,30).map(x=>x.item);
  return res.json({count:scored.length, results: scored});
});

// Playlist endpoints (DB-backed if DATABASE_URL set, otherwise in-memory)
app.get('/playlists', async (req, res) => {
  try {
    if (pool) {
      const r = await pool.query('SELECT id, name, tracks, created_at FROM playlists ORDER BY created_at DESC');
      return res.json({ results: r.rows });
    } else {
      return res.json({ results: inMemory.playlists });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/playlists', async (req, res) => {
  try {
    const { name, tracks } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    if (pool) {
      const r = await pool.query('INSERT INTO playlists(name, tracks) VALUES($1, $2) RETURNING id, name, tracks, created_at', [name, JSON.stringify(tracks||[])]);
      return res.json({ playlist: r.rows[0] });
    } else {
      const p = { id: inMemory.playlists.length+1, name, tracks: tracks||[], created_at: new Date() };
      inMemory.playlists.unshift(p);
      return res.json({ playlist: p });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/history', async (req, res) => {
  try {
    const { track } = req.body || {};
    if (!track) return res.status(400).json({ error: 'track required' });
    if (pool) {
      await pool.query('INSERT INTO history(track) VALUES($1)', [JSON.stringify(track)]);
      return res.json({ ok: true });
    } else {
      inMemory.history.unshift({ id: inMemory.history.length+1, track, played_at: new Date() });
      return res.json({ ok: true });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log('Rhythum backend running on port', PORT));