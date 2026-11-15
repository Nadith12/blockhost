module.exports = {
  packagerConfig: {
    asar: true,
    prune: true,
    icon: 'assets/app-icon',
    // Store artwork and MSIX branding stay available to their makers, but are
    // not runtime resources. Only these two icons are loaded by the app.
    extraResource: ['./assets/app-icon.png', './assets/app-icon-32.png'],
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {},
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'win32'],
    },
    {
      name: '@electron-forge/maker-msix',
      config: {
        appManifest: './Package.appxmanifest',
        packageAssets: './assets/msix',
        windowsKitVersion: '10.0.26100.0',
        createPri: true,
        sign: false,
      },
    },
    {
      name: '@electron-forge/maker-deb',
      config: {},
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {},
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-vite',
      config: {
        build: [
          {
            entry: 'src/main.js',
            config: 'vite.main.config.mjs',
            target: 'main',
          },
          {
            entry: 'src/preload.js',
            config: 'vite.preload.config.mjs',
            target: 'preload',
          },
        ],
        renderer: [
          {
            name: 'main_window',
            config: 'vite.renderer.config.mjs',
          },
        ],
      },
    },
  ],
};
