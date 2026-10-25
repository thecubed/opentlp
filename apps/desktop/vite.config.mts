import { defineConfig, type PluginOption } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const pkg = (...parts: string[]) => path.resolve(here, '../../packages', ...parts);
const nodeOnly = [/^serialport$/, /^@serialport\//, /noble/, /^usb$/, /^bluetooth-hci-socket/];
const stubId = '\0node-only-stub';
const inertSource = 'const inert = new Proxy(function () {}, { get: () => inert, construct: () => ({}), apply: () => undefined });';
const stubNodeOnly: PluginOption = {
    name: 'stub-node-only-transports',
    enforce: 'pre',
    resolveId(id) { return nodeOnly.some(pattern => pattern.test(id)) ? stubId : null; },
    load(id) { return id === stubId ? `${inertSource}\nexport default inert;\nexport { inert as SerialPort };` : null; }
};

export default defineConfig({
    base: './',
    plugins: [stubNodeOnly, svelte()],
    resolve: {
        alias: {
            'universal-label-core/transport/dummy': pkg('core/src/core/transports/dummy-transport.ts'),
            'universal-label-core/transport/web': pkg('core/src/core/transports/bluetooth-transport.ts'),
            'universal-label-core/transport/usb': pkg('core/src/core/transports/web-usb-transport.ts'),
            'universal-label-core/transport/web-serial': pkg('core/src/core/transports/web-serial-transport.ts'),
            'universal-label-core/transport/rfcomm-bridge': pkg('core/src/core/transports/rfcomm-bridge-transport.ts'),
            'universal-label-core': pkg('core/src/index.ts'),
            'universal-label-renderer': pkg('renderer/src/index.ts'),
            'universal-label-ui': pkg('ui-components/src/index.ts')
        }
    },
    optimizeDeps: {
        exclude: ['universal-label-core', 'universal-label-renderer', 'universal-label-ui']
    },
    server: {
        host: '127.0.0.1',
        port: 5174,
        strictPort: true,
        fs: { allow: ['../..'] }
    }
});
