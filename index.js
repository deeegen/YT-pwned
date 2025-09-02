"use strict";

const express = require("express");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const ytsr = require("ytsr");
const https = require("https");
const { pipeline } = require("stream");
const { promisify } = require("util");
const pipelineAsync = promisify(pipeline);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

const VIDEO_DIR = path.join(__dirname, "videos");
const VIEW_DIR = path.join(__dirname, "views");
if (!fs.existsSync(VIDEO_DIR)) fs.mkdirSync(VIDEO_DIR, { recursive: true });

app.set("view engine", "ejs");
app.set("views", VIEW_DIR);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Basic hardening
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

app.use("/videos", express.static(VIDEO_DIR));

// ---------- Configuration for yt-dlp handling ----------
const LOCAL_YTDLP_NAME = path.join(__dirname, "yt-dlp"); // where we'll keep a local copy
let YTDLP_BIN = "yt-dlp"; // default command name; we'll override if needed

/**
 * Try to run a command to check availability (simple --version check)
 * resolves true if command runs and exits with code 0
 */
function checkCommandWorks(command, args = ["--version"], env = process.env) {
  return new Promise((resolve) => {
    try {
      const proc = spawn(command, args, {
        stdio: ["ignore", "ignore", "ignore"],
        env,
      });
      proc.on("error", () => resolve(false));
      proc.on("close", (code) => resolve(code === 0));
    } catch {
      return resolve(false);
    }
  });
}

/**
 * Download yt-dlp binary to dest (streamed).
 * Returns when complete and executable bit is set.
 */
async function downloadYtDlpTo(dest) {
  const url =
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";

  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent": "node/yt-dlp-downloader",
          Accept: "application/octet-stream",
        },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // Follow redirect
          https.get(res.headers.location, (r2) => {
            if (r2.statusCode !== 200) {
              return reject(
                new Error(`Unexpected status ${r2.statusCode} while fetching yt-dlp`)
              );
            }
            pipelineAsync(r2, fs.createWriteStream(dest))
              .then(() => {
                fs.chmodSync(dest, 0o755);
                resolve();
              })
              .catch(reject);
          }).on("error", reject);
          return;
        }

        if (res.statusCode !== 200) {
          return reject(new Error(`Unexpected status ${res.statusCode} while fetching yt-dlp`));
        }

        pipelineAsync(res, fs.createWriteStream(dest))
          .then(() => {
            try {
              fs.chmodSync(dest, 0o755);
            } catch (err) {
              // chmod failed — log but continue
              console.warn("Could not chmod yt-dlp:", err);
            }
            resolve();
          })
          .catch(reject);
      }
    );

    req.on("error", reject);
  });
}

/**
 * Ensure we have a usable yt-dlp binary.
 * Strategy:
 * 1. If `yt-dlp --version` works (global), use that.
 * 2. Else if local ./yt-dlp exists and is executable, use that.
 * 3. Else attempt to download ./yt-dlp and chmod it, then use it.
 * 4. If download fails, fall back to calling 'yt-dlp' (will error later).
 */
async function ensureYtDlpAvailable() {
  // Make sure our app dir is in PATH for child processes so 'yt-dlp' will be found if placed here.
  process.env.PATH = `${__dirname}${path.delimiter}${process.env.PATH}`;

  // 1) Global yt-dlp?
  const globalOk = await checkCommandWorks("yt-dlp");
  if (globalOk) {
    YTDLP_BIN = "yt-dlp";
    console.log("Using global yt-dlp available in PATH.");
    return;
  }

  // 2) Local binary exists?
  try {
    if (fs.existsSync(LOCAL_YTDLP_NAME)) {
      // ensure executable
      try {
        fs.chmodSync(LOCAL_YTDLP_NAME, 0o755);
      } catch (err) {
        // ignore chmod errors but warn
        console.warn("Warning: could not chmod local yt-dlp:", err.message || err);
      }

      // test local
      const localOk = await checkCommandWorks(LOCAL_YTDLP_NAME, ["--version"], {
        ...process.env,
        PATH: `${__dirname}${path.delimiter}${process.env.PATH}`,
      });
      if (localOk) {
        YTDLP_BIN = LOCAL_YTDLP_NAME;
        console.log("Using existing local yt-dlp at", LOCAL_YTDLP_NAME);
        return;
      } else {
        console.log("Local yt-dlp exists but failed to run; will attempt re-download.");
      }
    }
  } catch (err) {
    console.warn("Checking local yt-dlp failed:", err);
  }

  // 3) Download a local copy
  console.log("Downloading yt-dlp to local directory...");
  try {
    await downloadYtDlpTo(LOCAL_YTDLP_NAME);
    // Test it
    const ok = await checkCommandWorks(LOCAL_YTDLP_NAME, ["--version"], {
      ...process.env,
      PATH: `${__dirname}${path.delimiter}${process.env.PATH}`,
    });
    if (ok) {
      YTDLP_BIN = LOCAL_YTDLP_NAME;
      console.log("Successfully downloaded yt-dlp to", LOCAL_YTDLP_NAME);
      return;
    } else {
      console.warn("Downloaded yt-dlp but it failed to run.");
    }
  } catch (err) {
    console.warn("Failed to download yt-dlp:", err.message || err);
  }

  // 4) Fallback
  YTDLP_BIN = "yt-dlp";
  console.warn(
    "yt-dlp is not available. Attempts to use a local binary failed — commands that call yt-dlp will likely error."
  );
}

