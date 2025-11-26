const express = require("express");
const { spawn } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");

// -------------------- FORMATS CACHE (speed-up) --------------------
// Cache formats per-URL for a short time so repeated pastes load instantly.
const formatCache = new Map();
function getCachedFormats(url) {
    const c = formatCache.get(url);
    if (!c) return null;
    if (Date.now() > c.expires) {
        formatCache.delete(url);
        return null;
    }
    return c.data;
}
function setCachedFormats(url, data) {
    formatCache.set(url, {
        expires: Date.now() + 10 * 60 * 1000, // 10 minutes
        data
    });
}

const { app: electronApp, shell } = require("electron");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

/* -------------------- BINARIES -------------------- */

function getBinaries() {
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
    let tempBase;

    if (process.platform === "win32") {
        tempBase = path.join(os.tmpdir(), "yt-downloader-temp");
    } else {
        tempBase = path.join(
            os.homedir(),
            "Library",
            "Caches",
            "yt-downloader-temp"
        );
    }

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

// Standard tiers so UI shows normal values (720/1080/etc)
const TIERS = [144, 240, 360, 480, 720, 1080, 1440, 2160, 4320];
function normalizeHeight(h) {
    if (!h || h < 100) return 0;
    let best = TIERS[0];
    let bestDiff = Math.abs(h - best);
    for (const t of TIERS) {
        const diff = Math.abs(h - t);
        if (diff < bestDiff) {
            best = t;
            bestDiff = diff;
        }
    }
    return best;
}

/**
 * Estimate filesize if yt-dlp didn't provide it.
 * size ≈ (tbr kbps * duration sec) / 8  -> bytes
 */
function estimateBytesFromBitrateAndDuration(format, durationSec) {
    const tbr = safeNum(format.tbr);
    if (!tbr || !durationSec) return 0;
    return (tbr * 1000 * durationSec) / 8;
}

/**
 * Kill yt-dlp AND any children (ffmpeg).
 * - Windows: taskkill /T kills process tree
 * - mac/linux: kill process group using negative PID
 */
function killProcessTree(proc) {
    if (!proc || proc.killed) return;
    const pid = proc.pid;
    if (!pid) return;

    if (process.platform === "win32") {
        try {
            spawn("taskkill", ["/PID", String(pid), "/T", "/F"]);
        } catch {
            try { proc.kill(); } catch {}
        }
    } else {
        try {
            process.kill(-pid, "SIGTERM");
        } catch {
            try { proc.kill("SIGTERM"); } catch {}
        }

        setTimeout(() => {
            try { process.kill(-pid, "SIGKILL"); } catch {}
        }, 1000);
    }
}

/** Create per-job hidden temp download folder */
function makeJobTempDir(jobId) {
    const base =
        process.platform === "win32"
            ? path.join(os.tmpdir(), "local-video-downloader")
            : path.join(os.homedir(), "Library", "Caches", "local-video-downloader");

    fs.mkdirSync(base, { recursive: true });

    const dir = path.join(base, `job-${jobId}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/** Delete temp dir safely */
function cleanupTempDir(dir) {
    if (!dir) return;
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
}

/** Move finished files from hidden temp -> Downloads */
function moveFinishedToDownloads(tempDir, downloadsDir) {
    if (!fs.existsSync(tempDir)) return [];

    const files = fs.readdirSync(tempDir);

    const finished = files.filter(f =>
        !f.endsWith(".part") &&
        !f.endsWith(".ytdl") &&
        !f.endsWith(".tmp") &&
        !f.endsWith(".webm.part") &&
        !f.endsWith(".mp4.part")
    );

    const moved = [];
    for (const file of finished) {
        const src = path.join(tempDir, file);
        const dest = path.join(downloadsDir, file);

        try {
            fs.renameSync(src, dest);
            moved.push(dest);
        } catch {
            try {
                fs.copyFileSync(src, dest);
                fs.unlinkSync(src);
                moved.push(dest);
            } catch {}
        }
    }

    return moved;
}

/* -------------------- FORMATS -------------------- */

app.post("/api/formats", (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ ok: false, error: "Missing url" });

    // ✅ return cached formats instantly if available
    const cached = getCachedFormats(url);
    if (cached) return res.json(cached);

    const { ytdlp, ffmpeg } = getBinaries();
    if (!binariesExist(res, ytdlp, ffmpeg)) return;

    // Faster than -J: single JSON line + no download
    const proc = spawn(ytdlp, ["-j", "--skip-download", "--no-playlist", url], { env: getTempEnv() });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", d => stdout += d.toString());
    proc.stderr.on("data", d => stderr += d.toString());

    proc.on("close", code => {
        if (code !== 0) {
            return res.json({ ok: false, error: stderr || stdout });
        }

        let info;
        try {
            info = JSON.parse(stdout.trim());
        } catch {
            // Try to recover JSON if yt-dlp pollutes stdout
            const start = stdout.indexOf("{");
            const end = stdout.lastIndexOf("}");
            if (start !== -1 && end !== -1 && end > start) {
                try {
                    info = JSON.parse(stdout.slice(start, end + 1));
                } catch {
                    return res.json({ ok: false, error: "Could not parse yt-dlp JSON output." });
                }
            } else {
                return res.json({ ok: false, error: "Could not parse yt-dlp JSON output." });
            }
        }

        const durationSec = safeNum(info.duration) || 0;
        const formats = Array.isArray(info.formats) ? info.formats : [];

        const rawVideo = [];
        const audio = [];

        for (const f of formats) {
            const id = f.format_id;
            if (!id) continue;

            const ext = (f.ext || "").toUpperCase();
            const isAudioOnly = f.vcodec === "none";
            const hasVideo = f.vcodec && f.vcodec !== "none";
            const hasAudio = f.acodec && f.acodec !== "none";

            let filesizeBytes = f.filesize || f.filesize_approx || 0;
            if (!filesizeBytes) {
                filesizeBytes = estimateBytesFromBitrateAndDuration(f, durationSec);
            }
            const sizeMiB = toMiB(filesizeBytes);

            if (isAudioOnly) {
                const abr = safeNum(f.abr) ? `${Math.round(f.abr)} kbps` : "audio";
                audio.push({
                    id,
                    label: `${ext} Audio (${abr})${sizeMiB ? ` • ${sizeMiB} MiB` : ""}`
                });
                continue;
            }

            if (hasVideo) {
                const heightRaw = safeNum(f.height) || 0;
                const heightStd = normalizeHeight(heightRaw);
                const fps = safeNum(f.fps) || 0;

                rawVideo.push({
                    id,
                    ext,
                    hasAudio,
                    heightStd,
                    fps,
                    filesizeBytes,
                    sizeMiB
                });
            }
        }

        // Pick best format per tier
        const byTier = new Map();
        for (const v of rawVideo) {
            if (!v.heightStd) continue;

            const existing = byTier.get(v.heightStd);
            if (!existing) {
                byTier.set(v.heightStd, v);
                continue;
            }

            const score = (x) => {
                let s = 0;
                if (x.ext === "MP4") s += 1000;
                if (x.hasAudio) s += 100;
                if (x.filesizeBytes) s += Math.min(x.filesizeBytes / (1024 * 1024), 500);
                s += x.fps / 10;
                return s;
            };

            if (score(v) > score(existing)) {
                byTier.set(v.heightStd, v);
            }
        }

        const video = Array.from(byTier.values())
            .sort((a, b) => b.heightStd - a.heightStd)
            .map(v => ({
                id: v.id,
                hasAudio: v.hasAudio,
                height: v.heightStd,
                fps: v.fps,
                label: `${v.heightStd}p ${v.ext}${v.sizeMiB ? ` • ${v.sizeMiB} MiB` : ""}`
            }));

        audio.sort((a, b) => b.label.localeCompare(a.label));

        const payload = { ok: true, video, audio };
        setCachedFormats(url, payload);
        res.json(payload);
    });
});

/* -------------------- PROGRESS JOBS -------------------- */

const jobs = Object.create(null);

function newJob() {
    const id = crypto.randomBytes(8).toString("hex");
    jobs[id] = {
        status: "running",
        progress: { percent: 0, speed: "", eta: "" },
        listeners: new Set(),
        proc: null,
        cancelled: false,
        tempDir: null
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

/* -------------------- REVEAL IN FOLDER -------------------- */

app.post("/api/reveal", (req, res) => {
    const { filePath } = req.body;
    if (!filePath) {
        return res.status(400).json({ ok: false, error: "Missing filePath" });
    }

    try {
        const folder = path.dirname(filePath);

        if (process.platform === "win32") {
            // ✅ Explorer: open and select + bring to front reliably
            spawn("explorer.exe", ["/select,", filePath]);
            return res.json({ ok: true });
        }

        if (process.platform === "darwin") {
            // ✅ Finder: open folder first so it comes to front
            shell.openPath(folder).then(() => {
                // then highlight (small delay helps Finder focus)
                setTimeout(() => {
                    shell.showItemInFolder(filePath);
                }, 250);
            });

            return res.json({ ok: true });
        }

        // ✅ Linux fallback: open folder, then try highlight
        shell.openPath(folder).then(() => {
            setTimeout(() => shell.showItemInFolder(filePath), 250);
        });

        return res.json({ ok: true });

    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});


/* -------------------- CANCEL DOWNLOAD -------------------- */

app.post("/api/cancel/:jobId", (req, res) => {
    const { jobId } = req.params;
    const job = jobs[jobId];

    if (!job) {
        return res.status(404).json({ ok: false, error: "Job not found" });
    }
    if (job.status !== "running" || !job.proc) {
        return res.json({ ok: false, error: "Job is not running" });
    }

    job.cancelled = true;

    killProcessTree(job.proc);

    job.status = "cancelled";
    push(jobId, { type: "cancelled" });
    closeListeners(jobId);

    cleanupTempDir(job.tempDir);

    res.json({ ok: true });
});

/* -------------------- DOWNLOAD (ASYNC + PROGRESS) -------------------- */

app.post("/api/download", (req, res) => {
    const { url, format, type, hasAudio } = req.body;
    if (!url) return res.status(400).json({ ok: false, error: "Missing url" });

    const downloadsDir = path.join(os.homedir(), "Downloads");
    const { ytdlp, ffmpeg } = getBinaries();
    if (!binariesExist(res, ytdlp, ffmpeg)) return;

    const jobId = newJob();
    res.json({ ok: true, jobId });

    const job = jobs[jobId];
    job.tempDir = makeJobTempDir(jobId);

    const args = [
        url,
        "-P", job.tempDir,
        "--ffmpeg-location", ffmpeg,
        "--no-playlist",
        "--newline",

        // always unique filename per run
        "-o", "%(title)s-%(id)s-%(epoch)s.%(ext)s"
    ];

    if (type === "mp3") {
        args.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
    } else if (format) {
        if (hasAudio) {
            args.push("-f", format);
        } else {
            args.push("-f", `${format}+bestaudio/best`);
            args.push("--merge-output-format", "mp4");
        }
    }

    const proc = spawn(ytdlp, args, {
        env: getTempEnv(),
        detached: process.platform !== "win32"
    });

    job.proc = proc;

    proc.stdout.on("data", d => {
        for (const line of d.toString().split("\n").filter(Boolean)) {
            const p = parseProgress(line);
            if (p) {
                job.progress = p;
                push(jobId, { type: "progress", ...p });
            }
        }
    });

    proc.stderr.on("data", d => {
        const line = d.toString();
        push(jobId, { type: "errorLine", line });
    });

    proc.on("close", code => {
        if (job.cancelled) return;

        if (code === 0) {
            const movedFiles = moveFinishedToDownloads(job.tempDir, downloadsDir);
            cleanupTempDir(job.tempDir);

            job.status = "done";
            push(jobId, {
                type: "done",
                filePath: movedFiles[0] || null
            });
        } else {
            cleanupTempDir(job.tempDir);

            job.status = "error";
            push(jobId, { type: "error", message: "Download failed." });
        }
        closeListeners(jobId);
    });
});

/* -------------------- LISTEN -------------------- */

app.listen(8787, "127.0.0.1", () => {
    // console.log("Server running at http://127.0.0.1:8787");
});
