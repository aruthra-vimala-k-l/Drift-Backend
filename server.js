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
const MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
];

async function callGemini(model, body) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data;
}

async function callGeminiWithFallback(body) {
  for (const model of MODELS) {
    try {
      console.log(`Trying model: ${model}`);
      const result = await callGemini(model, body);
      return result;
    } catch (e) {
      console.log(`Model ${model} failed: ${e.message}`);
    }
  }
  throw new Error('All models failed');
}

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Drift backend running' });
});

// Process audio note
app.post('/process-audio', upload.single('audio'), async (req, res) => {
  try {
    const { prompt } = req.body;
    const audioBuffer = req.file?.buffer;

    if (!audioBuffer) {
      return res.status(400).json({ error: 'No audio file provided' });
    }

    const base64Audio = audioBuffer.toString('base64');
    const mimeType = req.file.mimetype || 'audio/m4a';

    const body = {
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mimeType, data: base64Audio } }
        ]
      }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 1024 },
    };

    const data = await callGeminiWithFallback(body);
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) throw new Error('No response from Gemini');
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
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
      generationConfig: { temperature: 0.4, maxOutputTokens: 1024 },
    };

    const data = await callGeminiWithFallback(body);
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) throw new Error('No response from Gemini');
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    res.json({ success: true, result: parsed });
  } catch (e) {
    console.error('Text processing error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Drift backend running on port ${PORT}`));