// ---------- Simple LRU cache with TTL ----------
class LRUCache {
  constructor(max = 200, ttl = 2 * 60 * 1000) {
    this.max = max;
    this.ttl = ttl;
    this.map = new Map();
  }

  _isExpired(entry) {
    return !entry || Date.now() > entry.expire;
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry || this._isExpired(entry)) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    const expire = Date.now() + this.ttl;
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expire });
    while (this.map.size > this.max) {
      const first = this.map.keys().next().value;
      this.map.delete(first);
    }
  }

  delete(key) {
    this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }
}

const ytCache = new LRUCache(400, 2 * 60 * 1000);

// ---------- yt-dlp worker queue ----------
const MAX_CONCURRENT_YTDLP = 2;
let ytActive = 0;
const ytQueue = [];

function enqueueYtTask(fn) {
  return new Promise((resolve, reject) => {
    ytQueue.push({ fn, resolve, reject });
    processYtQueue();
  });
}

async function processYtQueue() {
  if (ytActive >= MAX_CONCURRENT_YTDLP) return;
  const item = ytQueue.shift();
  if (!item) return;
  ytActive++;
  try {
    const result = await item.fn();
    item.resolve(result);
  } catch (err) {
    item.reject(err);
  } finally {
    ytActive--;
    setImmediate(processYtQueue);
  }
}

// ---------- Helper to run yt-dlp ----------
/**
 * runYtDlp(args, { cwd }):
 * - uses configured YTDLP_BIN
 * - ensures child inherits PATH that contains __dirname so local binary will be found by name
 */
function runYtDlp(args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      PATH: `${__dirname}${path.delimiter}${process.env.PATH}`,
    };

    const proc = spawn(YTDLP_BIN, args, {
      cwd: cwd || process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) => {
      // More informative error if binary not found or permission denied
      reject(
        new Error(
          `Failed to spawn yt-dlp (${YTDLP_BIN}): ${err.message}. ` +
            `Ensure yt-dlp is present in PATH or available at ${LOCAL_YTDLP_NAME}.`
        )
      );
    });
    proc.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          new Error(
            `yt-dlp exited with code ${code}\n${stderr || "No stderr output"}`
          )
        );
    });
  });
}

// ---------- Local library helpers ----------
const YT_VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

function listLocalVideosWithMeta() {
  const files = fs.readdirSync(VIDEO_DIR);
  const videoFiles = files.filter((f) => f.toLowerCase().endsWith(".mp4"));
  return videoFiles.map((file) => {
    const full = path.join(VIDEO_DIR, file);
    const infoPath = full + ".info.json";
    const thumbPath = full + ".jpg";
    let meta = null;
    try {
      if (fs.existsSync(infoPath))
        meta = JSON.parse(fs.readFileSync(infoPath, "utf8"));
    } catch {}
    const hasThumb = fs.existsSync(thumbPath);
    return {
      file,
      size: fs.statSync(full).size,
      title: meta?.title || file,
      uploader: meta?.uploader || null,
      duration: meta?.duration || null,
      id: meta?.id || file.replace(/\.mp4$/i, ""),
      thumbLocal: hasThumb ? `/videos/${file}.jpg` : null,
      thumbRemote: meta?.thumbnail || null,
    };
  });
}

