import type { RfcommBridge } from 'universal-label-core';
import { RfcommBridgeTransport } from 'universal-label-core/transport/rfcomm-bridge';
import type { TransportOption } from 'universal-label-ui';

/** The MobileLabeler takes print jobs on RFCOMM 3; its driver opens 2 for status. */
const DYMO_PRINT_CHANNEL = 3;
const DYMO_NAME = /dymo\s*ml|mobile\s*labeler/i;

/** ipcRenderer.invoke wraps errors as "Error invoking remote method 'x': Error: …". */
function unwrap(error: unknown): never {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, ''));
}

function electronBridge(api: ElectronRfcommAPI): RfcommBridge {
    return {
        listDevices: () => api.listDevices().catch(unwrap),
        open: (address, channel) => api.open(address, channel).catch(unwrap),
        write: (handle, data) => api.write(handle, data).catch(unwrap),
        close: handle => api.close(handle).catch(unwrap),
        onData: listener => api.onData(({ handle, data }) => listener(handle, data)),
        onClosed: listener => api.onClosed(({ handle, by }) => listener(handle, by)),
    };
}

const isMac = () => typeof navigator !== 'undefined' && /Macintosh|Mac OS X/.test(navigator.userAgent);

/**
 * "DYMO MobileLabeler (native Bluetooth)", on macOS only. Choosing it is what
 * starts the Bluetooth helper; nothing runs until then.
 */
export function dymoNativeOption(): TransportOption | undefined {
    const api = typeof window !== 'undefined' ? window.electronAPI?.rfcomm : undefined;
    if (!api || !isMac()) return undefined;
    const bridge = electronBridge(api);
    const option: TransportOption = {
        id: 'dymo-native',
        label: 'DYMO MobileLabeler (native Bluetooth)',
        description: 'Paired MobileLabeler: prints and reads battery, cassette and faults',
        available: true,
        help: {
            summary: 'Pair the printer in macOS first',
            steps: [
                'Pair the MobileLabeler in System Settings › Bluetooth.',
                'If it shows as Connected there, disconnect it (Option-click the Bluetooth menu); macOS holding the link blocks other channels.',
                'Wake the printer, then click Connect. The first time, allow Bluetooth access when macOS asks.',
            ],
        },
        create: () => new RfcommBridgeTransport(bridge, {
            channel: DYMO_PRINT_CHANNEL,
            selectDevice: devices => {
                const matches = devices.filter(device => DYMO_NAME.test(device.name ?? ''));
                return matches.find(device => device.connected) ?? matches[0];
            },
            notFoundMessage: 'No paired DYMO MobileLabeler. Pair it in System Settings › Bluetooth first.',
        }),
    };
    return option;
}

/** Why the native option cannot work here, when that is known before Connect (helper not built). */
export async function dymoNativeUnavailableReason(): Promise<string | undefined> {
    const api = window.electronAPI?.rfcomm;
    if (!api) return undefined;
    const status = await api.status().catch(() => undefined);
    return status && !status.built ? status.reason : undefined;
}
