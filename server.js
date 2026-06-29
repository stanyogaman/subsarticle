require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── In-memory cache (avoids re-fetching same video) ─────────────────────────
const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

function getCached(videoId) {
  const entry = cache.get(videoId);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  return null;
}

function setCache(videoId, data) {
  cache.set(videoId, { data, ts: Date.now() });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([^&\n?#]+)/,
    /(?:youtu\.be\/)([^&\n?#]+)/,
    /(?:youtube\.com\/embed\/)([^&\n?#]+)/,
    /(?:youtube\.com\/shorts\/)([^&\n?#]+)/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Shared browser-like headers
function getBrowserHeaders() {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Cookie': 'CONSENT=YES+cb; GPS=1; VISITOR_INFO1_LIVE=; YSC=; PREF=hl=en&gl=US',
  };
}

// Parse json3 caption format into plain text
function parseJson3(data) {
  const events = data.events || [];
  return events
    .filter(e => e.segs)
    .map(e => e.segs.map(s => s.utf8 || '').join(''))
    .map(l => l.replace(/\n/g, ' ').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Strategy 1: Direct timedtext API (fastest, no page load needed) ──────────
async function tryTimedtextAPI(videoId) {
  const langs = ['en', 'en-US', 'en-GB', 'a.en'];
  const headers = getBrowserHeaders();

  for (const lang of langs) {
    const url = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}&fmt=json3&xorb=2&xobt=3&xovt=3`;
    const res = await fetch(url, { headers });

    if (res.status === 429) throw new Error('RATE_LIMITED');
    if (!res.ok) continue;

    const text = await res.text();
    if (!text || text.trim() === '{}' || text.trim() === '') continue;

    const data = JSON.parse(text);
    if (!data.events || data.events.length === 0) continue;

    const transcript = parseJson3(data);
    if (transcript.length > 50) {
      console.log(`✅ Strategy 1 success (lang: ${lang})`);
      return transcript;
    }
  }
  throw new Error('No captions via timedtext API');
}

// ─── Strategy 2: Scrape watch page → extract caption track URL ────────────────
async function tryPageScrape(videoId) {
  const headers = getBrowserHeaders();
  const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, { headers });

  if (res.status === 429) throw new Error('RATE_LIMITED');
  if (!res.ok) throw new Error(`YouTube returned ${res.status}`);

  const html = await res.text();
  if (html.length < 1000) throw new Error('Page response too short — possible block');

  // Extract player response
  const match = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;/s);
  if (!match) throw new Error('Could not parse ytInitialPlayerResponse');

  const playerData = JSON.parse(match[1]);
  const tracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

  if (!tracks || tracks.length === 0) {
    throw new Error('No caption tracks found in player data');
  }

  // Pick best track (prefer manual EN, fall back to auto-generated)
  const track =
    tracks.find(t => t.languageCode === 'en' && t.kind !== 'asr') ||
    tracks.find(t => t.languageCode === 'en') ||
    tracks.find(t => t.languageCode?.startsWith('en')) ||
    tracks.find(t => t.kind === 'asr') ||
    tracks[0];

  const captionRes = await fetch(track.baseUrl + '&fmt=json3', { headers });
  if (!captionRes.ok) throw new Error(`Caption fetch failed: ${captionRes.status}`);

  const captionData = await captionRes.json();
  const transcript = parseJson3(captionData);

  if (!transcript || transcript.length < 50) throw new Error('Caption data empty');

  console.log(`✅ Strategy 2 success (track: ${track.languageCode})`);
  return transcript;
}

// ─── Strategy 3: InnerTube API (YouTube's internal mobile API) ────────────────
async function tryInnertube(videoId) {
  // Fetch page first to get visitor data and API key
  const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: getBrowserHeaders(),
  });

  if (pageRes.status === 429) throw new Error('RATE_LIMITED');
  const html = await pageRes.text();

  const apiKeyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
  const visitorMatch = html.match(/"visitorData":"([^"]+)"/);
  const clientVersionMatch = html.match(/"clientVersion":"([^"]+)"/);

  if (!apiKeyMatch) throw new Error('Could not find InnerTube API key');

  const apiKey = apiKeyMatch[1];
  const visitorData = visitorMatch ? visitorMatch[1] : '';
  const clientVersion = clientVersionMatch ? clientVersionMatch[1] : '2.20240101.00.00';

  // Get video info via InnerTube
  const body = {
    context: {
      client: {
        clientName: 'WEB',
        clientVersion,
        visitorData,
        hl: 'en',
        gl: 'US',
      },
    },
    videoId,
  };

  const itRes = await fetch(
    `https://www.youtube.com/youtubei/v1/player?key=${apiKey}&prettyPrint=false`,
    {
      method: 'POST',
      headers: { ...getBrowserHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );

  if (!itRes.ok) throw new Error(`InnerTube player API returned ${itRes.status}`);

  const itData = await itRes.json();
  const tracks = itData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

  if (!tracks || tracks.length === 0) throw new Error('No tracks from InnerTube');

  const track =
    tracks.find(t => t.languageCode === 'en' && t.kind !== 'asr') ||
    tracks.find(t => t.languageCode === 'en') ||
    tracks.find(t => t.kind === 'asr') ||
    tracks[0];

  const capRes = await fetch(track.baseUrl + '&fmt=json3', { headers: getBrowserHeaders() });
  if (!capRes.ok) throw new Error(`Caption fetch failed: ${capRes.status}`);

  const capData = await capRes.json();
  const transcript = parseJson3(capData);

  if (!transcript || transcript.length < 50) throw new Error('Empty InnerTube captions');

  console.log('✅ Strategy 3 (InnerTube) success');
  return transcript;
}

// ─── Main caption fetcher — tries all strategies with retry ───────────────────
async function fetchYouTubeCaptions(videoId) {
  // Check cache first
  const cached = getCached(videoId);
  if (cached) {
    console.log(`📦 Cache hit for ${videoId}`);
    return cached;
  }

  const strategies = [
    { name: 'TimedText API', fn: () => tryTimedtextAPI(videoId) },
    { name: 'Page Scrape',   fn: () => tryPageScrape(videoId) },
    { name: 'InnerTube',     fn: () => tryInnertube(videoId) },
  ];

  let lastError;

  for (const strategy of strategies) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`🔄 Trying ${strategy.name} (attempt ${attempt})...`);
        const transcript = await strategy.fn();
        setCache(videoId, transcript);
        return transcript;
      } catch (err) {
        lastError = err;
        console.warn(`⚠️ ${strategy.name} attempt ${attempt} failed: ${err.message}`);

        if (err.message === 'RATE_LIMITED' && attempt < 2) {
          console.log('⏳ Rate limited — waiting 3s before retry...');
          await sleep(3000);
        } else if (attempt < 2) {
          await sleep(1000);
        }
      }
    }
    // Small gap between strategies
    await sleep(500);
  }

  throw new Error(
    'Could not fetch captions after trying all methods. ' +
    (lastError?.message || '') +
    ' — Make sure the video has captions/subtitles enabled and is publicly accessible.'
  );
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.post('/api/transcript', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'YouTube URL is required' });

    const videoId = extractVideoId(url);
    if (!videoId) return res.status(400).json({ error: 'Could not extract video ID from URL' });

    const transcript = await fetchYouTubeCaptions(videoId);
    res.json({ success: true, transcript, wordCount: transcript.split(' ').length });
  } catch (error) {
    console.error('Transcript error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/generate', async (req, res) => {
  try {
    const { url, articleType, language, tone } = req.body;
    if (!url) return res.status(400).json({ error: 'YouTube URL is required' });

    const videoId = extractVideoId(url);
    if (!videoId) return res.status(400).json({ error: 'Could not extract video ID from URL' });

    let transcriptText;
    try {
      transcriptText = await fetchYouTubeCaptions(videoId);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }

    if (!transcriptText || transcriptText.length < 100) {
      return res.status(400).json({ error: 'Transcript is too short or empty.' });
    }

    const typePrompts = {
      interview: 'This is an interview. Write it as a compelling interview article with clear narrative flow, highlighting the most interesting insights from the guest.',
      tutorial: 'This is a tutorial/how-to video. Write it as a step-by-step guide article with numbered steps and clear instructions.',
      news: 'Write this as a news-style article with inverted pyramid structure — most important info first.',
      opinion: 'Write this as an opinion/thought leadership piece with a clear argument and supporting points.',
      general: 'Write this as a general informative blog post that educates the reader on the main topic.',
    };

    const toneMap = {
      professional: 'professional and authoritative',
      casual: 'conversational and friendly',
      engaging: 'engaging, dynamic, and story-driven',
    };

    const prompt = `You are an expert content writer and SEO specialist. Convert this YouTube video transcript into a well-structured, engaging WordPress blog article.

Article type: ${typePrompts[articleType] || typePrompts.general}
Tone: ${toneMap[tone] || toneMap.engaging}
Language: Write the entire article in ${language || 'English'}.

OUTPUT FORMAT — Return only clean HTML with these sections in order:
1. <h1> — SEO-optimized title
2. <p class="meta-description"> — Meta description (150-160 characters for SEO)
3. <p class="intro"> — Strong opening paragraph that hooks the reader
4. Main body with <h2> and <h3> subheadings, <p> paragraphs, <ul>/<li> lists where appropriate
5. <h2>Key Takeaways</h2> with <ul> bullet points
6. <p class="conclusion"> — Closing paragraph with a call to action

Rules:
- Use <strong> for emphasis on important points
- Keep paragraphs short (2-4 sentences max) for easy reading
- Do NOT include the word "transcript" anywhere
- Do NOT use markdown, only HTML tags
- Make it feel like a human journalist wrote this

TRANSCRIPT:
${transcriptText}`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    });

    const article = message.content[0].text;

    res.json({
      success: true,
      article,
      wordCount: article.replace(/<[^>]*>/g, '').split(/\s+/).length,
      transcriptWordCount: transcriptText.split(' ').length,
    });

  } catch (error) {
    console.error('Generate error:', error.message);
    res.status(500).json({ error: error.message || 'Something went wrong.' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', hasApiKey: !!process.env.ANTHROPIC_API_KEY, cacheSize: cache.size });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ YouTube to Article tool running on http://localhost:${PORT}`);
  console.log(`🔑 Anthropic API Key: ${process.env.ANTHROPIC_API_KEY ? 'Set ✓' : 'MISSING ✗'}`);
});
