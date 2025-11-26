const { app, BrowserWindow, shell } = require("electron");
app.setName("VidWerk");
const path = require("path");
const http = require("http");

// Start Express server (api.js calls app.listen)
require(path.join(__dirname, "server", "api.js"));

const SERVER_URL = "http://127.0.0.1:8787";
let mainWindow = null;

function waitForServer(retries = 40, delayMs = 300) {
    return new Promise((resolve, reject) => {
        const tryOnce = () => {
            const req = http.get(SERVER_URL, res => {
                res.resume();
                resolve();
            });
            req.on("error", () => {
                if (retries <= 0) return reject(new Error("Server did not start in time"));
                retries--;
                setTimeout(tryOnce, delayMs);
            });
        };
        tryOnce();
    });
}

async function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1100,
        height: 720,
        minWidth: 900,
        minHeight: 600,
        show: false,
        title: "VidWerk",
        autoHideMenuBar: true,
        icon: path.join(__dirname, "assets", "icon.png"),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    await waitForServer();
    mainWindow.loadURL(SERVER_URL);

    // ✅ Open any external links in the user's default browser
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        const isLocal = url.startsWith(SERVER_URL);
        if (!isLocal) {
            shell.openExternal(url);
            return { action: "deny" };
        }
        return { action: "allow" };
    });

    // ✅ Prevent navigation away from app; open external URLs in default browser
    mainWindow.webContents.on("will-navigate", (event, url) => {
        const isLocal = url.startsWith(SERVER_URL);
        if (!isLocal) {
            event.preventDefault();
            shell.openExternal(url);
        }
    });

    mainWindow.once("ready-to-show", () => {
        mainWindow.show();
    });

    // If user closes window → quit everything
    mainWindow.on("closed", () => {
        mainWindow = null;
        app.quit();
    });
}

// ✅ Single instance (clicking app icon focuses same window)
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on("second-instance", () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
    });
}

app.whenReady().then(createMainWindow);

// macOS dock click opens/focuses same window
app.on("activate", () => {
    if (!mainWindow) createMainWindow();
    else {
        mainWindow.show();
        mainWindow.focus();
    }
});

// On Windows/Linux quit when all windows closed
app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});
