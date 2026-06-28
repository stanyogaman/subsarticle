# YouTube → WordPress Article Generator
### AWSEEN Internal Tool

Paste any YouTube URL with captions → get a publish-ready WordPress article in seconds.

---

## Features
- Fetches YouTube captions automatically (no YouTube API key needed)
- Generates full HTML article using Claude AI
- Preview + HTML code view with one-click copy
- Supports Interview, Tutorial, News, Opinion article types
- Multi-language output (EN, RU, DE, FR, ES, TH)
- Download as .html file

---

## Setup

### 1. Upload files to Hostinger VPS
```bash
# Upload the folder via SFTP or Git
scp -r youtube-to-article/ user@your-server:/var/www/
```

### 2. Install dependencies
```bash
cd /var/www/youtube-to-article
npm install
```

### 3. Create your .env file
```bash
cp .env.example .env
nano .env
```
Add your Anthropic API key (get it at https://console.anthropic.com):
```
ANTHROPIC_API_KEY=sk-ant-your-key-here
PORT=3000
```

### 4. Start the server
```bash
# Run directly
node server.js

# OR with PM2 (recommended - keeps it running 24/7)
npm install -g pm2
pm2 start server.js --name youtube-to-article
pm2 save
pm2 startup
```

### 5. Set up Nginx reverse proxy (optional but recommended)
```nginx
server {
    listen 80;
    server_name yourtool.awseen.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

---

## How to use
1. Open the tool in browser
2. Paste a YouTube URL (video must have captions enabled)
3. Choose article type, tone, and language
4. Click **Generate Article**
5. Copy HTML → paste into WordPress Text/HTML editor

---

## Requirements
- Node.js 18+
- Anthropic API key
- YouTube video must have captions/subtitles enabled

---

## Troubleshooting
**"Could not fetch captions"** → The video doesn't have captions, or captions are disabled by the owner.

**"Sign in to confirm"** → This tool uses the youtube-transcript package which works without auth. If it fails, the video may have restricted captions.

---

Built by [AWSEEN](https://awseen.com) · AI Automation & Web Development