function searchLocal(term) {
  const q = (term || "").trim().toLowerCase();
  if (!q) return [];
  return listLocalVideosWithMeta().filter((v) => {
    const hay = [v.title, v.uploader, v.id, v.file]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
}

// ---------- Utility: parse duration strings like "4:25" or "1:02:34" -> seconds ----------
function parseDurationString(ds) {
  if (!ds) return null;
  const s = String(ds).trim();
  if (!s) return null;
  // treat live/stream as unknown
  if (/live/i.test(s)) return null;
  const parts = s.split(":").map((p) => parseInt(p.trim(), 10));
  if (parts.some((p) => Number.isNaN(p))) return null;
  // convert [hh, mm, ss] or [mm, ss] to seconds
  let seconds = 0;
  for (let i = 0; i < parts.length; i++) {
    seconds = seconds * 60 + parts[i];
  }
  return seconds;
}

// ---------- YouTube search helper (now using ytsr for search) ----------
async function searchYouTube(q, limit) {
  const norm = (q || "").trim();
  if (!norm) return [];
  if (norm.length < 2) return [];

  const key = `yt:${norm.toLowerCase()}:${limit}`;
  const cached = ytCache.get(key);
  if (cached) return cached;

  const task = async () => {
    try {
      // If the query is a raw video id, keep the existing yt-dlp metadata path
      if (YT_VIDEO_ID_RE.test(norm)) {
        const url = `https://www.youtube.com/watch?v=${norm}`;
        const { stdout } = await runYtDlp(["-j", "--skip-download", url]);
        const lines = stdout.split("\n").filter(Boolean);
        const items = lines
          .map((line) => {
            try {
              const j = JSON.parse(line);
              return {
                id: j.id,
                title: j.title,
                uploader: j.uploader || j.channel || "",
                duration: j.duration || null,
                duration_string: j.duration_string || null,
                thumbnail: j.thumbnail || null,
                url: j.webpage_url || `https://www.youtube.com/watch?v=${j.id}`,
              };
            } catch {
              return null;
            }
          })
          .filter(Boolean);
        return items.slice(0, 1);
      }

      // --- Use ytsr for text searches ---
      const fetchLimit = Math.max(limit * 2, 12);
      const searchResults = await ytsr(norm, { limit: fetchLimit });

      const items = (searchResults.items || [])
        .filter((it) => {
          return (
            it &&
            (it.type === "video" ||
              it.type === "Video" ||
              !!it.url?.includes("watch"))
          );
        })
        .slice(0, limit)
        .map((it) => {
          const id =
            it.id ||
            (it.url &&
              new URL(it.url, "https://www.youtube.com").searchParams.get(
                "v"
              )) ||
            null;
          const title = it.title || it.name || it.name || "";
          const uploader =
            (it.author && it.author.name) ||
            it.uploader ||
            (it.channel && it.channel.name) ||
            "";
          const duration_string =
            it.duration || it.duration_raw || it.rawDuration || null;
          const duration =
            parseDurationString(duration_string) ??
            (typeof it.duration === "number" ? it.duration : null);
          const thumbnail =
            (it.bestThumbnail && it.bestThumbnail.url) ||
            (it.thumbnails && it.thumbnails[0] && it.thumbnails[0].url) ||
            it.thumbnail ||
            null;
          const url =
            it.url || (id ? `https://www.youtube.com/watch?v=${id}` : null);

          return {
            id,
            title,
            uploader,
            duration,
            duration_string,
            thumbnail,
            url,
          };
        })
        .filter(Boolean);

      return items;
    } catch (err) {
      throw err;
    }
  };

  const results = await enqueueYtTask(task);
  ytCache.set(key, results);
  return results;
}

// ---------- Routes ----------
app.get("/", (req, res) => {
  res.render("index");
});

app.get("/api/ytsearch", async (req, res) => {
  const q = (req.query.q || "").trim();
  const limit = Math.min(parseInt(req.query.limit || "12", 10) || 12, 30);

  if (!q) return res.json({ results: [] });

  try {
    const results = await searchYouTube(q, limit);
    res.setHeader("Cache-Control", "public, max-age=30");
    return res.json({ results });
  } catch (err) {
    console.error("API ytsearch error:", err);
    return res.status(500).json({ error: "yt search failed" });
  }
});

app.get("/search", async (req, res) => {
  const q = (req.query.q || "").trim();
  const source = (req.query.source || "all").toLowerCase();
  const limit = Math.min(parseInt(req.query.limit || "12", 10) || 12, 30);

  if (!q) {
    return res.render("search", {
      q: "",
      source,
      limit,
      ytResults: [],
      localResults: [],
    });
  }

  const wantsYT = source === "all" || source === "youtube";
  const wantsLocal = source === "all" || source === "local";

  try {
    const promises = [];
    if (wantsYT) promises.push(searchYouTube(q, limit));
    else promises.push(Promise.resolve([]));
    if (wantsLocal) promises.push(Promise.resolve(searchLocal(q)));
    else promises.push(Promise.resolve([]));

    const [ytResults, localResults] = await Promise.all(promises);
    return res.render("search", { q, source, limit, ytResults, localResults });
  } catch (err) {
    console.error("Search error:", err);
    res.status(500).render("search", {
      q,
      source,
      limit,
      ytResults: [],
      localResults: [],
      error: "Search failed. Check server logs.",
    });
  }
});

app.post("/watch", async (req, res) => {
  const slug = (req.body.slug || "").trim();
  if (!YT_VIDEO_ID_RE.test(slug)) {
    return res.status(400).send("Invalid YouTube video ID.");
  }

  const url = `https://www.youtube.com/watch?v=${slug}`;
  const filename = `${slug}.mp4`;
  const filepath = path.join(VIDEO_DIR, filename);

  if (fs.existsSync(filepath)) {
    return res.redirect(`/viewer/${encodeURIComponent(filename)}`);
  }

  try {
    const args = [
      "-f",
      "mp4",
      "--no-playlist",
      "--write-info-json",
      "--write-thumbnail",
      "--convert-thumbnails",
      "jpg",
      "-o",
      filepath,
      url,
    ];
    await runYtDlp(args);
    return res.redirect(`/viewer/${encodeURIComponent(filename)}`);
  } catch (err) {
    console.error("Error running yt-dlp:", err);
    return res.status(500).send("Error downloading video.");
  }
});

app.get("/viewer/:file", (req, res) => {
  const file = req.params.file;
  const filepath = path.join(VIDEO_DIR, file);

  if (!fs.existsSync(filepath)) {
    return res.status(404).send("Video not found.");
  }

  const infoPath = filepath + ".info.json";
  const thumbLocal = fs.existsSync(filepath + ".jpg")
    ? `/videos/${file}.jpg`
    : null;
  let meta = null;
  try {
    if (fs.existsSync(infoPath))
      meta = JSON.parse(fs.readFileSync(infoPath, "utf8"));
  } catch {}
  const details = {
    title: meta?.title || file,
    uploader: meta?.uploader || null,
    id: meta?.id || file.replace(/\.mp4$/i, ""),
    duration: meta?.duration || null,
    thumb: thumbLocal || meta?.thumbnail || null,
  };

  res.render("viewer", { file, details });
});

app.post("/close", (req, res) => {
  const file = (req.body.file || "").trim();
  if (!file) return res.sendStatus(200);

  const filepath = path.join(VIDEO_DIR, file);
  const infoPath = filepath + ".info.json";
  const thumbPath = filepath + ".jpg";

  if (fs.existsSync(filepath)) {
    setTimeout(() => {
      fs.unlink(filepath, (err) => {
        if (err) console.error("Error deleting file:", err);
        else console.log(`Deleted video ${file}`);
      });
      [infoPath, thumbPath].forEach((p) => {
        if (fs.existsSync(p)) {
          fs.unlink(p, (err) => {
            if (err) console.error("Error deleting sidecar:", p, err);
          });
        }
      });
    }, 3 * 60 * 1000);
  }
  res.sendStatus(200);
});

app.get("/library", (req, res) => {
  const items = listLocalVideosWithMeta();
  res.render("search", {
    q: "",
    source: "local",
    limit: 100,
    ytResults: [],
    localResults: items,
  });
});

// ---------- Startup: ensure yt-dlp then listen ----------
(async () => {
  try {
    await ensureYtDlpAvailable();
  } catch (err) {
    console.warn("ensureYtDlpAvailable threw an error:", err);
  }

  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Using yt-dlp binary: ${YTDLP_BIN}`);
  });
})();
