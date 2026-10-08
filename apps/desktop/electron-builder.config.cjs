// electron-builder configuration: a one-click NSIS installer for Windows (per-user, no admin prompt)
// that updates itself from this repository's public GitHub Releases. No signing or API keys needed.
const [owner, repo] = (process.env.GITHUB_REPOSITORY || 'szen43292-star/automation').split('/');

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.flowforge.desktop',
  productName: 'FlowForge',
  executableName: 'FlowForge',
  copyright: 'FlowForge',
  // The workspace name (@flowforge/desktop) would become the install folder; use a clean one.
  extraMetadata: { name: 'flowforge' },
  directories: { output: 'release', buildResources: 'build' },
  // main.cjs bundles everything except Electron, so the app needs no node_modules
  // (the PostgreSQL packages are copied into resources/runtime by scripts/prepare-resources.mjs).
  files: ['dist/**/*', 'package.json', '!**/node_modules/**/*'],
  extraResources: [{ from: 'resources', to: 'runtime', filter: ['**/*'] }],
  asar: true,
  npmRebuild: false,
  nodeGypRebuild: false,
  publish: [{ provider: 'github', owner, repo, releaseType: 'release' }],
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'build/icon.png',
    // Unsigned build: Windows SmartScreen shows "More info → Run anyway" on first install.
    signAndEditExecutable: true,
    verifyUpdateCodeSignature: false,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    artifactName: 'FlowForge-Setup.${ext}',
    shortcutName: 'FlowForge',
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    runAfterFinish: true,
    deleteAppDataOnUninstall: false,
    include: 'build/installer.nsh',
  },
  linux: {
    target: ['AppImage'],
    icon: 'build/icon.png',
    category: 'Development',
    artifactName: 'FlowForge-${arch}.${ext}',
  },
};
