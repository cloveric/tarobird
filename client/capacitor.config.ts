import type { CapacitorConfig } from "@capacitor/cli";
import { KeyboardResize } from "@capacitor/keyboard";

const config: CapacitorConfig = {
  appId: "com.tarobot.client", appName: "TaroBird", webDir: "dist",
  server: { androidScheme: "https" },
  // The edge-to-edge page reserves env(safe-area-inset-*) in its headers and
  // footers. UIKit must not add a second inset to the WKWebView scroll view.
  ios: { contentInset: "never", preferredContentMode: "mobile", scrollEnabled: false },
  plugins: {
    SplashScreen: { launchAutoHide: true },
    PushNotifications: { presentationOptions: ["badge", "sound", "alert"] },
    // MainActivity reserves bars, cutouts and IME before WebView layout. Do not
    // compete with a second listener or depend on injected CSS on newer WebViews.
    SystemBars: { insetsHandling: "disable" },
    // The iOS viewport controller consumes keyboardHeight at willShow. Native
    // resize waits until after the UIKit animation, leaving input covered first.
    // Android remains owned by MainActivity (this resize option is iOS-only).
    Keyboard: { resize: KeyboardResize.None },
  },
};
export default config;
