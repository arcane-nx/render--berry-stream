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

// Proxy Rotation State with fallback default proxies to prevent cold-boot fetch blocking
let proxyList = [
  '45.174.93.130:999',
  '103.152.112.162:80',
  '103.83.232.122:80',
  '117.250.3.58:80',
  '43.200.77.123:3128',
  '20.206.106.192:80',
  '20.219.180.149:3128',
  '20.24.43.214:80',
  '20.205.61.143:80'
];
let activeProxy = null; // Currently cached working proxy

// Fetch free public HTTPS-only proxies from verified GitHub sources and ProxyScrape
async function refreshProxyList() {
  console.log('[Proxy Rotator] Fetching free proxy list...');
  const sources = [
    'https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-https.txt',
    'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt',
    'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=3000&country=all&ssl=yes&anonymity=anonymous'
  ];

  let mergedList = [];

  for (const source of sources) {
    try {
      const res = await axios.get(source, { timeout: 6000 });
      const list = res.data
        .split('\n')
        .map(p => p.trim())
        .filter(p => p && p.includes(':'));
      if (list.length > 0) {
        mergedList = mergedList.concat(list);
        console.log(`[Proxy Rotator] Loaded ${list.length} HTTPS proxies from source: ${source}`);
      }
    } catch (err) {
      console.warn(`[Proxy Rotator] Failed to fetch from source ${source}: ${err.message}`);
    }
  }

  // De-duplicate the list
  const unique = Array.from(new Set(mergedList));
  if (unique.length > 0) {
    proxyList = unique;
    console.log(`[Proxy Rotator] Successfully loaded a total of ${unique.length} unique HTTPS proxies.`);
  } else {
    console.error('[Proxy Rotator] Could not load any proxies from any sources.');
  }
}

// Perform request through proxy rotating fallback
async function requestWithProxy(targetUrl, axiosConfig = {}) {
  const isPlayUrl = targetUrl.includes('/subject/play');
  let fallbackResponse = null;

  // 1. If we already have a cached working proxy, try it first to keep response times fast!
  if (activeProxy) {
    const [host, port] = activeProxy.split(':');
    console.log(`[Proxy Rotator] Attempting cached working proxy first: ${activeProxy}...`);
    try {
      const response = await axios({
        ...axiosConfig,
        url: targetUrl,
        proxy: { host, port: parseInt(port) },
        timeout: 3000
      });
      if (!isPlayUrl || (response.data && response.data.data && response.data.data.hasResource)) {
        console.log(`[Proxy Rotator] Cached working proxy succeeded: ${activeProxy}`);
        return response;
      }
      console.warn(`[Proxy Rotator] Cached proxy ${activeProxy} returned no active resources.`);
      activeProxy = null;
    } catch (e) {
      console.warn(`[Proxy Rotator] Cached proxy ${activeProxy} failed: ${e.message}. Removing from cache.`);
      activeProxy = null;
    }
  }

  // 2. Try a quick direct connection next. If it is not blocked by the API target (e.g. returns 200),
  // we bypass all proxy overhead. However, if it's a play URL and returns no resources (possibly geoblocked),
  // we keep it as a fallback but still search for a working proxy.
  console.log('[Proxy Rotator] Attempting quick direct connection...');
  try {
    const directResponse = await axios({
      ...axiosConfig,
      url: targetUrl,
      timeout: 2500
    });
    if (directResponse.data && directResponse.data.code !== 403 && directResponse.data.code !== 429) {
      if (isPlayUrl && (!directResponse.data.data || !directResponse.data.data.hasResource)) {
        console.log('[Proxy Rotator] Direct connection returned no stream resources (possibly geoblocked). Will try proxy rotator.');
        fallbackResponse = directResponse;
      } else {
        console.log('[Proxy Rotator] Direct connection succeeded.');
        return directResponse;
      }
    }
  } catch (directError) {
    console.log(`[Proxy Rotator] Direct connection failed or timed out: ${directError.message}. Proceeding to proxy rotation.`);
  }

  // 3. Load proxy list in background if empty (do not block)
  if (proxyList.length === 0) {
    refreshProxyList();
  }

  const shuffled = [...proxyList].sort(() => 0.5 - Math.random());
  const batchSize = 3;
  console.log(`[Proxy Rotator] Testing proxies in batches of ${batchSize}...`);

  for (let i = 0; i < shuffled.length && i < 15; i += batchSize) {
    const batch = shuffled.slice(i, i + batchSize);
    console.log(`[Proxy Rotator] Testing batch: ${batch.join(', ')}`);
    
    const promises = batch.map(proxyStr => {
      const [host, port] = proxyStr.split(':');
      return axios({
        ...axiosConfig,
        url: targetUrl,
        proxy: { host, port: parseInt(port) },
        timeout: 3000
      }).then(response => {
        if (response.data && response.data.code === 429) {
          throw new Error('Proxy blocked with 429');
        }
        if (isPlayUrl && (!response.data || !response.data.data || !response.data.data.hasResource)) {
          throw new Error('Proxy returned no active resources (possibly geoblocked)');
        }
        return { response, proxyStr };
      });
    });

    try {
      const result = await Promise.any(promises);
      activeProxy = result.proxyStr;
      console.log(`[Proxy Rotator] Found working proxy in batch: ${result.proxyStr}`);
      return result.response;
    } catch (e) {
      console.warn(`[Proxy Rotator] Batch starting at index ${i} failed or timed out. Trying next batch...`);
    }
  }

  // Last resort: Fallback to direct response if it succeeded, otherwise attempt final direct connection
  if (fallbackResponse) {
    console.warn('[Proxy Rotator] All proxy batches failed. Falling back to the direct connection response.');
    return fallbackResponse;
  }

  console.warn('[Proxy Rotator] All proxy batches failed. Attempting final direct connection...');
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
