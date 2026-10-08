import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, Menu, Notification, Tray, nativeImage, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import { LocalRuntime } from './runtime';

const APP_ID = 'com.flowforge.desktop';
const UPDATE_CHECK_INTERVAL = 6 * 60 * 60 * 1000;

const dataDir = app.getPath('userData');
const logDir = join(dataDir, 'logs');
const resourcesDir = app.isPackaged
  ? join(process.resourcesPath, 'runtime')
  : join(__dirname, '..', 'resources');
const assets = __dirname; // tsup copies src/assets next to main.cjs

mkdirSync(logDir, { recursive: true });
function log(message: string) {
  const line = `${new Date().toISOString()} ${message}\n`;
  process.stdout.write(line);
  try {
    appendFileSync(join(logDir, 'desktop.log'), line);
  } catch {
    // logging must never break the app
  }
}

// ---- Settings ---------------------------------------------------------------------------------

interface Settings {
  openAtLogin: boolean;
  trayNoticeShown: boolean;
}
const settingsFile = join(dataDir, 'desktop-settings.json');
const firstRun = !existsSync(settingsFile);
function readSettings(): Settings {
  const defaults: Settings = { openAtLogin: true, trayNoticeShown: false };
  try {
    return {
      ...defaults,
      ...(JSON.parse(readFileSync(settingsFile, 'utf8')) as Partial<Settings>),
    };
  } catch {
    return defaults;
  }
}
let settings = readSettings();
function saveSettings(patch: Partial<Settings>) {
  settings = { ...settings, ...patch };
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}

// ---- State ------------------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let runtime: LocalRuntime | null = null;
let serverUrl: string | null = null;
let quitting = false;
let updateReady: string | null = null;
const startHidden = process.argv.includes('--hidden');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app
    .whenReady()
    .then(onReady)
    .catch((error: unknown) => log(`Startup failed: ${String(error)}`));
}

async function onReady() {
  app.setAppUserModelId(APP_ID);
  Menu.setApplicationMenu(null);
  log(`FlowForge ${app.getVersion()} starting (data: ${dataDir})`);
  if (firstRun) saveSettings({});
  applyLoginItem();
  createTray();
  createWindow();
  await startRuntime();
  setupAutoUpdates();
}

// ---- Window -----------------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    show: !startHidden,
    title: 'FlowForge',
    icon: join(assets, 'icon.png'),
    autoHideMenuBar: true,
    backgroundColor: '#f7f7f9',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  void mainWindow.loadFile(join(assets, 'splash.html'));

  const { webContents } = mainWindow;
  // Splash buttons, and links that leave the app, are handled here.
  webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('flowforge-action://')) {
      event.preventDefault();
      if (url.includes('retry')) void startRuntime();
      if (url.includes('logs')) void shell.openPath(logDir);
      return;
    }
    if (serverUrl && url.startsWith(serverUrl)) return;
    if (url.startsWith('file:')) return;
    event.preventDefault();
    if (/^https?:/.test(url)) void shell.openExternal(url);
  });
  webContents.setWindowOpenHandler(({ url, disposition }) => {
    // window.open() popups (e.g. OAuth sign-in) stay in the app; ordinary links open in the browser.
    if (disposition === 'new-window' && /^https?:/.test(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { autoHideMenuBar: true, width: 600, height: 720 },
      };
    }
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Closing the window keeps FlowForge running in the tray, so triggers and calls keep working.
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow?.hide();
    if (!settings.trayNoticeShown && Notification.isSupported()) {
      new Notification({
        title: 'FlowForge is still running',
        body: 'Your automations keep running in the background. Use the tray icon to open or quit FlowForge.',
        icon: join(assets, 'icon.png'),
      }).show();
      saveSettings({ trayNoticeShown: true });
    }
  });
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (serverUrl) void mainWindow?.loadURL(serverUrl);
  mainWindow?.show();
  if (mainWindow?.isMinimized()) mainWindow.restore();
  mainWindow?.focus();
}

function splash(fn: 'setStatus' | 'setError', text: string) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const contents = mainWindow.webContents;
  if (contents.isDestroyed() || contents.getURL().startsWith('http')) return;
  const run = () =>
    void contents.executeJavaScript(`window.${fn}(${JSON.stringify(text)})`).catch(() => undefined);
  if (contents.isLoading()) contents.once('did-finish-load', run);
  else run();
}

