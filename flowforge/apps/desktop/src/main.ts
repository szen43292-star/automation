import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  nativeImage,
  powerMonitor,
  shell,
} from 'electron';
import { autoUpdater } from 'electron-updater';
import { LocalRuntime, loadBundledConfig, pickUpdateSite } from './runtime';

const APP_ID = 'com.flowforge.desktop';
const UPDATE_CHECK_INTERVAL = 60 * 60 * 1000;
/** A downloaded update installs by itself once the PC has been idle this long and no call is on. */
const IDLE_BEFORE_UPDATE_SECONDS = 15 * 60;
const QUIET_CHECK_INTERVAL = 5 * 60 * 1000;

// The data folder (database, secrets.json with the key that encrypts credentials, files) keeps
// its original name, %APPDATA%\FlowForge: Electron would otherwise follow the app's display name
// (now AutoForge) to a new, empty folder. Uninstalling leaves this folder in place, so a
// reinstall finds everything again.
const DATA_FOLDER_NAME = 'FlowForge';
app.setPath('userData', join(app.getPath('appData'), DATA_FOLDER_NAME));
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
// After an update installed by itself, FlowForge comes back in the tray, as before.
const silentUpdateFlag = join(dataDir, 'silent-update.json');
const startHidden = process.argv.includes('--hidden') || consumeSilentUpdateFlag();

function consumeSilentUpdateFlag(): boolean {
  if (!existsSync(silentUpdateFlag)) return false;
  try {
    const { at } = JSON.parse(readFileSync(silentUpdateFlag, 'utf8')) as { at?: number };
    return typeof at === 'number' && Date.now() - at < 60 * 60 * 1000;
  } catch {
    return false;
  } finally {
    rmSync(silentUpdateFlag, { force: true });
  }
}

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
  log(`AutoForge ${app.getVersion()} starting (data: ${dataDir})`);
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
    title: 'AutoForge',
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
        title: 'AutoForge is still running',
        body: 'Your automations keep running in the background. Use the tray icon to open or quit AutoForge.',
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
            `The AutoForge server stopped unexpectedly (exit code ${code}).\nLogs: ${logDir}`,
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
  tray.setToolTip('AutoForge');
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
  updateTray();
}

function updateTray() {
  if (!tray) return;
  tray.setToolTip(serverUrl ? `AutoForge - running at ${serverUrl}` : 'AutoForge - starting…');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open AutoForge', click: () => showWindow() },
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
      { label: `AutoForge ${app.getVersion()}`, enabled: false },
      { label: 'Quit AutoForge', click: () => app.quit() },
    ]),
  );
}

function applyLoginItem() {
  if (process.platform === 'linux') return;
  app.setLoginItemSettings({ openAtLogin: settings.openAtLogin, args: ['--hidden'] });
}

// ---- Updates ----------------------------------------------------------------------------------
// Updates come from your download website (its /downloads folder, found when the app was built -
// no token needed), else from this repository's GitHub Releases (public, or private with a
// built-in token). They download in the background and install by themselves while the PC is idle
// and no call is on, then FlowForge starts again in the tray: nothing to click.

function setupAutoUpdates() {
  if (!app.isPackaged) return;
  const { updateToken, updateUrls } = loadBundledConfig(resourcesDir);
  if (updateToken) {
    // Private repository: a read-only token built into this private build lets the updater see releases.
    process.env.GH_TOKEN = updateToken;
  } else {
    updateSites = updateUrls;
  }
  autoUpdater.logger = { info: log, warn: log, error: log, debug: () => undefined };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', (info) => {
    updateReady = info.version;
    updateTray();
    if (Notification.isSupported()) {
      const notification = new Notification({
        title: `AutoForge ${info.version} is ready`,
        body: 'It installs by itself when your PC is idle and no call is on. Click to update now.',
        icon: join(assets, 'icon.png'),
      });
      notification.on('click', () => void installUpdate());
      notification.show();
    }
    installWhenQuiet();
  });
  void checkForUpdates(false);
  setInterval(() => void checkForUpdates(false), UPDATE_CHECK_INTERVAL).unref();
}

let updateSites: string[] = [];
let updateFeed: string | null = null;

async function checkForUpdates(manual: boolean) {
  try {
    if (updateSites.length) {
      const site = await pickUpdateSite(updateSites);
      if (!site) {
        log(`No download website answered (${updateSites.join(', ')}) - trying again later`);
        return;
      }
      if (site.url !== updateFeed) {
        autoUpdater.setFeedURL({ provider: 'generic', url: `${site.url}/downloads` });
        updateFeed = site.url;
        log(`Updates from ${site.url}/downloads (offers ${site.version})`);
      }
    }
    const result = await autoUpdater.checkForUpdates();
    if (manual && Notification.isSupported() && !result?.isUpdateAvailable) {
      new Notification({
        title: 'AutoForge is up to date',
        body: `You have version ${app.getVersion()}.`,
      }).show();
    }
  } catch (error) {
    log(`Update check failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

let quietTimer: NodeJS.Timeout | null = null;

/** Installs the downloaded update once nobody is using the PC and no call is in progress. */
function installWhenQuiet() {
  if (quietTimer) return;
  quietTimer = setInterval(() => {
    void (async () => {
      if (quitting || powerMonitor.getSystemIdleTime() < IDLE_BEFORE_UPDATE_SECONDS) return;
      if ((await activeCalls()) !== 0) return;
      log(`Installing AutoForge ${updateReady} while the PC is idle`);
      await installUpdate(true);
    })();
  }, QUIET_CHECK_INTERVAL);
  quietTimer.unref();
}

/** Calls in progress on this PC's server; null when it cannot tell (then wait). */
async function activeCalls(): Promise<number | null> {
  if (!serverUrl) return 0;
  try {
    const response = await fetch(`${serverUrl}/readyz`, { signal: AbortSignal.timeout(5000) });
    const body = (await response.json()) as { activeCalls?: number };
    return typeof body.activeCalls === 'number' ? body.activeCalls : null;
  } catch {
    return null;
  }
}

async function installUpdate(silent = false) {
  quitting = true;
  if (silent) writeFileSync(silentUpdateFlag, JSON.stringify({ at: Date.now() }));
  await runtime?.stop();
  runtime = null;
  // Silent: no installer window; either way FlowForge starts again afterwards.
  autoUpdater.quitAndInstall(silent, true);
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
