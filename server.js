import express from 'express';
import axios from 'axios';

// Force Axios to use IPv4 to bypass broken or blocked IPv6 routes
axios.defaults.family = 4;

const app = express();
const PORT = process.env.PORT || 3000;

const DEFAULT_HEADERS = {
  "X-Client-Info": '{"timezone":"Africa/Nairobi"}',
  "Accept-Language": "en-US,en;q=0.5",
  Accept: "application/json",
  "User-Agent": "okhttp/4.12.0",
  Referer: "https://h5.aoneroom.com",
  Connection: "keep-alive",
  "X-Forwarded-For": "1.1.1.1",
  "CF-Connecting-IP": "1.1.1.1",
  "X-Real-IP": "1.1.1.1",
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Range, Authorization, X-Requested-With',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Disposition'
};

// Global CORS Middleware
app.use((req, res, next) => {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    res.setHeader(key, value);
  }
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// Health check & root endpoints for Render / Railway uptime monitors
app.get('/', (req, res) => {
  res.json({ service: 'cinerift-stream-backend', status: 'online', uptime: process.uptime() });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now(), uptime: process.uptime() });
});

// Session Cookie Management with TTL and Request Coalescing
let sessionCookies = '';
let cookiesExpiresAt = 0;
let inFlightCookiePromise = null;

async function ensureCookiesAreAssigned(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && sessionCookies && now < cookiesExpiresAt) {
    return sessionCookies;
  }
  if (inFlightCookiePromise && !forceRefresh) {
    return inFlightCookiePromise;
  }

  inFlightCookiePromise = (async () => {
    console.log(`[Cookies] ${forceRefresh ? 'Refreshing' : 'Initializing'} session cookies...`);
    try {
      const res = await axios.get(`https://h5.aoneroom.com/wefeed-h5-bff/app/get-latest-app-pkgs?app_name=moviebox&t=${Date.now()}_${Math.random()}`, {
        headers: {
          ...DEFAULT_HEADERS,
          Host: 'h5.aoneroom.com'
        },
        timeout: 10000
      });
      const setCookie = res.headers['set-cookie'];
      if (setCookie && setCookie.length > 0) {
        sessionCookies = setCookie.map(c => c.split(';')[0]).join('; ');
        cookiesExpiresAt = Date.now() + 30 * 60 * 1000; // 30-minute TTL
        console.log('[Cookies] Session cookies assigned successfully.');
      }
    } catch (err) {
      console.error('[Cookies] Failed to initialize session cookies:', err.message);
    } finally {
      inFlightCookiePromise = null;
    }
    return sessionCookies;
  })();

  return inFlightCookiePromise;
}

// In-Memory Play Cache (15-minute TTL, max 500 items)
const playCache = new Map();
const PLAY_CACHE_TTL = 15 * 60 * 1000;

function getCachedPlay(key) {
  const item = playCache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiresAt) {
    playCache.delete(key);
    return null;
  }
  return item.data;
}

function setCachedPlay(key, data) {
  if (playCache.size > 500) {
    const oldestKey = playCache.keys().next().value;
    playCache.delete(oldestKey);
  }
  playCache.set(key, { data, expiresAt: Date.now() + PLAY_CACHE_TTL });
}

function buildReferer(detailPath, subjectId, category, season, episode) {
  const isTv = category === 'tv' || category === 'series' || season > 0 || episode > 0;
  const catPath = isTv ? 'tv' : 'movies';
  const catType = isTv ? '/tv/detail' : '/movie/detail';
  return `https://fmoviesunblocked.net/spa/videoPlayPage/${catPath}/${detailPath}?id=${subjectId}&type=${catType}`;
}