// ---- Runtime ----------------------------------------------------------------------------------

async function startRuntime() {
  if (runtime) await runtime.stop();
  serverUrl = null;
  if (mainWindow && mainWindow.webContents.getURL().startsWith('http')) {
    await mainWindow.loadFile(join(assets, 'splash.html'));
  }
  runtime = new LocalRuntime({
    resourcesDir,
    dataDir,
    log: (message) => {
      log(message);
      splash('setStatus', message);
    },
  });
  try {
    serverUrl = await runtime.start();
    runtime.onServerExit((code) => {
      if (quitting) return;
      log(`Server exited unexpectedly (code ${code})`);
      serverUrl = null;
      updateTray();
      void mainWindow
        ?.loadFile(join(assets, 'splash.html'))
        .then(() =>
          splash(
            'setError',
            `The FlowForge server stopped unexpectedly (exit code ${code}).\nLogs: ${logDir}`,
          ),
        );
    });
    await mainWindow?.loadURL(serverUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Start failed: ${message}`);
    splash('setError', `${message}\n\nLogs: ${logDir}`);
    mainWindow?.show();
  }
  updateTray();
}

// ---- Tray -------------------------------------------------------------------------------------

function createTray() {
  const image = nativeImage.createFromPath(join(assets, 'tray.png'));
  tray = new Tray(image);
  tray.setToolTip('FlowForge');
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
  updateTray();
}

function updateTray() {
  if (!tray) return;
  tray.setToolTip(serverUrl ? `FlowForge - running at ${serverUrl}` : 'FlowForge - starting…');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open FlowForge', click: () => showWindow() },
      {
        label: 'Open in browser',
        enabled: Boolean(serverUrl),
        click: () => serverUrl && void shell.openExternal(serverUrl),
      },
      { type: 'separator' },
      {
        label: 'Start with Windows',
        type: 'checkbox',
        checked: settings.openAtLogin,
        click: (item) => {
          saveSettings({ openAtLogin: item.checked });
          applyLoginItem();
        },
      },
      updateReady
        ? { label: `Restart to install version ${updateReady}`, click: () => void installUpdate() }
        : {
            label: 'Check for updates',
            enabled: app.isPackaged,
            click: () => void checkForUpdates(true),
          },
      { label: 'Open logs folder', click: () => void shell.openPath(logDir) },
      { type: 'separator' },
      { label: `FlowForge ${app.getVersion()}`, enabled: false },
      { label: 'Quit FlowForge', click: () => app.quit() },
    ]),
  );
}

function applyLoginItem() {
  if (process.platform === 'linux') return;
  app.setLoginItemSettings({ openAtLogin: settings.openAtLogin, args: ['--hidden'] });
}

// ---- Updates ----------------------------------------------------------------------------------
// Updates come from the public GitHub Releases of this repository: no account or key needed.

function setupAutoUpdates() {
  if (!app.isPackaged) return;
  autoUpdater.logger = { info: log, warn: log, error: log, debug: () => undefined };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', (info) => {
    updateReady = info.version;
    updateTray();
    if (Notification.isSupported()) {
      const notification = new Notification({
        title: `FlowForge ${info.version} is ready`,
        body: 'Click to restart and update now, or it installs the next time FlowForge quits.',
        icon: join(assets, 'icon.png'),
      });
      notification.on('click', () => void installUpdate());
      notification.show();
    }
  });
  void checkForUpdates(false);
  setInterval(() => void checkForUpdates(false), UPDATE_CHECK_INTERVAL).unref();
}

async function checkForUpdates(manual: boolean) {
  try {
    const result = await autoUpdater.checkForUpdates();
    if (manual && Notification.isSupported() && !result?.isUpdateAvailable) {
      new Notification({
        title: 'FlowForge is up to date',
        body: `You have version ${app.getVersion()}.`,
      }).show();
    }
  } catch (error) {
    log(`Update check failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function installUpdate() {
  quitting = true;
  await runtime?.stop();
  runtime = null;
  autoUpdater.quitAndInstall(false, true);
}

// ---- Quit -------------------------------------------------------------------------------------

app.on('window-all-closed', () => {
  // Keep running in the tray.
});

app.on('before-quit', (event) => {
  quitting = true;
  if (!runtime) return;
  // Stop the server and database cleanly before exiting.
  event.preventDefault();
  const current = runtime;
  runtime = null;
  void current.stop().finally(() => app.quit());
});
