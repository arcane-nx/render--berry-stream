import express from 'express';
import axios from 'axios';

const app = express();
const PORT = process.env.PORT || 3000;

const SCRAPE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.5'
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

// Proxy Rotation State
let proxyList = [];
let activeProxy = null; // Currently cached working proxy

// Fetch free public HTTP proxies
async function refreshProxyList() {
  console.log('[Proxy Rotator] Fetching free proxy list...');
  try {
    const res = await axios.get('https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=3000&country=all&ssl=yes&anonymity=anonymous', { timeout: 8000 });
    const list = res.data.split('\n').map(p => p.trim()).filter(Boolean);
    if (list.length > 0) {
      proxyList = list;
      console.log(`[Proxy Rotator] Successfully loaded ${list.length} proxies.`);
    }
  } catch (err) {
    console.error('[Proxy Rotator] Failed to fetch proxy list:', err.message);
  }
}

// Perform request through proxy rotating fallback
async function requestWithProxy(targetUrl, axiosConfig = {}) {
  // If we already have a cached working proxy, try it first to keep response times fast!
  if (activeProxy) {
    const [host, port] = activeProxy.split(':');
    try {
      const response = await axios({
        ...axiosConfig,
        url: targetUrl,
        proxy: { host, port: parseInt(port) },
        timeout: 4500
      });
      return response;
    } catch (e) {
      console.warn(`[Proxy Rotator] Cached proxy ${activeProxy} failed: ${e.message}. Removing from cache.`);
      activeProxy = null;
    }
  }

  // Load proxy list if empty
  if (proxyList.length === 0) {
    await refreshProxyList();
  }

  const shuffled = [...proxyList].sort(() => 0.5 - Math.random()).slice(0, 20);
  console.log(`[Proxy Rotator] Kicking off parallel tests on ${shuffled.length} proxies concurrently...`);

  // Create parallel promises
  const promises = shuffled.map(proxyStr => {
    const [host, port] = proxyStr.split(':');
    return axios({
      ...axiosConfig,
      url: targetUrl,
      proxy: { host, port: parseInt(port) },
      timeout: 5000
    }).then(response => {
      // Check if response contains valid play/caption data, otherwise reject to try next proxy
      if (response.data && response.data.code === 429) {
        throw new Error('Proxy blocked with 429');
      }
      return { response, proxyStr };
    });
  });

  try {
    // Promise.any resolves as soon as the first proxy responds successfully!
    const result = await Promise.any(promises);
    activeProxy = result.proxyStr;
    console.log(`[Proxy Rotator] Found working proxy concurrently: ${result.proxyStr}`);
    return result.response;
  } catch (err) {
    console.warn('[Proxy Rotator] All parallel proxy tests failed or timed out.');
  }

  // Last resort: Fallback to direct request (might fail with 403, but acts as final option)
  console.warn('[Proxy Rotator] Attempting direct connection...');
  return await axios({
    ...axiosConfig,
    url: targetUrl,
    timeout: 8000
  });
}

// Periodically refresh the proxy list pool every 15 minutes
setInterval(refreshProxyList, 900000);

// Helper: Verify if URL is valid HTTP/HTTPS
function isProxyableUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

// 1. Play Stream Endpoint Proxy
app.get('/api/play', async (req, res) => {
  const { subjectId, detailPath, se, ep, category } = req.query;
  if (!subjectId || !detailPath) {
    return res.status(400).json({ success: false, message: 'Missing subjectId or detailPath' });
  }

  const cat = category || 'movies';
  const season = se || 0;
  const episode = ep || 0;

  const playUrl = `https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/play?subjectId=${subjectId}&se=${season}&ep=${episode}&detailPath=${detailPath}`;
  console.log(`[Proxy Play] Requesting: ${detailPath} (se: ${season}, ep: ${episode})`);

  try {
    const response = await requestWithProxy(playUrl, {
      method: 'get',
      headers: {
        'User-Agent': SCRAPE_HEADERS['User-Agent'],
        'Accept': 'application/json, text/plain, */*',
        'Referer': `https://netfilm.world/spa/videoPlayPage/${cat}/${detailPath}`,
        'X-Source': 'aisearch_hola',
        'X-Client-Info': JSON.stringify({ timezone: 'Asia/Singapore' })
      }
    });

    res.json({ success: true, data: response.data?.data });
  } catch (error) {
    console.error('[Proxy Play] Error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch play info.', error: error.message });
  }
});

// 2. Caption Subtitle Endpoint Proxy
app.get('/api/caption', async (req, res) => {
  const { id, subjectId, detailPath, format, category } = req.query;
  if (!id || !subjectId || !detailPath) {
    return res.status(400).json({ success: false, message: 'Missing stream id, subjectId, or detailPath' });
  }

  const cat = category || 'movies';
  const fmt = format || 'MP4';
  const captionUrl = `https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/caption?format=${fmt}&id=${id}&subjectId=${subjectId}&detailPath=${detailPath}`;
  console.log(`[Proxy Caption] Requesting captions for stream ID: ${id}`);

  try {
    const response = await requestWithProxy(captionUrl, {
      method: 'get',
      headers: {
        'User-Agent': SCRAPE_HEADERS['User-Agent'],
        'Accept': 'application/json, text/plain, */*',
        'Referer': `https://netfilm.world/spa/videoPlayPage/${cat}/${detailPath}`,
        'X-Source': 'aisearch_hola',
        'X-Client-Info': JSON.stringify({ timezone: 'Asia/Singapore' })
      }
    });

    res.json({ success: true, data: response.data?.data });
  } catch (error) {
    console.error('[Proxy Caption] Error:', error.message);
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
  
  // Prime the proxy list asynchronously in the background
  refreshProxyList();
});
