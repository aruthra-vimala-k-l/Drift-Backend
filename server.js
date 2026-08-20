require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fetch = require('node-fetch');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Five models cycled in a loop. No truncation of long audio — we retry
// the SAME audio through every model, up to 7 rounds (35 attempts total).
const MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
];
const MAX_ROUNDS = 7;                 // 5 models x 7 rounds = 35 attempts
const PER_CALL_TIMEOUT_MS = 90000;    // 90s per individual model call
const ROUND_BACKOFF_MS = 1500;        // brief pause between full rounds

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callGemini(model, body) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeout: PER_CALL_TIMEOUT_MS,
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new Error('Empty response');
  const clean = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(clean); // throws if not valid JSON -> treated as a failed attempt
}

// Cycle all models, up to MAX_ROUNDS times. Return the first valid parse.
// Only give up after every attempt (5 x 7 = 35) has failed.
async function callGeminiWithRetry(body) {
  let attempt = 0;
  let lastErr = null;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    for (const model of MODELS) {
      attempt++;
      try {
        console.log(`Attempt ${attempt}/${MODELS.length * MAX_ROUNDS} — round ${round}, model ${model}`);
        const result = await callGemini(model, body);
        console.log(`Success on attempt ${attempt} (${model})`);
        return result;
      } catch (e) {
        lastErr = e;
        console.log(`  attempt ${attempt} (${model}) failed: ${e.message}`);
      }
    }
    if (round < MAX_ROUNDS) await sleep(ROUND_BACKOFF_MS);
  }
  throw new Error(`All ${MODELS.length * MAX_ROUNDS} attempts failed. Last error: ${lastErr?.message}`);
}

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Drift backend running', models: MODELS, maxAttempts: MODELS.length * MAX_ROUNDS });
});

// Process audio note — no size limit / no truncation; long audio is retried.
app.post('/process-audio', upload.single('audio'), async (req, res) => {
  try {
    const { prompt } = req.body;
    const audioBuffer = req.file?.buffer;
    if (!audioBuffer) return res.status(400).json({ error: 'No audio file provided' });

    const base64Audio = audioBuffer.toString('base64');
    const mimeType = req.file.mimetype || 'audio/m4a';

    const body = {
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mimeType, data: base64Audio } },
        ],
      }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 2048 },
    };

    const parsed = await callGeminiWithRetry(body);
    res.json({ success: true, result: parsed });
  } catch (e) {
    console.error('Audio processing error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Process text note
app.post('/process-text', async (req, res) => {
  try {
    const { prompt } = req.body;
    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 2048 },
    };
    const parsed = await callGeminiWithRetry(body);
    res.json({ success: true, result: parsed });
  } catch (e) {
    console.error('Text processing error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Drift backend running on port ${PORT}`));
