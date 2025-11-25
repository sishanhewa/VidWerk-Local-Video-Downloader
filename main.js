const { app, shell } = require("electron");
const path = require("path");

function startServer() {
  const serverPath = path.join(__dirname, "server", "api.js");
  require(serverPath);
}

app.whenReady().then(() => {
  startServer();
  // open in default OS browser (not Electron)
  shell.openExternal("http://127.0.0.1:8787");
});

// no windows used; quit when app is closed
app.on("window-all-closed", () => {
  app.quit();
});
