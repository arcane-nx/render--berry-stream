# CineRift Stream & Play Proxy Backend

This is a lightweight, dedicated Express server designed to act as an API proxy for MovieBox play metadata and caption requests (`/api/play` and `/api/caption`).

## 🎯 Architecture & Separation of Responsibilities

* **`render-stream-backend` (This Service):**
  * Dedicated exclusively to **API requests** (`/api/play`, `/api/caption`).
  * Does **not** append the `CF-Worker` header (which Cloudflare Workers inject and which triggers 403 blocks from MovieBox/Aoneroom API).
  * Forces IPv4 routing (`family: 4`) and spoofs legitimate mobile client headers.
  * Preserves your Render/Railway bandwidth limits by **not** proxying heavy video streams or downloads.
* **`cloudfare` (Cloudflare Worker):**
  * Dedicated to **heavy video media streaming** (`/api/proxy`) and **downloads** (`/api/download`).
  * Handles HLS playlist rewriting and edge caching of video chunks (.ts, .m4s, .mp4) on Cloudflare's global edge network.

## ✨ Features
* **Session Cookie Auto-Renewal:** Automatic 30-minute TTL with request coalescing to prevent thundering herd on cold start.
* **Auto-Retry on 401/403:** Automatically refreshes session cookies and retries if upstream rejects the token.
* **In-Memory LRU Cache:** Caches play metadata for 15 minutes to reduce upstream calls.
* **Lightweight & Fast:** Runs within Render's free 512MB RAM tier without memory leaks.
* **Uptime Monitoring:** Built-in `/health` and `/` endpoints for Render/Railway health check probes.

## 🚀 How to Deploy to Render

1.  **Create a new Git Repository** containing the contents of this folder (`render-stream-backend`).
    ```bash
    git init
    git add .
    git commit -m "Initial commit"
    ```
2.  **Push the repository** to your GitHub, GitLab, or Bitbucket account.
3.  **Log into Render** (https://render.com) and click **New +** -> **Web Service**.
4.  Connect your newly created Git repository.
5.  Configure the following settings in Render:
    *   **Name**: `cinerift-stream-backend`
    *   **Environment**: `Node`
    *   **Build Command**: `npm install`
    *   **Start Command**: `npm start`
    *   **Health Check Path**: `/health`
6.  Click **Deploy Web Service**.

## 🔗 Connect it to your CineRift App

Once deployed, copy your Render Web Service URL (e.g. `https://cinerift-stream-backend.onrender.com`) and paste it as `RENDER_URL` in your main CineRift application:

*   On Heroku: `heroku config:set RENDER_URL="https://your-render-url.onrender.com" -a your-app-name`
*   Locally (in `.env`): `RENDER_URL=https://your-render-url.onrender.com`
