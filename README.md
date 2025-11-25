# 🎬 YT Downloader (Electron + yt-dlp)

A clean, lightweight YouTube downloader that launches a **local web UI in your default browser**.  
Paste a link → choose **MP4 or MP3** → pick quality → download.  
Bundled with **yt-dlp + ffmpeg**, so end users don’t need to install Python, Node, or anything else.

---

## ⬇️ Downloads

- **macOS (.dmg)**: Download from **Releases**  
  https://github.com/sishanhewa/Local-Video-Downloader/releases/latest
- **Windows (.exe)**: coming soon

> Go to the **Releases** section on the right side of this repo and grab the newest `.dmg`.

---

## ✨ Features

- 🌐 Opens in your **default browser** (no Electron window UI)
- 🎞️ **MP4 video / MP3 audio** toggle
- 📺 Simple **quality dropdown with file size**
- 🚀 **Live progress** (percent • speed • ETA)
- 📁 Saves straight to your **Downloads folder**
- 🧩 Fully bundled → no extra installs for end users

---

## 🖥️ Install (macOS)

1. Download the latest **`.dmg`** from Releases  
2. Open it and drag **YT Downloader** into Applications  
3. Launch the app

### macOS Security / Gatekeeper
Because the app isn’t notarized yet, macOS may block the first launch.

If you see:  
**“Apple could not verify this app is free of malware…”**

Do one of these:

**Method A**
1. **Right-click** the app → **Open**
2. Click **Open anyway**

**Method B**
1. Go to **System Settings → Privacy & Security**
2. Scroll to **Security**
3. Click **Open Anyway** next to YT Downloader

✅ After first launch, it opens normally.

---

## ▶️ How to Use

1. Open **YT Downloader**
2. Your browser opens automatically at:  
   `http://127.0.0.1:8787`
3. Paste a YouTube link
4. Pick:
   - **MP4 (Video)** or  
   - **MP3 (Audio)**
5. Select your desired quality
6. Click **Download**
7. Your file appears in **Downloads** 🎉

---

## 🧑‍💻 IntelliJ IDEA (mac) — Developer Setup

### 1) Open the project
1. Launch **IntelliJ IDEA**
2. **File → Open**
3. Select the folder: `yt-downloader-electron`
4. Trust the project when prompted.

### 2) Configure Node.js in IntelliJ
1. **IntelliJ → Settings → Languages & Frameworks → Node.js**
2. Set **Node interpreter** to your Node installation  
   (example: `/opt/homebrew/bin/node`).
3. Apply / OK.

### 3) Install dependencies
Open IntelliJ Terminal (**View → Tool Windows → Terminal**) and run:

```bash
npm install
```

### 4) Add binaries
Place official binaries here:

**macOS**
```
bin/mac/yt-dlp_macos
bin/mac/ffmpeg_macos
```

Make executable + allow on mac:
```bash
chmod +x bin/mac/yt-dlp_macos bin/mac/ffmpeg_macos
xattr -dr com.apple.quarantine bin/mac/yt-dlp_macos bin/mac/ffmpeg_macos
```

**Windows**
```
bin/win/yt-dlp.exe
bin/win/ffmpeg.exe
```

### 5) Run in dev mode
```bash
npm run dev
```

Electron starts a local server and opens your default browser automatically.

### 6) Build the macOS DMG
```bash
npm run dist
```

Outputs:
```
dist/
  YT Downloader.dmg
  mac/YT Downloader.app
```

---

## 🛠️ For Developers (CLI only)

### Run locally
```bash
npm install
npm run dev
```

### Build installers
```bash
npm run dist
```

---

## 🧩 Project Structure

```
yt-downloader-electron/
  main.js
  package.json
  server/
    api.js
  public/
    index.html
    app.js
    styles.css
  bin/
    mac/
      yt-dlp_macos
      ffmpeg_macos
    win/
      yt-dlp.exe
      ffmpeg.exe
```

---

## ⚠️ Note on Usage
Please download only content you own or have permission to download.  
Respect creators and platform terms.

---

## 🙌 Credits
- **yt-dlp** — download engine  
- **ffmpeg** — audio/video conversion  
- Built with **Electron + Express**

---

## 🔮 Roadmap
- ✅ macOS DMG installer
- ⏳ Windows installer (coming soon)
- ⏳ Optional “simple mode” UI (progress-only)
