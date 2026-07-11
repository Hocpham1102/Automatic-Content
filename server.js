/**
 * TikSave – Local Proxy Server
 * Chạy: node server.js
 * Mở trình duyệt: http://localhost:3000
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const url = require("url");
const { spawn } = require("child_process");
const { igdl, ttdl, fbdown, douyin, threads } = require("btch-downloader");

// Ưu tiên file yt-dlp local (được cài bởi build script trên Render),
// nếu không có thì dùng yt-dlp từ system PATH
const YTDLP_BIN = fs.existsSync(path.join(__dirname, "yt-dlp"))
  ? path.join(__dirname, "yt-dlp")
  : "yt-dlp";

// Render và các server không có Chrome → bỏ qua --cookies-from-browser
const IS_SERVER_ENV = !!(process.env.RENDER || process.env.IS_SERVER);

let snapsaveLoader;

async function getSnapsave() {
  if (!snapsaveLoader) {
    snapsaveLoader = import("snapsave-media-downloader").then(
      (mod) => mod.snapsave,
    );
  }

  return snapsaveLoader;
}

const PORT = process.env.PORT || 3000;
const HTML_FILE = path.join(__dirname, "index.html");

// ── MIME types ──────────────────────────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "application/javascript",
  ".ico": "image/x-icon",
};

// ── Fetch helper (wraps https.get với redirect support) ──────
function httpsGet(targetUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const referer = options.headers?.Referer || options.headers?.referer;
    const reqOptions = {
      ...options,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Referer: referer || "https://www.tiktok.com/",
        ...(options.headers || {}),
      },
    };

    const makeRequest = (u) => {
      const mod = u.startsWith("https") ? https : http;
      mod
        .get(u, reqOptions, (res) => {
          // Follow redirects
          if (
            [301, 302, 303, 307, 308].includes(res.statusCode) &&
            res.headers.location
          ) {
            return makeRequest(res.headers.location);
          }
          resolve(res);
        })
        .on("error", reject);
    };

    makeRequest(targetUrl);
  });
}

// ── Parse JSON from https ────────────────────────────────────
function fetchJson(targetUrl, referer) {
  return new Promise((resolve, reject) => {
    httpsGet(targetUrl, referer ? { headers: { Referer: referer } } : {})
      .then((res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      })
      .catch(reject);
  });
}

// ── Send JSON response ───────────────────────────────────────
function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getPlatform(urlString = "") {
  try {
    const host = new URL(urlString).hostname.toLowerCase();
    if (host.includes("instagram.com")) return "instagram";
    if (host.includes("facebook.com") || host.includes("fb.watch"))
      return "facebook";
    if (host.includes("threads.net") || host.includes("threads.com"))
      return "threads";
    if (host.includes("douyin") || host.includes("iesdouyin")) return "douyin";
    if (
      host.includes("tiktok.com") ||
      host.includes("vm.tiktok") ||
      host.includes("vt.tiktok")
    ) {
      return "tiktok";
    }
  } catch {
    // Fall back to auto detection below.
  }

  return "unknown";
}

function getRefererForUrl(targetUrl = "") {
  try {
    const host = new URL(targetUrl).hostname.toLowerCase();
    if (host.includes("douyin")) return "https://www.douyin.com/";
    if (host.includes("instagram")) return "https://www.instagram.com/";
    if (host.includes("facebook") || host.includes("fb.watch"))
      return "https://www.facebook.com/";
    if (host.includes("threads.com")) return "https://www.threads.com/";
    if (host.includes("threads")) return "https://www.threads.net/";
    if (host.includes("tiktok")) return "https://www.tiktok.com/";
  } catch {
    // Fallback below.
  }

  return "https://www.tiktok.com/";
}

// ── Threads Media Extractor ────────────────────────────────
async function extractThreadsMedia(threadUrl) {
  // Use btch-downloader which works reliably for single items
  // Note: Carousel posts will return only the first item (btch-downloader limitation)
  return await threads(threadUrl);
}

async function downloadUpstream(
  videoUrl,
  maxAttempts = 3,
  refererOverride = "",
) {
  let lastError;
  const referer = refererOverride || getRefererForUrl(videoUrl);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const upstream = await httpsGet(videoUrl, {
        headers: {
          "Cache-Control": "no-cache",
          Referer: referer,
        },
      });

      if (upstream.statusCode && upstream.statusCode >= 400) {
        upstream.resume();
        throw new Error(`UPSTREAM_HTTP_${upstream.statusCode}`);
      }

      return upstream;
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        await sleep(400 * attempt);
      }
    }
  }

  throw lastError || new Error("UPSTREAM_DOWNLOAD_FAILED");
}

// ── Main server ──────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const query = parsed.query;

  // -- OPTIONS preflight --
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*" });
    res.end();
    return;
  }

  // ── GET / → serve index.html ─────────────────────────────
  if (pathname === "/" || pathname === "/index.html") {
    try {
      const html = fs.readFileSync(HTML_FILE, "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
    return;
  }

  // ── GET /api/info?url=<tiktok_url> ───────────────────────
  if (pathname === "/api/info") {
    const mediaUrl = query.url;
    if (!mediaUrl) return sendJson(res, { error: "Missing url param" }, 400);

    try {
      const platform = getPlatform(mediaUrl);
      let data;
      const maxAttempts = 3;
      let lastError;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          if (
            platform === "instagram" ||
            platform === "facebook" ||
            platform === "tiktok"
          ) {
            const snapsave = await getSnapsave();
            const raw = await snapsave(mediaUrl);

            if (raw && raw.success && raw.data) {
              data = {
                platform,
                developer: raw.developer || "snapsave-media-downloader",
                status: true,
                title: raw.data.description || raw.data.title || "",
                thumbnail: raw.data.preview || "",
                media: Array.isArray(raw.data.media) ? raw.data.media : [],
              };
            } else {
              data = {
                platform,
                developer: raw?.developer || "snapsave-media-downloader",
                status: false,
                message: raw?.message || "No results found",
                media: [],
              };
            }
          } else if (platform === "threads") {
            data = await extractThreadsMedia(mediaUrl);
          } else if (platform === "douyin") {
            data = await douyin(mediaUrl);
          } else {
            data = await ttdl(mediaUrl);
          }

          // Kiểm tra xem dữ liệu cào được có thành công hay không
          let isSuccess = data && data.status !== false && !data.error;
          if (isSuccess && platform === "douyin") {
            const result = data.result;
            if (!result || result.status === false) {
              isSuccess = false;
            } else {
              const links = result.data?.links;
              if (!Array.isArray(links) || links.length === 0) {
                isSuccess = false;
              }
            }
          }
          if (isSuccess && platform === "threads") {
            const result = data.result;
            if (!result || result.status === 500 || result.type === "error") {
              isSuccess = false;
            }
          }

          if (isSuccess) {
            break;
          }
        } catch (err) {
          lastError = err;
        }

        if (attempt < maxAttempts) {
          await sleep(600 * attempt);
        }
      }

      if (!data && lastError) {
        throw lastError;
      }

      sendJson(res, { platform, ...data });
    } catch (err) {
      sendJson(res, { error: err.message }, 500);
    }
    return;
  }

  // ── GET /api/download?url=<video_url>&filename=<name> ────
  if (pathname === "/api/download") {
    const videoUrl = query.url;
    const filename = query.filename || "tiktok_video.mp4";
    const referer = query.referer || "";

    if (!videoUrl) return sendJson(res, { error: "Missing url param" }, 400);

    try {
      const upstream = await downloadUpstream(videoUrl, 3, referer);

      const contentType = upstream.headers["content-type"] || "video/mp4";
      const contentLen = upstream.headers["content-length"];

      const headers = {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache",
      };
      if (contentLen) headers["Content-Length"] = contentLen;

      res.writeHead(200, headers);
      upstream.pipe(res);
      upstream.on("error", () => res.end());
    } catch (err) {
      sendJson(res, { error: err.message }, 500);
    }
    return;
  }

  // ── POST /api/profile/fetch – lấy danh sách video của profile ──
  if (pathname === "/api/profile/fetch" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { profileUrl, browser } = JSON.parse(body || "{}");
        if (!profileUrl) return sendJson(res, { error: "Missing profileUrl" }, 400);

        const videos = await ytdlpFetchPlaylist(profileUrl, browser);
        sendJson(res, { ok: true, count: videos.length, videos });
      } catch (err) {
        sendJson(res, { error: err.message }, 500);
      }
    });
    return;
  }

  // ── Static files ─────────────────────────────────────────
  const filePath = path.join(__dirname, pathname);
  const ext = path.extname(filePath);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

// ── Profile download helpers ────────────────────────────────

function ytdlpFetchPlaylist(profileUrl, browser) {
  return new Promise((resolve, reject) => {
    const args = [
      "--flat-playlist",
      "--dump-single-json",
      "--no-warnings",
    ];
    if (browser && !IS_SERVER_ENV) args.push("--cookies-from-browser", browser);
    args.push(profileUrl);

    let proc;
    try {
      proc = spawn(YTDLP_BIN, args);
    } catch (spawnErr) {
      return reject(new Error("yt-dlp không được cài hoặc không tìm thấy trong PATH: " + spawnErr.message));
    }

    let stdout = "";
    let stderr = "";

    // Timeout 90s để tránh các nền tảng serverless/hosting ngắt request
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error("yt-dlp timeout sau 90 giây. Thử lại hoặc hồ sơ quá lớn!"));
    }, 90000);

    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error("Không thể chạy yt-dlp: " + err.message));
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(stderr.slice(-500) || `yt-dlp exited ${code}`));
      }
      try {
        const data = JSON.parse(stdout);
        const entries = data.entries || [];
        const videos = entries.map((e) => {
          let videoUrl = e.url || e.webpage_url || "";
          if (!videoUrl) {
            // Fallback: xây URL từ platform gốc
            const isDouyin = profileUrl.includes("douyin");
            videoUrl = isDouyin
              ? `https://www.douyin.com/video/${e.id}`
              : `https://www.tiktok.com/@${data.uploader_id}/video/${e.id}`;
          }
          return {
            id: e.id,
            title: e.title || e.id,
            url: videoUrl,
            thumbnail: e.thumbnail || "",
            duration: e.duration || 0,
            upload_date: e.upload_date || "",
          };
        });
        resolve(videos);
      } catch (err) {
        reject(new Error("Failed to parse yt-dlp output: " + err.message));
      }
    });
  });
}


server.listen(PORT, () => {
  console.log(`\n✅  TikSave server đang chạy tại: http://localhost:${PORT}\n`);
  console.log(`   Mở trình duyệt và truy cập: http://localhost:${PORT}`);
  console.log(`   Nhấn Ctrl+C để dừng server.\n`);
});
