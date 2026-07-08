import express from 'express';
import axios from 'axios';

const app = express();
const PORT = process.env.PORT || 3000;

const DEFAULT_HEADERS = {
  "X-Client-Info": '{"timezone":"Africa/Nairobi"}',
  "Accept-Language": "en-US,en;q=0.5",
  Accept: "application/json",
  "User-Agent": "okhttp/4.12.0",
  Referer: "https://h5.aoneroom.com",
  Host: "h5.aoneroom.com",
  Connection: "keep-alive",
  "X-Forwarded-For": "1.1.1.1",
  "CF-Connecting-IP": "1.1.1.1",
  "X-Real-IP": "1.1.1.1",
};

// Global CORS Middleware
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

let sessionCookies = '';

async function ensureCookiesAreAssigned() {
  if (!sessionCookies) {
    console.log('[Cookies] Initializing session cookies...');
    try {
      const res = await axios.get('https://h5.aoneroom.com/wefeed-h5-bff/app/get-latest-app-pkgs?app_name=moviebox', {
        headers: DEFAULT_HEADERS,
        timeout: 10000
      });
      const setCookie = res.headers['set-cookie'];
      if (setCookie) {
        sessionCookies = setCookie.map(c => c.split(';')[0]).join('; ');
        console.log('[Cookies] Session cookies initialized successfully.');
      }
    } catch (err) {
      console.error('[Cookies] Failed to initialize session cookies:', err.message);
    }
  }
}

// 1. Play Stream Endpoint Proxy
app.get('/api/play', async (req, res) => {
  const { subjectId, detailPath, se, ep, category } = req.query;
  if (!subjectId || !detailPath) {
    return res.status(400).json({ success: false, message: 'Missing subjectId or detailPath' });
  }

  const season = parseInt(se) || 0;
  const episode = parseInt(ep) || 0;

  console.log(`[Stream Backend] Play request: ${detailPath} (se: ${season}, ep: ${episode})`);

  try {
    await ensureCookiesAreAssigned();

    // Fetch stream resources (downloads) using Referer and Origin spoofing
    const playUrl = `https://h5.aoneroom.com/wefeed-h5-bff/web/subject/download?subjectId=${subjectId}&se=${season}&ep=${episode}`;
    const response = await axios.get(playUrl, {
      headers: {
        ...DEFAULT_HEADERS,
        Cookie: sessionCookies,
        Origin: 'https://fmoviesunblocked.net',
        Referer: `https://fmoviesunblocked.net/spa/videoPlayPage/movies/${detailPath}?id=${subjectId}&type=/movie/detail`
      },
      timeout: 15000
    });

    const data = response.data?.data || {};
    const downloads = data.downloads || [];

    // Map downloads format to the play format expected by the frontend
    const streams = downloads.map(d => ({
      id: d.id,
      url: d.url,
      resolutions: String(d.resolution || '720')
    }));

    res.json({
      success: true,
      data: {
        hasResource: streams.length > 0,
        streams: streams,
        hls: []
      }
    });
  } catch (error) {
    console.error('[Stream Backend] Play error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch play info.', error: error.message });
  }
});

// 2. Caption Subtitle Endpoint Proxy
app.get('/api/caption', async (req, res) => {
  const { id, subjectId, detailPath, format } = req.query;
  if (!id || !subjectId || !detailPath) {
    return res.status(400).json({ success: false, message: 'Missing stream id, subjectId, or detailPath' });
  }

  const fmt = format || 'MP4';

  console.log(`[Stream Backend] Caption request: stream ID ${id}`);

  try {
    await ensureCookiesAreAssigned();

    const captionUrl = `https://h5.aoneroom.com/wefeed-h5-bff/web/subject/caption?format=${fmt}&id=${id}&subjectId=${subjectId}&detailPath=${detailPath}`;
    const response = await axios.get(captionUrl, {
      headers: {
        ...DEFAULT_HEADERS,
        Cookie: sessionCookies,
        Origin: 'https://fmoviesunblocked.net',
        Referer: `https://fmoviesunblocked.net/spa/videoPlayPage/movies/${detailPath}?id=${subjectId}&type=/movie/detail`
      },
      timeout: 15000
    });

    res.json({ success: true, data: response.data?.data });
  } catch (error) {
    console.error('[Stream Backend] Caption error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch caption info.', error: error.message });
  }
});

// Default fallback
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.listen(PORT, () => {
  console.log(`\n🚀 CineRift Stream Backend is running on port ${PORT}`);
  console.log(`🔌 API endpoint (Play): http://localhost:${PORT}/api/play`);
  console.log(`🔌 API endpoint (Caption): http://localhost:${PORT}/api/caption`);
  
  // Prime session cookies on boot
  ensureCookiesAreAssigned();
});
