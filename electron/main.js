const { app, BrowserWindow } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const os = require('os')

const isDev = process.argv.includes('--dev')

let backendProcess = null

function startBackend() {
  const backendDir = path.join(__dirname, '..', 'backend')
  const pythonBin = os.platform() === 'win32'
    ? path.join(backendDir, 'venv', 'Scripts', 'python.exe')
    : path.join(backendDir, 'venv', 'bin', 'python')

  backendProcess = spawn(pythonBin, ['-m', 'uvicorn', 'main:app', '--port', '8000'], {
    cwd: backendDir,
    stdio: 'pipe',
  })

  backendProcess.stdout.on('data', (d) => console.log('[backend]', d.toString().trimEnd()))
  backendProcess.stderr.on('data', (d) => console.error('[backend]', d.toString().trimEnd()))
  backendProcess.on('error', (err) => console.error('[backend] Failed to start:', err.message))
  backendProcess.on('exit', (code) => console.log('[backend] Exited with code', code))
}

function stopBackend() {
  if (backendProcess) {
    backendProcess.kill()
    backendProcess = null
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1080,
    height: 1920,
    fullscreen: !isDev,
    kiosk: !isDev,
    frame: isDev,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (isDev) {
    win.loadURL('http://localhost:3000')
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(path.join(__dirname, '..', 'frontend', 'dist', 'index.html'))
  }

  if (!isDev) {
    win.webContents.on('did-finish-load', () => {
      win.webContents.insertCSS('* { cursor: none !important; }')
    })
  }
}

app.whenReady().then(() => {
  if (!isDev) startBackend()
  createWindow()
})

app.on('window-all-closed', () => {
  stopBackend()
  app.quit()
})
