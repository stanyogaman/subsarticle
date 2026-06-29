require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Extract video ID from any YouTube URL format
function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([^&\n?#]+)/,
    /(?:youtu\.be\/)([^&\n?#]+)/,
    /(?:youtube\.com\/embed\/)([^&\n?#]+)/,
    /(?:youtube\.com\/shorts\/)([^&\n?#]+)/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

// Fetch YouTube captions by scraping the watch page directly (no API key needed)
async function fetchYouTubeCaptions(videoId) {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // Use realistic browser headers to avoid bot detection
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Cache-Control': 'max-age=0',
  };

  const response = await fetch(watchUrl, { headers });
  if (!response.ok) throw new Error(`YouTube returned status ${response.status}`);

  const html = await response.text();

  // Extract ytInitialPlayerResponse JSON from the page
  const match = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;/s);
  if (!match) throw new Error('Could not parse YouTube player response');

  let playerResponse;
  try {
    playerResponse = JSON.parse(match[1]);
  } catch (e) {
    throw new Error('Could not parse player response JSON');
  }

  // Navigate to caption tracks
  const captions = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!captions || captions.length === 0) {
    throw new Error('No captions found. The video owner may have disabled captions.');
  }

  // Prefer English captions, fall back to first available
  const track = captions.find(t => t.languageCode === 'en')
    || captions.find(t => t.languageCode === 'en-US')
    || captions.find(t => t.kind === 'asr') // auto-generated
    || captions[0];

  // Fetch the caption XML
  const captionUrl = track.baseUrl + '&fmt=json3';
  const captionRes = await fetch(captionUrl, { headers });
  if (!captionRes.ok) throw new Error('Could not fetch caption data');

  const captionData = await captionRes.json();

  // Parse JSON3 caption format into clean text
  const events = captionData.events || [];
  const lines = events
    .filter(e => e.segs)
    .map(e => e.segs.map(s => s.utf8 || '').join(''))
    .map(line => line.replace(/\n/g, ' ').trim())
    .filter(line => line && line !== ' ');

  const text = lines.join(' ').replace(/\s+/g, ' ').trim();
  return { text, language: track.languageCode, trackName: track.name?.simpleText || 'Unknown' };
}

// API: Fetch transcript only
app.post('/api/transcript', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'YouTube URL is required' });

    const videoId = extractVideoId(url);
    if (!videoId) return res.status(400).json({ error: 'Could not extract video ID from URL' });

    const { text, language } = await fetchYouTubeCaptions(videoId);
    res.json({ success: true, transcript: text, wordCount: text.split(' ').length, language });

  } catch (error) {
    console.error('Transcript error:', error.message);
    res.status(500).json({ error: error.message || 'Could not fetch captions.' });
  }
});

// API: Generate article
app.post('/api/generate', async (req, res) => {
  try {
    const { url, articleType, language, tone } = req.body;
    if (!url) return res.status(400).json({ error: 'YouTube URL is required' });

    const videoId = extractVideoId(url);
    if (!videoId) return res.status(400).json({ error: 'Could not extract video ID from URL' });

    // Step 1: Fetch captions
    let transcriptText;
    try {
      const result = await fetchYouTubeCaptions(videoId);
      transcriptText = result.text;
    } catch (e) {
      return res.status(500).json({ error: e.message || 'Could not fetch captions.' });
    }

    if (!transcriptText || transcriptText.length < 100) {
      return res.status(400).json({ error: 'Transcript is too short or empty.' });
    }

    // Step 2: Build prompt
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

    // Step 3: Call Claude API
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
    res.status(500).json({ error: error.message || 'Something went wrong. Please try again.' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', hasApiKey: !!process.env.ANTHROPIC_API_KEY });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ YouTube to Article tool running on http://localhost:${PORT}`);
  console.log(`🔑 Anthropic API Key: ${process.env.ANTHROPIC_API_KEY ? 'Set ✓' : 'MISSING ✗'}`);
});
