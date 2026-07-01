# CineRift Stream & Play Proxy Backend

This is a standalone Express server designed to act as a proxy for MovieBox stream and caption API requests. It does **not** append rate-limit triggering headers like `CF-Worker` (found in Cloudflare Workers) and bypasses the `403` blocks encountered by AWS/Heroku IP addresses when deployed to platforms like Render or Railway.

## 🚀 How to Deploy to Render

1.  **Create a new Git Repository** containing only the contents of this folder (`render-stream-backend`).
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
6.  Click **Deploy Web Service**.

## 🔗 Connect it to your CineRift App

Once deployed, copy your Render Web Service URL (e.g. `https://cinerift-stream-backend.onrender.com`) and paste it as the `WORKER_URL` inside your main CineRift application's configuration:
*   On Heroku: `heroku config:set WORKER_URL="https://your-render-url.onrender.com" -a your-app-name`
*   Locally (in `.env`): `WORKER_URL=https://your-render-url.onrender.com`