// 1. Play Stream Endpoint Proxy
app.get('/api/play', async (req, res) => {
  const { subjectId, detailPath, se, ep, category } = req.query;
  if (!subjectId || !detailPath) {
    return res.status(400).json({ success: false, message: 'Missing subjectId or detailPath' });
  }

  const season = parseInt(se, 10) || 0;
  const episode = parseInt(ep, 10) || 0;
  const cacheKey = `${subjectId}:${season}:${episode}`;

  const cached = getCachedPlay(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  console.log(`[Stream Backend] Play request: ${detailPath} (se: ${season}, ep: ${episode})`);

  try {
    let cookies = await ensureCookiesAreAssigned();
    const playUrl = `https://h5.aoneroom.com/wefeed-h5-bff/web/subject/download?subjectId=${subjectId}&se=${season}&ep=${episode}`;
    const referer = buildReferer(detailPath, subjectId, category, season, episode);

    let response;
    try {
      response = await axios.get(playUrl, {
        headers: {
          ...DEFAULT_HEADERS,
          Cookie: cookies,
          Host: 'h5.aoneroom.com',
          Origin: 'https://fmoviesunblocked.net',
          Referer: referer
        },
        timeout: 15000
      });
    } catch (err) {
      if (err.response && (err.response.status === 401 || err.response.status === 403)) {
        console.warn('[Stream Backend] 401/403 received, refreshing cookies and retrying...');
        cookies = await ensureCookiesAreAssigned(true);
        response = await axios.get(playUrl, {
          headers: {
            ...DEFAULT_HEADERS,
            Cookie: cookies,
            Host: 'h5.aoneroom.com',
            Origin: 'https://fmoviesunblocked.net',
            Referer: referer
          },
          timeout: 15000
        });
      } else {
        throw err;
      }
    }

    const data = response.data?.data || {};
    const downloads = data.downloads || [];
    const captions = data.captions || [];

    const streams = downloads.map(d => ({
      id: d.id,
      url: d.url,
      resolution: String(d.resolution || '720'),
      size: d.size || null
    }));

    const subtitleTracks = captions.map(c => ({
      id: c.id,
      language: c.lanName || 'Unknown',
      code: c.lan || 'en',
      url: c.url
    }));

    const result = {
      success: true,
      data: {
        hasResource: streams.length > 0,
        streams,
        captions: subtitleTracks,
        freeNum: data.freeNum ?? 0,
        limited: data.limited ?? false,
        limitedCode: data.limitedCode || ''
      }
    };

    if (streams.length > 0 && !data.limited) {
      setCachedPlay(cacheKey, result);
    }

    res.json(result);
  } catch (error) {
    console.error('[Stream Backend] Play error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch play info.', error: error.message });
  }
});

// 2. Caption Subtitle Endpoint Proxy
app.get('/api/caption', async (req, res) => {
  const { id, subjectId, detailPath, format, category } = req.query;
  if (!id || !subjectId || !detailPath) {
    return res.status(400).json({ success: false, message: 'Missing stream id, subjectId, or detailPath' });
  }

  const fmt = format || 'MP4';
  const referer = buildReferer(detailPath, subjectId, category, 0, 0);

  console.log(`[Stream Backend] Caption request: stream ID ${id}`);

  try {
    let cookies = await ensureCookiesAreAssigned();
    const captionUrl = `https://h5.aoneroom.com/wefeed-h5-bff/web/subject/caption?format=${fmt}&id=${id}&subjectId=${subjectId}&detailPath=${detailPath}`;

    let response;
    try {
      response = await axios.get(captionUrl, {
        headers: {
          ...DEFAULT_HEADERS,
          Cookie: cookies,
          Host: 'h5.aoneroom.com',
          Origin: 'https://fmoviesunblocked.net',
          Referer: referer
        },
        timeout: 15000
      });
    } catch (err) {
      if (err.response && (err.response.status === 401 || err.response.status === 403)) {
        console.warn('[Stream Backend] 401/403 received on caption, refreshing cookies and retrying...');
        cookies = await ensureCookiesAreAssigned(true);
        response = await axios.get(captionUrl, {
          headers: {
            ...DEFAULT_HEADERS,
            Cookie: cookies,
            Host: 'h5.aoneroom.com',
            Origin: 'https://fmoviesunblocked.net',
            Referer: referer
          },
          timeout: 15000
        });
      } else {
        throw err;
      }
    }

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
  console.log(`🔌 API endpoint (Play):    http://localhost:${PORT}/api/play`);
  console.log(`🔌 API endpoint (Caption): http://localhost:${PORT}/api/caption`);
  console.log(`🩺 Health check:           http://localhost:${PORT}/health`);

  // Prime session cookies on boot
  ensureCookiesAreAssigned();
});
