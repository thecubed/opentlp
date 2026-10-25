// Electron main-process side of the native RFCOMM bridge.
//
// The helper (native/macos/rfcomm-bridge) is spawned only when the renderer
// first asks for it, which happens only when the user connects through the
// native Bluetooth option. It speaks JSON lines on stdio; see
// native/macos/rfcomm-bridge/Sources/Bridge.swift for the protocol. Closing
// its stdin makes it close every channel and exit.
const { spawn: spawnProcess } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const HELPER_NAME = 'rfcomm-bridge';
const ADDRESS = /^[0-9A-Fa-f]{2}([:-][0-9A-Fa-f]{2}){5}$/;
const MAX_WRITE_BYTES = 64 * 1024;

/** Where the helper lives: next to the app's resources when packaged, else the local build. */
function helperPath({ packaged, resourcesPath, platform = process.platform } = {}) {
    if (platform !== 'darwin') return undefined;
    if (packaged) return path.join(resourcesPath, HELPER_NAME);
    return path.resolve(__dirname, '../native/macos/rfcomm-bridge/build', HELPER_NAME);
}

class RfcommBridgeProcess extends EventEmitter {
    /**
     * @param {{ executable?: string, spawn?: typeof spawnProcess, timeouts?: { open?: number, other?: number } }} options
     */
    constructor({ executable, spawn = spawnProcess, timeouts = {} } = {}) {
        super();
        this.executable = executable;
        this.spawn = spawn;
        this.timeouts = { open: timeouts.open ?? 45000, other: timeouts.other ?? 15000 };
        this.child = undefined;
        this.ready = undefined;
        this.pending = new Map();
        this.handles = new Set();
        this.nextId = 1;
    }

    /** Whether the helper can run here; never starts it. */
    status() {
        const supported = Boolean(this.executable);
        const built = supported && fs.existsSync(this.executable);
        return {
            supported,
            built,
            running: Boolean(this.child),
            reason: !supported
                ? 'Native Bluetooth is only available on macOS so far.'
                : built ? undefined : `The Bluetooth helper is not built. Run ${path.relative(process.cwd(), path.resolve(path.dirname(this.executable), '..', 'build.sh'))}.`
        };
    }

    listDevices() {
        return this.request({ op: 'list' }).then(reply => reply.devices ?? []);
    }

    async open(address, channel) {
        if (typeof address !== 'string' || !ADDRESS.test(address)) throw new Error('Invalid Bluetooth address.');
        if (!Number.isInteger(channel) || channel < 1 || channel > 30) throw new Error('RFCOMM channel must be 1–30.');
        const reply = await this.request({ op: 'open', address, channel }, this.timeouts.open);
        return { handle: reply.handle, mtu: reply.mtu };
    }

