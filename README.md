# Automatic Content Downloader

A small Node.js web app for downloading video and image posts from supported social platforms.

## Supported platforms

- Instagram
- Facebook
- Threads
- TikTok
- Douyin

## Features

- Paste one or more supported links
- Get available media assets from the backend
- Download videos or images through the app UI
- Ready for deployment on Render

## Requirements

- Node.js 18 or newer

## Local setup

```bash
npm install
npm start
```

Open the app at `http://localhost:3000`.

## Deploy on Render

This repo already includes `render.yaml` for a simple Render web service.

Deployment settings:

- Build command: `npm ci`
- Start command: `npm start`
- Health check path: `/`

## Project structure

- `server.js` - Node HTTP server and API adapter
- `index.html` - Frontend UI
- `render.yaml` - Render deployment config
- `.gitignore` - Ignores `node_modules/`
