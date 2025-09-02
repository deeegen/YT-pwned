const express = require("express");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const ytsr = require("ytsr");

const app = express();
const PORT = 3000;

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
function runYtDlp(args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn("yt-dlp", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`yt-dlp exited with code ${code}\n${stderr}`));
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
      // (yt-dlp gives the precise JSON metadata for a single video). This preserves
      // exact behavior for watch-by-id while using ytsr for normal text searches.
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
      // request a few more items from ytsr because the results may include non-video items
      const fetchLimit = Math.max(limit * 2, 12);
      const searchResults = await ytsr(norm, { limit: fetchLimit });

      const items = (searchResults.items || [])
        .filter((it) => {
          // ytsr returns heterogeneous items (video, playlist, channel, ad, etc.)
          // keep only items that look like videos.
          return (
            it &&
            (it.type === "video" ||
              it.type === "Video" ||
              !!it.url?.includes("watch"))
          );
        })
        .slice(0, limit)
        .map((it) => {
          // Normalize properties from various ytsr forks
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
          // try multiple thumbnail fields
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
      // Bubble error up to the API route which logs and returns 500
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
    console.error(err);
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

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
