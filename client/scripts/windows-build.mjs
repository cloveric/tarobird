import { electronBuildCLI } from './electron-build.mjs';
await electronBuildCLI(process.argv.slice(2), { platform: 'win32', production: true });
