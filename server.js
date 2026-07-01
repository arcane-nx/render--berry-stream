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
  console.log(`[Proxy Play] Fetching play info: ${detailPath} (se: ${season}, ep: ${episode})`);

  try {
    const response = await axios.get(playUrl, {
      headers: {
        'User-Agent': SCRAPE_HEADERS['User-Agent'],
        'Accept': 'application/json, text/plain, */*',
        'Referer': `https://netfilm.world/spa/videoPlayPage/${cat}/${detailPath}`,
        'X-Source': 'aisearch_hola',
        'X-Client-Info': JSON.stringify({ timezone: 'Asia/Singapore' })
      },
      timeout: 10000
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
  console.log(`[Proxy Caption] Fetching captions for stream ID: ${id}`);

  try {
    const response = await axios.get(captionUrl, {
      headers: {
        'User-Agent': SCRAPE_HEADERS['User-Agent'],
        'Accept': 'application/json, text/plain, */*',
        'Referer': `https://netfilm.world/spa/videoPlayPage/${cat}/${detailPath}`,
        'X-Source': 'aisearch_hola',
        'X-Client-Info': JSON.stringify({ timezone: 'Asia/Singapore' })
      },
      timeout: 10000
    });

    res.json({ success: true, data: response.data?.data });
  } catch (error) {
    console.error('[Proxy Caption] Error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch caption info.', error: error.message });
  }
});

// 3. CORS Proxy for .m3u8 Playlist & .ts Stream Chunks
app.get('/api/proxy', async (req, res) => {
  const targetUrlStr = req.query.url;
  if (!targetUrlStr) {
    return res.status(400).send('Missing target url query parameter.');
  }

  if (!isProxyableUrl(targetUrlStr)) {
    return res.status(403).send('Refused: invalid URL scheme.');
  }

  const targetUrl = new URL(targetUrlStr);
  const headers = {
    'User-Agent': SCRAPE_HEADERS['User-Agent'],
    'Referer': 'https://netfilm.world/'
  };

  // Support range requests for video seeking/scrubbing
  if (req.headers.range) {
    headers['Range'] = req.headers.range;
  }

  try {
    const response = await axios({
      method: 'get',
      url: targetUrl.href,
      headers: headers,
      responseType: 'stream',
      timeout: 25000
    });

    const contentType = response.headers['content-type'] || '';
    
    // Intercept M3U8 files to rewrite relative chunk paths
    if (contentType.includes('application/x-mpegURL') || contentType.includes('application/vnd.apple.mpegurl') || targetUrl.pathname.endsWith('.m3u8')) {
      let text = '';
      
      // Buffer the stream into text
      await new Promise((resolve, reject) => {
        response.data.on('data', chunk => { text += chunk.toString(); });
        response.data.on('end', resolve);
        response.data.on('error', reject);
      });

      const lines = text.split('\n');
      const rewrittenLines = lines.map(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          try {
            const absolute = new URL(trimmed, targetUrl.href).href;
            const selfUrl = `${req.protocol}://${req.get('host')}/api/proxy?url=${encodeURIComponent(absolute)}`;
            return selfUrl;
          } catch (e) {
            return line;
          }
        }
        return line;
      });

      res.setHeader('Content-Type', 'application/x-mpegURL');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      return res.send(rewrittenLines.join('\n'));
    }

    // Forward standard segment chunks (.ts / .mp4)
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.status(response.status);
    
    const headersToCopy = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
    headersToCopy.forEach(h => {
      if (response.headers[h]) {
        res.setHeader(h, response.headers[h]);
      }
    });

    response.data.pipe(res);
  } catch (error) {
    console.error('[Proxy Stream] Error:', error.message);
    res.status(500).send('Error streaming media: ' + error.message);
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
  console.log(`🔌 API endpoint (CORS Proxy): http://localhost:${PORT}/api/proxy?url=ENCODED_URL\n`);
});