    async write(handle, data) {
        if (!this.handles.has(handle)) throw new Error('RFCOMM channel is not open.');
        if (!(data instanceof Uint8Array) || data.length > MAX_WRITE_BYTES) throw new Error('Invalid write.');
        await this.request({ op: 'write', handle, data: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64') });
    }

    async close(handle) {
        if (!this.handles.has(handle)) return;
        await this.request({ op: 'close', handle }).catch(() => undefined);
    }

    /** End the helper; it closes every channel on the way out. */
    stop() {
        const child = this.child;
        if (!child) return;
        this.detach(new Error('Bluetooth helper stopped.'));
        child.stdin.end();
        const killer = setTimeout(() => child.kill(), 3000);
        killer.unref?.();
        child.once('exit', () => clearTimeout(killer));
    }

    async request(message, timeoutMs = this.timeouts.other) {
        await this.start();
        return this.send(message, timeoutMs);
    }

    start() {
        if (this.ready) return this.ready;
        const { built, reason } = this.status();
        if (!built) return Promise.reject(new Error(reason));

        const child = this.spawn(this.executable, [], { stdio: ['pipe', 'pipe', 'pipe'] });
        this.child = child;
        let buffered = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => {
            buffered += chunk;
            let newline;
            while ((newline = buffered.indexOf('\n')) >= 0) {
                const line = buffered.slice(0, newline);
                buffered = buffered.slice(newline + 1);
                if (line.trim()) this.receive(line);
            }
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', text => this.emit('log', text.trimEnd()));
        child.on('error', error => { if (this.child === child) this.detach(error); });
        child.on('exit', (code, signal) => {
            if (this.child === child) this.detach(new Error(`Bluetooth helper exited (${signal ?? code}).`));
        });

        this.ready = this.send({ op: 'hello' }, this.timeouts.other).then(reply => {
            if (reply.protocol !== 1) throw new Error(`Bluetooth helper speaks protocol ${reply.protocol}, expected 1.`);
        });
        this.ready.catch(() => this.stop());
        return this.ready;
    }

    send(message, timeoutMs) {
        const child = this.child;
        if (!child) return Promise.reject(new Error('Bluetooth helper is not running.'));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Bluetooth helper did not answer ${message.op} in time.`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer, op: message.op });
            child.stdin.write(`${JSON.stringify({ id, ...message })}\n`);
        });
    }

    receive(line) {
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            this.emit('log', `unreadable helper output: ${line}`);
            return;
        }
        if (message.event === 'data') {
            if (this.handles.has(message.handle)) {
                this.emit('data', message.handle, new Uint8Array(Buffer.from(message.data, 'base64')));
            }
        } else if (message.event === 'closed') {
            if (this.handles.delete(message.handle)) this.emit('closed', message.handle, message.by);
        } else if (message.event === 'error') {
            this.emit('log', message.error);
        } else if (typeof message.id === 'number') {
            const waiter = this.pending.get(message.id);
            if (!waiter) return;
            this.pending.delete(message.id);
            clearTimeout(waiter.timer);
            // Track the handle before any of its data, which may be on the next line.
            if (message.ok && waiter.op === 'open') this.handles.add(message.handle);
            if (message.ok) waiter.resolve(message);
            else waiter.reject(new Error(message.error || 'Bluetooth helper request failed.'));
        }
    }

    /** Forget the process: fail what is in flight and report every channel closed. */
    detach(error) {
        this.child = undefined;
        this.ready = undefined;
        for (const { reject, timer } of this.pending.values()) {
            clearTimeout(timer);
            reject(error);
        }
        this.pending.clear();
        for (const handle of this.handles) this.emit('closed', handle, 'helper');
        this.handles.clear();
    }
}

/**
 * Wire the bridge to IPC. `isAllowed(event)` must vouch for the sender; data
 * and close events go to `getContents()`, the app window's webContents.
 */
function registerRfcommBridge({ ipcMain, bridge, isAllowed, getContents }) {
    const guard = handler => (event, ...args) => {
        if (!isAllowed(event)) throw new Error('Not allowed.');
        return handler(...args);
    };
    ipcMain.handle('rfcomm:status', guard(() => bridge.status()));
    ipcMain.handle('rfcomm:list', guard(() => bridge.listDevices()));
    ipcMain.handle('rfcomm:open', guard((address, channel) => bridge.open(address, channel)));
    ipcMain.handle('rfcomm:write', guard((handle, data) => bridge.write(handle, data)));
    ipcMain.handle('rfcomm:close', guard(handle => bridge.close(handle)));

    const send = (channel, payload) => {
        const contents = getContents();
        if (contents && !contents.isDestroyed()) contents.send(channel, payload);
    };
    bridge.on('data', (handle, data) => send('rfcomm:data', { handle, data }));
    bridge.on('closed', (handle, by) => send('rfcomm:closed', { handle, by }));
    bridge.on('log', text => console.warn(`[rfcomm-bridge] ${text}`));
}

module.exports = { RfcommBridgeProcess, registerRfcommBridge, helperPath };
