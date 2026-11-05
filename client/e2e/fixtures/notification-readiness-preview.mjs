import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
const alias = (name, file) => ({ find: new RegExp('^' + name + '$'), replacement: fileURLToPath(new URL(file, import.meta.url)) });
const server = await createServer({ root: fileURLToPath(new URL('../../', import.meta.url)), resolve: { alias: [alias('@capacitor/core','./notification-readiness-core.ts'),alias('@capacitor/push-notifications','./notification-readiness-push.ts')] }, server: { host: '127.0.0.1', port: 55927, strictPort: true } });
await server.listen();
console.log('Notification settings preview ready at http://127.0.0.1:55927/e2e/fixtures/notification-readiness.html');
