const urlEl = document.getElementById("url");
const typeEl = document.getElementById("type");
const qualityEl = document.getElementById("quality");
const logEl = document.getElementById("log");
const downloadBtn = document.getElementById("downloadBtn");

// progress UI elements
const progressBar = document.getElementById("progressBar");
const progressText = document.getElementById("progressText");

let debounceTimer = null;
let lastUrlLoaded = "";

/* ------------------------ QUALITIES AUTO-LOAD ------------------------ */

function setLoadingQualities(isLoading) {
    qualityEl.disabled = true;
    qualityEl.innerHTML = `<option>${isLoading ? "Loading qualities…" : "Paste URL to load qualities…"}</option>`;
}

async function fetchQualities(url) {
    setLoadingQualities(true);
    logEl.textContent = "Fetching formats...\n";

    try {
        const res = await fetch("/api/formats", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url })
        });

        const data = await res.json();
        if (!data.ok) {
            logEl.textContent += (data.error || "Failed to load formats.") + "\n";
            setLoadingQualities(false);
            return;
        }

        const type = typeEl.value;
        const formats = type === "mp3" ? data.audio : data.video;

        qualityEl.innerHTML = "";

        for (const f of formats) {
            const opt = document.createElement("option");
            opt.value = f.id;
            opt.textContent = f.label;

            // ✅ IMPORTANT:
            // Only video formats include hasAudio from backend.
            // Store it so download() can decide whether to merge audio.
            if (type !== "mp3") {
                opt.dataset.hasAudio = f.hasAudio ? "1" : "0";
            }

            qualityEl.appendChild(opt);
        }

        if (formats.length === 0) {
            qualityEl.innerHTML = `<option>No formats found</option>`;
            qualityEl.disabled = true;
        } else {
            qualityEl.disabled = false;
        }

        logEl.textContent += "Formats loaded.\n";
    } catch (e) {
        logEl.textContent += "Failed to load formats.\n";
        setLoadingQualities(false);
    }
}

function maybeAutoLoad() {
    const url = urlEl.value.trim();
    if (!url || url === lastUrlLoaded) return;

    lastUrlLoaded = url;
    fetchQualities(url);
}

// Auto-load on paste/typing (debounced)
urlEl.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(maybeAutoLoad, 600);
});

// If user switches MP3/MP4, reload qualities for current URL
typeEl.addEventListener("change", () => {
    const url = urlEl.value.trim();
    if (url) fetchQualities(url);
});

/* ------------------------ DOWNLOAD PROGRESS ------------------------ */

function resetProgress() {
    if (progressBar) progressBar.style.width = "0%";
    if (progressText) progressText.textContent = "";
}

function setProgress(pct, speed, eta) {
    if (progressBar) progressBar.style.width = `${pct}%`;
    if (progressText) {
        const s = speed ? ` • ${speed}` : "";
        const e = eta ? ` • ETA ${eta}` : "";
        progressText.textContent = `${pct.toFixed(1)}%${s}${e}`;
    }
}

/* ------------------------ DOWNLOAD ------------------------ */

async function download() {
    const url = urlEl.value.trim();
    const type = typeEl.value;
    const format = qualityEl.disabled ? "" : qualityEl.value;

    if (!url) {
        alert("Paste a URL first.");
        return;
    }

    // ✅ read hasAudio only for mp4 downloads
    let hasAudio = true;
    if (type !== "mp3" && !qualityEl.disabled) {
        const selectedOpt = qualityEl.options[qualityEl.selectedIndex];
        hasAudio = selectedOpt?.dataset.hasAudio === "1";
    }

    downloadBtn.disabled = true;
    resetProgress();
    logEl.textContent = "Starting download...\n";

    try {
        // Start async download job
        const res = await fetch("/api/download", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url, type, format, hasAudio })
        });

        const data = await res.json();
        if (!data.ok) {
            logEl.textContent += (data.error || "Failed to start download.") + "\n";
            downloadBtn.disabled = false;
            return;
        }

        const jobId = data.jobId;
        if (!jobId) {
            logEl.textContent += "No jobId returned from server.\n";
            downloadBtn.disabled = false;
            return;
        }

        // Subscribe to progress stream
        const ev = new EventSource(`/api/progress/${jobId}`);

        ev.onmessage = (msg) => {
            const e = JSON.parse(msg.data);

            if (e.type === "progress") {
                setProgress(e.percent || 0, e.speed || "", e.eta || "");
            }

            if (e.type === "log") {
                logEl.textContent += e.line + "\n";
                logEl.scrollTop = logEl.scrollHeight;
            }

            if (e.type === "done") {
                logEl.textContent += "\nDone!\n";
                ev.close();
                downloadBtn.disabled = false;
            }

            if (e.type === "error") {
                logEl.textContent += "\nERROR: " + (e.message || "Download failed.") + "\n";
                ev.close();
                downloadBtn.disabled = false;
            }
        };

        ev.onerror = () => {
            logEl.textContent += "\nLost connection to progress stream.\n";
            ev.close();
            downloadBtn.disabled = false;
        };

    } catch (err) {
        logEl.textContent += "\nERROR: " + err.message + "\n";
        downloadBtn.disabled = false;
    }
}
