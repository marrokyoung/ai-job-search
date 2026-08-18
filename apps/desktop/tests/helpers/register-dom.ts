/**
 * Registers happy-dom globals for renderer tests. Import this FIRST in a test
 * file, before anything that pulls in React or Testing Library, so the DOM
 * globals exist when those modules are evaluated.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register();
  // Lets React's act() know updates are expected to be wrapped by the test
  // renderer (Testing Library does the wrapping).
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}
