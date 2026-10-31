'use strict';
// =============================================================================
//  Vision Auto Solutions -- reading training lessons aloud
//
//  Mounted by training.js. A lesson is split into short parts (the title, then
//  each paragraph, long ones at sentence ends) so the page can play them one
//  after another, show which paragraph is being read and skip back or ahead.
//
//  Voices, chosen by .env:
//    GEMINI_API_KEY        Gemini text-to-speech (Google AI Studio key).
//                          GEMINI_TTS_MODEL and GEMINI_TTS_VOICE change the
//                          model (gemini-2.5-flash-preview-tts) and voice (Kore).
//    GOOGLE_TTS_API_KEY    Google Cloud Text-to-Speech.
//                          GOOGLE_TTS_VOICE changes the voice (en-US-Neural2-F).
//    TRAINING_VOICE        gemini | google | browser, when both keys are set
//                          or to turn them off. Default: Gemini, then Google.
//  With neither key the page uses the browser's own voice; nothing is sent out.
//
//  Only the lesson text goes to Google. Each part is made once and kept in
//  data/voice-cache (named by a hash of the voice and the text), so a lesson
//  costs nothing to play again until its wording changes.
// =============================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PART_MAX = 1400;

// The text as it should be spoken: no emoji, menu paths read as a pause.
function speakable(s) {
  return String(s || '')
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}️‍]/gu, '')
    .replace(/\s+>\s+/g, ', then ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ([.,!?;:])/g, '$1')
    .trim();
}
// Title and summary first, then each paragraph; a long paragraph is cut at
// sentence ends. `p` is the paragraph the page highlights (-1: the heading).
function partsOf(m) {
  const out = [];
  const head = speakable([m.title, m.summary].filter(Boolean).join('. '));
  if (head) out.push({ p: -1, text: head });
  String(m.body || '').split(/\n\s*\n/).forEach((para, p) => {
    const text = speakable(para.replace(/\n/g, ' '));
    if (!text) return;
    let cur = '';
    for (const s of text.match(/[^.!?]+(?:[.!?]+["')\]]*|$)\s*/g) || [text]) {
      if (cur && (cur + s).length > PART_MAX) { out.push({ p, text: cur.trim() }); cur = ''; }
      cur += s;
    }
    if (cur.trim()) out.push({ p, text: cur.trim() });
  });
  return out;
}

function provider() {
  const want = String(process.env.TRAINING_VOICE || '').toLowerCase();
  const gemini = !!process.env.GEMINI_API_KEY, google = !!process.env.GOOGLE_TTS_API_KEY;
  if (want === 'browser') return 'browser';
  if (want === 'google' && google) return 'google';
  if (want === 'gemini' && gemini) return 'gemini';
  return gemini ? 'gemini' : google ? 'google' : 'browser';
}
function voiceId(p) {
  if (p === 'gemini') return 'gemini:' + (process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts') + ':' + (process.env.GEMINI_TTS_VOICE || 'Kore');
  if (p === 'google') return 'google:' + (process.env.GOOGLE_TTS_VOICE || 'en-US-Neural2-F');
  return 'browser';
}

// Gemini sends raw 16-bit PCM; a WAV header makes it playable.
function wav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
async function googleError(r, who) {
  let msg = '';
  try { const j = await r.json(); msg = (j.error && j.error.message) || ''; } catch (_) {}
  console.warn('[voice] ' + who + ' ' + r.status + ' ' + msg.slice(0, 300));
  const e = new Error(r.status === 429 ? who + ' is busy or over its limit. Try again in a minute.' : r.status === 400 || r.status === 403 ? who + ' refused the request. Check the API key in .env.' : who + ' did not answer (' + r.status + ').');
  e.status = 502; e.publicMessage = e.message;
  return e;
}
async function synth(p, text) {
  if (p === 'gemini') {
    const model = process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
      method: 'POST', signal: AbortSignal.timeout(90000),
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'Read this aloud in a clear, friendly, steady voice, like a trainer showing a new colleague the ropes:\n\n' + text }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: process.env.GEMINI_TTS_VOICE || 'Kore' } } } },
      }),
    });
    if (!r.ok) throw await googleError(r, 'Gemini');
    const j = await r.json();
    const part = (((j.candidates || [])[0] || {}).content || {}).parts || [];
    const data = part.find((x) => x.inlineData && x.inlineData.data);
    if (!data) throw Object.assign(new Error('Gemini sent no audio'), { status: 502, publicMessage: 'Gemini sent no audio for this part' });
    const rate = parseInt((/rate=(\d+)/.exec(data.inlineData.mimeType || '') || [])[1], 10) || 24000;
    return { buf: wav(Buffer.from(data.inlineData.data, 'base64'), rate), ext: '.wav' };
  }
  const name = process.env.GOOGLE_TTS_VOICE || 'en-US-Neural2-F';
  const r = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
    method: 'POST', signal: AbortSignal.timeout(60000),
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': process.env.GOOGLE_TTS_API_KEY },
    body: JSON.stringify({ input: { text }, voice: { languageCode: name.split('-').slice(0, 2).join('-'), name }, audioConfig: { audioEncoding: 'MP3' } }),
  });
  if (!r.ok) throw await googleError(r, 'Google Text-to-Speech');
  const j = await r.json();
  if (!j.audioContent) throw Object.assign(new Error('Google sent no audio'), { status: 502, publicMessage: 'Google sent no audio for this part' });
  return { buf: Buffer.from(j.audioContent, 'base64'), ext: '.mp3' };
}

function register(app, deps) {
  const { requireAdmin, lessonFor, fail } = deps;
  const DIR = path.join(__dirname, '..', 'data', 'voice-cache');
  fs.mkdirSync(DIR, { recursive: true });
  const making = new Map();   // hash -> promise, so two people pressing Listen make it once
  async function audioFor(p, text) {
    const hash = crypto.createHash('sha256').update(voiceId(p) + '\n' + text).digest('hex');
    for (const ext of ['.wav', '.mp3']) { const f = path.join(DIR, hash + ext); if (fs.existsSync(f)) return f; }
    if (!making.has(hash)) {
      making.set(hash, synth(p, text).then(({ buf, ext }) => {
        const f = path.join(DIR, hash + ext);
        fs.writeFileSync(f + '.tmp', buf); fs.renameSync(f + '.tmp', f);
        return f;
      }).finally(() => making.delete(hash)));
    }
    return making.get(hash);
  }

  // How the lesson will be read: the parts, and whose voice.
  app.get('/api/training/modules/:key/voice', requireAdmin, async (req, res) => {
    try {
      const m = await lessonFor(req, req.params.key);
      const p = provider();
      res.json({ provider: p, voice: p === 'browser' ? null : voiceId(p).split(':').pop(), parts: partsOf(m) });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/training/modules/:key/voice/:i', requireAdmin, async (req, res) => {
    try {
      const p = provider();
      if (p === 'browser') return res.status(404).json({ error: 'No Gemini or Google voice is set up' });
      const m = await lessonFor(req, req.params.key);
      const part = partsOf(m)[parseInt(req.params.i, 10)];
      if (!part) return res.status(404).json({ error: 'No such part' });
      const f = await audioFor(p, part.text);
      res.setHeader('Content-Type', f.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg');
      res.setHeader('Cache-Control', 'private, max-age=86400');
      fs.createReadStream(f).pipe(res);
    } catch (e) { fail(res, e); }
  });
}

module.exports = { register, partsOf, speakable, provider };
