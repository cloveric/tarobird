import { plugins } from "./system-push-core.js";
export const App = {
  getInfo: () => plugins.App.getInfo(),
  getLaunchUrl: () => plugins.App.getLaunchUrl(),
  addListener: (event: string, changed: (value: unknown) => void) => plugins.App.addListener(event, changed),
};
