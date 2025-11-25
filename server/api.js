const express = require("express");
const { spawn } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const { app: electronApp } = require("electron");


const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

/* -------------------- BINARIES -------------------- */

function getBinaries() {
  // In dev, __dirname is server/. In packaged, resources are in process.resourcesPath
  const base = electronApp.isPackaged
      ? process.resourcesPath
      : path.join(__dirname, "..");

  if (process.platform === "win32") {
    return {
      ytdlp: path.join(base, "bin", "win", "yt-dlp.exe"),
      ffmpeg: path.join(base, "bin", "win", "ffmpeg.exe"),
    };
  }

  const ytdlp = path.join(base, "bin", "mac", "yt-dlp_macos");
  const ffmpeg = path.join(base, "bin", "mac", "ffmpeg_macos");

  if (fs.existsSync(ytdlp)) fs.chmodSync(ytdlp, 0o755);
  if (fs.existsSync(ffmpeg)) fs.chmodSync(ffmpeg, 0o755);

  return { ytdlp, ffmpeg };
}


function binariesExist(res, ytdlp, ffmpeg) {
  if (!fs.existsSync(ytdlp)) {
    res.status(500).json({
      ok: false,
      error: "yt-dlp binary missing in bin/mac or bin/win."
    });
    return false;
  }
  if (!fs.existsSync(ffmpeg)) {
    res.status(500).json({
      ok: false,
      error: "ffmpeg binary missing in bin/mac or bin/win."
    });
    return false;
  }
  return true;
}

/* -------------------- PYINSTALLER TEMP FIX -------------------- */
function getTempEnv() {
  const tempBase = path.join(
      os.homedir(),
      "Library",
      "Caches",
      "yt-downloader-temp"
  );
  fs.mkdirSync(tempBase, { recursive: true });

  return {
    ...process.env,
    TMPDIR: tempBase,
    TEMP: tempBase,
    TMP: tempBase,
  };
}

/* -------------------- HELPERS -------------------- */
function toMiB(bytes) {
  if (!bytes || bytes <= 0) return null;
  return (bytes / (1024 * 1024)).toFixed(1);
}
function safeNum(n) {
  return typeof n === "number" && !Number.isNaN(n) ? n : null;
}

/* -------------------- FORMATS -------------------- */
app.post("/api/formats", (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ ok: false, error: "Missing url" });

  const { ytdlp, ffmpeg } = getBinaries();
  if (!binariesExist(res, ytdlp, ffmpeg)) return;

  const proc = spawn(ytdlp, ["-J", "--no-playlist", url], { env: getTempEnv() });

  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", d => stdout += d.toString());
  proc.stderr.on("data", d => stderr += d.toString());

  proc.on("close", code => {
    if (code !== 0) return res.json({ ok: false, error: stderr || stdout });

    let info;
    try { info = JSON.parse(stdout); }
    catch { return res.json({ ok: false, error: "Could not parse yt-dlp JSON output." }); }

    const formats = Array.isArray(info.formats) ? info.formats : [];
    const video = [];
    const audio = [];

    for (const f of formats) {
      const id = f.format_id;
      if (!id) continue;

      const ext = (f.ext || "").toUpperCase();
      const isAudioOnly = f.vcodec === "none";
      const hasVideo = f.vcodec && f.vcodec !== "none";
      const filesize = f.filesize || f.filesize_approx || null;
      const sizeMiB = toMiB(filesize);

      if (isAudioOnly) {
        const abr = safeNum(f.abr) ? `${Math.round(f.abr)} kbps` : "audio";
        audio.push({
          id,
          label: `${ext} Audio (${abr})${sizeMiB ? ` • ${sizeMiB} MiB` : ""}`
        });
      } else if (hasVideo) {
        const height = safeNum(f.height);
        const fps = safeNum(f.fps);
        const resLabel = height ? `${height}p` : "video";
        const fpsLabel = fps ? `${fps}fps` : "";
        video.push({
          id,
          label: `${resLabel} ${ext}${fpsLabel ? ` (${fpsLabel})` : ""}${sizeMiB ? ` • ${sizeMiB} MiB` : ""}`,
          height: height || 0,
          fps: fps || 0
        });
      }
    }

    video.sort((a,b)=> (b.height-a.height) || (b.fps-a.fps));
    audio.sort((a,b)=> b.label.localeCompare(a.label));

    res.json({ ok: true, video, audio });
  });
});

/* -------------------- PROGRESS JOBS -------------------- */
const jobs = Object.create(null);

function newJob() {
  const id = crypto.randomBytes(8).toString("hex");
  jobs[id] = {
    status: "running",
    log: [],
    progress: { percent: 0, speed: "", eta: "" },
    listeners: new Set()
  };
  return id;
}

function push(jobId, event) {
  const job = jobs[jobId];
  if (!job) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of job.listeners) res.write(payload);
}

function closeListeners(jobId) {
  const job = jobs[jobId];
  if (!job) return;
  for (const res of job.listeners) res.end();
  job.listeners.clear();
}

function parseProgress(line) {
  const m = line.match(/\[download\]\s+(\d{1,3}\.?\d*)%.*?at\s+([^\s]+).*?ETA\s+([0-9:]+)/i);
  if (!m) return null;
  return { percent: Number(m[1]), speed: m[2], eta: m[3] };
}

/* -------------------- SSE PROGRESS -------------------- */
app.get("/api/progress/:jobId", (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).end();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  job.listeners.add(res);
  push(req.params.jobId, { type: "progress", ...job.progress });

  req.on("close", () => job.listeners.delete(res));
});

/* -------------------- DOWNLOAD (ASYNC + PROGRESS) -------------------- */
app.post("/api/download", (req, res) => {
  const { url, format, type } = req.body;
  if (!url) return res.status(400).json({ ok: false, error: "Missing url" });

  const outputDir = path.join(os.homedir(), "Downloads");
  const { ytdlp, ffmpeg } = getBinaries();
  if (!binariesExist(res, ytdlp, ffmpeg)) return;

  const jobId = newJob();
  res.json({ ok: true, jobId });

  const args = [
    url,
    "-P", outputDir,
    "--ffmpeg-location", ffmpeg,
    "--no-playlist",
    "--newline",
    "-o", "%(title)s.%(ext)s"
  ];

  if (type === "mp3") args.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
  else if (format) args.push("-f", format);

  const proc = spawn(ytdlp, args, { env: getTempEnv() });
  const job = jobs[jobId];

  proc.stdout.on("data", d => {
    for (const line of d.toString().split("\n").filter(Boolean)) {
      job.log.push(line);
      const p = parseProgress(line);
      if (p) {
        job.progress = p;
        push(jobId, { type: "progress", ...p });
      } else {
        push(jobId, { type: "log", line });
      }
    }
  });

  proc.stderr.on("data", d => {
    const line = d.toString();
    job.log.push(line);
    push(jobId, { type: "log", line });
  });

  proc.on("close", code => {
    if (code === 0) {
      job.status = "done";
      push(jobId, { type: "done" });
    } else {
      job.status = "error";
      push(jobId, { type: "error", message: "Download failed." });
    }
    closeListeners(jobId);
  });
});

/* -------------------- LISTEN -------------------- */
app.listen(8787, "127.0.0.1", () => {
  console.log("Server running at http://127.0.0.1:8787");
});
