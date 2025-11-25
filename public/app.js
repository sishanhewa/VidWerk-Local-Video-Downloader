const urlEl = document.getElementById("url");
const typeEl = document.getElementById("type");
const qualityEl = document.getElementById("quality");
const downloadBtn = document.getElementById("downloadBtn");
const cancelBtn = document.getElementById("cancelBtn");
const showBtn = document.getElementById("showBtn");

const progressBar = document.getElementById("progressBar");
const progressText = document.getElementById("progressText");

let debounceTimer = null;
let lastUrlLoaded = "";
let currentJobId = null;
let currentEventSource = null;
let lastDownloadedFile = null;

/* ------------------------ QUALITIES AUTO-LOAD ------------------------ */

function setLoadingQualities(isLoading) {
    qualityEl.disabled = true;
    qualityEl.innerHTML = `<option>${isLoading ? "Loading qualities…" : "Paste URL to load qualities…"}</option>`;
}

async function fetchQualities(url) {
    setLoadingQualities(true);

    try {
        const res = await fetch("/api/formats", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url })
        });

        const data = await res.json();
        if (!data.ok) {
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

            if (type !== "mp3") {
                opt.dataset.hasAudio = f.hasAudio ? "1" : "0";
            }

            qualityEl.appendChild(opt);
        }

        qualityEl.disabled = formats.length === 0;
    } catch {
        setLoadingQualities(false);
    }
}

function maybeAutoLoad() {
    const url = urlEl.value.trim();
    if (!url || url === lastUrlLoaded) return;

    lastUrlLoaded = url;
    fetchQualities(url);
}

urlEl.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(maybeAutoLoad, 600);
});

typeEl.addEventListener("change", () => {
    const url = urlEl.value.trim();
    if (url) fetchQualities(url);
});

/* ------------------------ PROGRESS UI ------------------------ */

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

/* ------------------------ CANCEL ------------------------ */

async function cancelDownload() {
    if (!currentJobId) return;

    cancelBtn.disabled = true;
    if (progressText) progressText.textContent = "Cancelling…";

    try {
        await fetch(`/api/cancel/${currentJobId}`, { method: "POST" });
    } catch {}

    if (currentEventSource) {
        currentEventSource.close();
        currentEventSource = null;
    }

    if (progressBar) progressBar.style.width = "0%";
    if (progressText) progressText.textContent = "Cancelled ❌";

    downloadBtn.disabled = false;
    cancelBtn.style.display = "none";
    if (showBtn) showBtn.style.display = "none";
    currentJobId = null;
}

/* ------------------------ SHOW IN FOLDER ------------------------ */

async function showInFolder() {
    if (!lastDownloadedFile) return;

    try {
        await fetch("/api/reveal", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({ filePath: lastDownloadedFile })
        });
    } catch {
        alert("Could not open folder.");
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

    let hasAudio = true;
    if (type !== "mp3" && !qualityEl.disabled) {
        const selectedOpt = qualityEl.options[qualityEl.selectedIndex];
        hasAudio = selectedOpt?.dataset.hasAudio === "1";
    }

    downloadBtn.disabled = true;
    resetProgress();
    lastDownloadedFile = null;
    if (showBtn) showBtn.style.display = "none";
    if (progressText) progressText.textContent = "Started downloading…";

    try {
        const res = await fetch("/api/download", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url, type, format, hasAudio })
        });

        const data = await res.json();
        if (!data.ok || !data.jobId) {
            if (progressText) progressText.textContent = "Failed to start download.";
            downloadBtn.disabled = false;
            return;
        }

        currentJobId = data.jobId;

        cancelBtn.style.display = "inline-flex";
        cancelBtn.disabled = false;

        const ev = new EventSource(`/api/progress/${currentJobId}`);
        currentEventSource = ev;

        ev.onmessage = (msg) => {
            const e = JSON.parse(msg.data);

            if (e.type === "progress") {
                setProgress(e.percent || 0, e.speed || "", e.eta || "");
            }

            if (e.type === "done") {
                if (progressBar) progressBar.style.width = "100%";
                if (progressText) progressText.textContent = "Complete ✅";

                lastDownloadedFile = e.filePath || null;
                if (showBtn && lastDownloadedFile) {
                    showBtn.style.display = "inline-flex";
                }

                ev.close();
                currentEventSource = null;
                cancelBtn.style.display = "none";
                downloadBtn.disabled = false;
                currentJobId = null;
            }

            if (e.type === "cancelled") {
                if (progressBar) progressBar.style.width = "0%";
                if (progressText) progressText.textContent = "Cancelled ❌";
                ev.close();
                currentEventSource = null;
                cancelBtn.style.display = "none";
                downloadBtn.disabled = false;
                currentJobId = null;
            }

            if (e.type === "error") {
                if (progressText) progressText.textContent = "Download failed.";
                ev.close();
                currentEventSource = null;
                cancelBtn.style.display = "none";
                downloadBtn.disabled = false;
                currentJobId = null;
            }
        };

        ev.onerror = () => {
            if (progressText) progressText.textContent = "Lost connection.";
            ev.close();
            currentEventSource = null;
            cancelBtn.style.display = "none";
            downloadBtn.disabled = false;
            currentJobId = null;
        };

    } catch {
        if (progressText) progressText.textContent = "Download error.";
        downloadBtn.disabled = false;
        cancelBtn.style.display = "none";
        currentJobId = null;
    }
}
