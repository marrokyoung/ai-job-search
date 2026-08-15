import type { BrowserWindowConstructorOptions } from "electron";

/**
 * The only window configuration the app uses. Kept as a pure function so tests
 * can assert the security-relevant flags without launching Electron.
 */
export function createMainWindowOptions(input: {
  preloadScriptPath: string;
}): BrowserWindowConstructorOptions {
  return {
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      preload: input.preloadScriptPath,
    },
  };
}
