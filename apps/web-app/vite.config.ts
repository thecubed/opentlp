import { defineConfig, type PluginOption } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'path';
import fs from 'fs';

// The workspace packages are aliased to their TypeScript sources so dev/build
// always compile the live code:
//   core     -> hardware, drivers, transports
//   renderer -> ULT template engine, layout, rasterization (pure TS)
//   ui       -> the Svelte designer
const pkg = (...p: string[]) => path.resolve(import.meta.dirname, '../../packages', ...p);
const configuredBase = process.env.VITE_BASE_PATH || '/';
const base = configuredBase.endsWith('/') ? configuredBase : `${configuredBase}/`;

/**
 * Some printer libraries (niimbluelib) reach for native Node backends —
 * serialport, noble, usb — which execute `os.platform()` / extend Node streams
 * at import time and therefore break in a browser. The web app only ever talks
 * over browser or Capacitor APIs, so those modules are replaced with an inert
 * browser-safe module during bundling.
 */
const NODE_ONLY = [/^serialport$/, /^@serialport\//, /noble/, /^usb$/, /^bluetooth-hci-socket/];
/** Inert stand-in: any property/call/construct keeps returning something safe. */
const INERT_SOURCE =
    'const inert = new Proxy(function () {}, { get: () => inert, construct: () => ({}), apply: () => undefined });';
const STUB_ID = '\0node-only-stub';
const stubNodeOnly = {
  name: 'stub-node-only-transports',
  enforce: 'pre' as const,
  resolveId(id: string) {
    return NODE_ONLY.some(re => re.test(id)) ? STUB_ID : null;
  },
  load(id: string) {
    // A Proxy so any named import resolves to something inert rather than
    // `undefined` (which would blow up `class X extends ...` at module scope).
    return id === STUB_ID ? `${INERT_SOURCE}\nexport default inert;\nexport { inert as SerialPort };` : null;
  }
};

export default defineConfig({
  base,
  plugins: [stubNodeOnly, svelte(), precacheManifest()],
  resolve: {
    alias: {
      'universal-label-core/transport/dummy': pkg('core/src/core/transports/dummy-transport.ts'),
      'universal-label-core/transport/web': pkg('core/src/core/transports/bluetooth-transport.ts'),
      'universal-label-core/transport/usb': pkg('core/src/core/transports/web-usb-transport.ts'),
      'universal-label-core/transport/web-serial': pkg('core/src/core/transports/web-serial-transport.ts'),
      'universal-label-core/transport/capacitor': pkg('core/src/core/transports/capacitor-ble-transport.ts'),
      'universal-label-core/transport/capacitor-usb': pkg('core/src/core/transports/capacitor-usb-transport.ts'),
      'universal-label-core/transport/capacitor-classic': pkg('core/src/core/transports/capacitor-classic-transport.ts'),
      'universal-label-core': pkg('core/src/index.ts'),
      'universal-label-renderer': pkg('renderer/src/index.ts'),
      'universal-label-ui': pkg('ui-components/src/index.ts')
    }
  },
  optimizeDeps: {
    // niimbluelib ships CommonJS only. Excluding it served the raw CJS file to
    // the browser in dev, where its named exports (ConnectResult, ...) do not
    // exist; pre-bundling converts it to ESM.
    include: ['@mmote/niimbluelib'],
    exclude: [
      'universal-label-core',
      'universal-label-core/transport/web',
      'universal-label-core/transport/dummy',
      'universal-label-core/transport/usb',
      'universal-label-core/transport/web-serial',
      'universal-label-core/transport/capacitor',
      'universal-label-core/transport/capacitor-usb',
      'universal-label-core/transport/capacitor-classic',
      'universal-label-renderer',
      'universal-label-ui'
    ]
  },
  build: {
    commonjsOptions: {
      include: [/universal-label-core/, /node_modules/]
    }
  }
});

/**
 * Bake the built asset names into the service worker's precache list.
 *
 * Without this the app is only offline-capable from the *second* visit: on the
 * first load the worker is not yet controlling the page, so the entry chunk and
 * stylesheet are fetched straight from the network and never enter the cache.
 * Install → go offline → open would then show a blank page.
 *
 * Only the entry chunk and CSS are precached. The bitmap fonts are lazy chunks
 * (~700 KB in total) and runtime caching picks up whichever ones are actually
 * used, so the install stays small.
 */
function precacheManifest(): PluginOption {
  return {
    name: 'sw-precache-manifest',
    apply: 'build',
    writeBundle(options, bundle) {
      const dir = options.dir ?? 'dist';
      const entry: string[] = [];
      for (const [file, chunk] of Object.entries(bundle)) {
        const isEntry = chunk.type === 'chunk' && chunk.isEntry;
        const isCss = file.endsWith('.css');
        if (isEntry || isCss) entry.push(base + file);
      }
      const swPath = path.join(dir, 'sw.js');
      if (!fs.existsSync(swPath)) return;
      const src = fs.readFileSync(swPath, 'utf8');
      fs.writeFileSync(
        swPath,
        src.replace('const PRECACHE = [];', `const PRECACHE = ${JSON.stringify(entry)};`),
        'utf8'
      );
    }
  };
}
