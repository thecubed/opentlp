/**
 * Platform detection and printer connection guidance.
 *
 * Users should not need to understand transport internals (Web Bluetooth vs Web Serial).
 * This module classifies connection methods into recommendations, alternatives,
 * and discouraged options based on the user's OS, browser, app environment, and printer model.
 */

import { PrintManager, type PrinterModelProfile } from 'universal-label-core';

export type OSKind = 'linux' | 'windows' | 'macos' | 'android' | 'ios' | 'unknown';
export type EnvironmentKind = 'electron' | 'browser' | 'capacitor';
export type GuidanceTier = 'recommended' | 'alternative' | 'discouraged';

export interface PlatformInfo {
    os: OSKind;
    osName: string;
    environment: EnvironmentKind;
    isSecure: boolean;
    supportsWebBluetooth: boolean;
    supportsWebSerial: boolean;
    supportsWebUsb: boolean;
}

export interface TransportGuidance {
    tier: GuidanceTier;
    badge: string;
    warning?: string;
    hints?: string;
    usbHint?: string;
    steps?: string[];
    discouragedReason?: string;
}

/**
 * Detect the current operating system, runtime environment, and Web API capabilities.
 */
export function detectPlatform(
    userAgentOverride?: string,
    capabilitiesOverride?: Partial<Pick<PlatformInfo, 'supportsWebBluetooth' | 'supportsWebSerial' | 'supportsWebUsb'>>
): PlatformInfo {
    const ua = userAgentOverride ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '');
    const isElectron = typeof window !== 'undefined' && (
        'electronAPI' in window || (window as unknown as { process?: { versions?: { electron?: string } } })?.process?.versions?.electron !== undefined
    );
    const isCapacitor = typeof window !== 'undefined' && (
        (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } })?.Capacitor?.isNativePlatform?.() ?? false
    );

    const environment: EnvironmentKind = isCapacitor
        ? 'capacitor'
        : isElectron
        ? 'electron'
        : 'browser';

    let os: OSKind = 'unknown';
    let osName = 'Operating System';

    if (/Android/i.test(ua)) {
        os = 'android';
        osName = 'Android';
    } else if (/iPhone|iPad|iPod/i.test(ua)) {
        os = 'ios';
        osName = 'iOS';
    } else if (/Windows|Win32|Win64/i.test(ua)) {
        os = 'windows';
        osName = 'Windows';
    } else if (/Macintosh|Mac OS X/i.test(ua)) {
        os = 'macos';
        osName = 'macOS';
    } else if (/Linux/i.test(ua)) {
        os = 'linux';
        osName = 'Linux';
    }

    const isSecure = typeof window !== 'undefined' ? Boolean(window.isSecureContext) : true;

    // Pure feature detection
    let supportsWebBluetooth = environment === 'capacitor' || environment === 'electron'
        ? true
        : typeof navigator !== 'undefined' && 'bluetooth' in navigator && isSecure;

    let supportsWebSerial = environment === 'electron'
        ? true
        : typeof navigator !== 'undefined' && 'serial' in navigator && isSecure;

    let supportsWebUsb = environment === 'electron'
        ? true
        : typeof navigator !== 'undefined' && 'usb' in navigator && isSecure;

    if (capabilitiesOverride) {
        if (capabilitiesOverride.supportsWebBluetooth !== undefined) {
            supportsWebBluetooth = capabilitiesOverride.supportsWebBluetooth;
        }
        if (capabilitiesOverride.supportsWebSerial !== undefined) {
            supportsWebSerial = capabilitiesOverride.supportsWebSerial;
        }
        if (capabilitiesOverride.supportsWebUsb !== undefined) {
            supportsWebUsb = capabilitiesOverride.supportsWebUsb;
        }
    }

    return {
        os,
        osName,
        environment,
        isSecure,
        supportsWebBluetooth,
        supportsWebSerial,
        supportsWebUsb
    };
}

let cachedProfiles: PrinterModelProfile[] | undefined;
function getProfiles(): PrinterModelProfile[] {
    if (!cachedProfiles) {
        cachedProfiles = new PrintManager().getAvailablePrinterProfiles();
    }
    return cachedProfiles;
}

export function resolvePrinterProfile(printerModel?: PrinterModelProfile | string): PrinterModelProfile | undefined {
    if (!printerModel) return undefined;
    if (typeof printerModel === 'object') return printerModel;

    const query = printerModel.trim().toLowerCase();
    if (!query) return undefined;

    const cleanQuery = query.replace(/[^a-z0-9]/g, '');
    const profiles = getProfiles();

    // 1. Exact ID
    const exact = profiles.find(p => p.id.toLowerCase() === query);
    if (exact) return exact;

    // 2. Clean ID
    const cleanMatch = profiles.find(p => p.id.toLowerCase().replace(/[^a-z0-9]/g, '') === cleanQuery);
    if (cleanMatch) return cleanMatch;

    // 3. Substring match on model or aliases
    const match = profiles.find(p => {
        const cleanModel = p.model.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (cleanModel === cleanQuery || cleanQuery.includes(cleanModel)) return true;
        return p.aliases?.some(a => {
            const cleanAlias = a.toLowerCase().replace(/[^a-z0-9]/g, '');
            return cleanAlias.includes(cleanQuery) || cleanQuery.includes(cleanAlias);
        });
    });
    if (match) return match;

    // 4. Try PrintManager.getDriverForModel
    const pm = new PrintManager();
    const driver = pm.getDriverForModel(printerModel);
    if (driver) {
        const found = driver.supportedModels?.find(m =>
            m.id.toLowerCase() === query ||
            m.id.toLowerCase().replace(/[^a-z0-9]/g, '') === cleanQuery
        );
        if (found) {
            return found.connectionHints
                ? found
                : driver.connectionHints
                ? { ...found, connectionHints: driver.connectionHints }
                : found;
        }
    }

    // 5. Try resolving by app name or auto: app profile
    const appQuery = query.startsWith('auto:') ? query.replace('auto:', '').replace(/_/g, ' ') : query;
    const appDriver = pm.getDriverForApp(appQuery);
    if (appDriver) {
        const firstModel = appDriver.supportedModels?.[0];
        return {
            id: printerModel,
            brand: appDriver.app ?? appDriver.name,
            model: 'Auto-detect',
            capabilities: firstModel?.capabilities ?? { canvasHeightPx: 384, dpmm: 8, maxDensity: 1, supportsSpeedMode: false, colorSupport: { type: 'monochrome' } },
            app: appDriver.app,
            kind: appDriver.defaultKind,
            supportedTransports: appDriver.supportedTransports,
            connectionHints: appDriver.connectionHints
        };
    }

    return undefined;
}

/**
 * Determine the guidance tier, instructions, and warnings for a transport option.
 */
/**
 * Models a native RFCOMM option is written for. Such an option opens channels
 * by number, so it suits only printers whose channels it knows.
 */
const NATIVE_RFCOMM_MODELS: Record<string, readonly string[]> = {
    'dymo-native': ['dymo_mobilelabeler'],
};

export function getTransportGuidance(
    transportId: string,
    platform: PlatformInfo,
    printerModel?: PrinterModelProfile | string,
    isAvailable?: boolean
): TransportGuidance {
    const id = transportId.toLowerCase();
    const isBle = id.includes('ble') || id === 'bluetooth' || id === 'web-bluetooth';
    const isSerial = id.includes('serial') || id.includes('classic');
    const isUsb = (id.includes('usb') && !id.includes('serial')) || id === 'web-usb' || id === 'usb' || id === 'capacitor-usb';
    const isDummy = id === 'dummy';

    const profile = resolvePrinterProfile(printerModel);
    const hints = profile?.connectionHints;
    const supported = profile?.supportedTransports;

    // 0. NATIVE RFCOMM (desktop helper for one printer family)
    const nativeModels = NATIVE_RFCOMM_MODELS[id];
    if (nativeModels) {
        if (profile && !nativeModels.includes(profile.id)) {
            return {
                tier: 'discouraged',
                badge: 'Other printer',
                discouragedReason: `This option is only for the ${nativeModels.map(m => resolvePrinterProfile(m)?.model ?? m).join(', ')}.`
            };
        }
        return {
            tier: profile ? 'recommended' : 'alternative',
            badge: profile ? 'Recommended' : 'Native Bluetooth',
            hints: 'Prints and also reads battery, cassette and faults, which a serial port cannot.'
        };
    }

    // 1. DUMMY / SIMULATOR
    if (isDummy) {
        return {
            tier: 'alternative',
            badge: 'Virtual Simulation',
            hints: 'Generates a bitmap preview without requiring physical hardware.'
        };
    }

    // 2. BLUETOOTH BLE (Direct Web Bluetooth / Capacitor BLE)
    if (isBle) {
        if (supported && !supported.includes('bluetooth-le')) {
            return {
                tier: 'discouraged',
                badge: 'Unsupported by printer',
                discouragedReason: `${profile?.brand ?? 'This printer'} does not support Bluetooth LE.`,
                warning: 'This printer model does not have Bluetooth LE connectivity.'
            };
        }

        // Browser / runtime environment does not support Web Bluetooth
        if (platform.environment === 'browser' && (!platform.supportsWebBluetooth || isAvailable === false)) {
            return {
                tier: 'discouraged',
                badge: 'Unsupported in this browser',
                discouragedReason: 'Web Bluetooth is not supported in this browser. Use Serial (USB & Bluetooth) or switch to a Chromium-based browser like Chrome or Edge.',
                warning: 'Web Bluetooth is unavailable in this browser. Please use Serial (USB & Bluetooth) or open this page in Chrome or Edge.'
            };
        }

        // Linux: Web Bluetooth is notoriously unreliable / dropping GATT connections
        if (platform.os === 'linux') {
            return {
                tier: 'discouraged',
                badge: 'Not recommended on Linux',
                discouragedReason: 'Web Bluetooth on Linux is often blocked or fails GATT pairing. Bluetooth Serial below is much more reliable.',
                warning: 'Web Bluetooth on Linux typically drops connection or fails to pair with label printers. We strongly recommend Bluetooth Serial instead.'
            };
        }

        // Windows, Android, macOS: Direct BLE is the most convenient recommended path
        const defaultBleHint = profile
            ? `Turn on your ${profile.brand} ${profile.model}, click Connect, and select your device in the popup list.`
            : 'Turn on your printer, click Connect, and select your device in the popup list.';

        return {
            tier: 'recommended',
            badge: 'Recommended',
            warning: 'Do NOT pair this printer in your OS Bluetooth menu! Direct Bluetooth only works when the device is not paired in OS settings.',
            hints: hints?.bleHint ?? defaultBleHint
        };
    }

    // 3. SERIAL (USB CABLE & BLUETOOTH CLASSIC RFCOMM / SPP)
    if (isSerial) {
        if (supported && !supported.includes('bluetooth-classic') && !supported.includes('usb-serial')) {
            return {
                tier: 'discouraged',
                badge: 'Unsupported by printer',
                discouragedReason: `${profile?.brand ?? 'This printer'} only supports Bluetooth LE; its USB port does not provide serial data.`,
                warning: 'This printer hardware does not support Serial or Bluetooth Classic connections.'
            };
        }
        // Serial is recommended on Linux (where BLE is flaky)
        // OR in browsers where Web Bluetooth is unsupported (e.g. Firefox)
        const isBleUnsupportedInBrowser = platform.environment === 'browser' && !platform.supportsWebBluetooth;
        const isRecommended = platform.os === 'linux' || isBleUnsupportedInBrowser;

        const badge = platform.os === 'linux'
            ? 'Recommended on Linux'
            : isBleUnsupportedInBrowser
            ? 'Recommended'
            : 'USB Cable / Bluetooth Serial';

        const usbHint = platform.os === 'linux'
            ? 'Plug in via USB cable and click Connect (select your device, e.g. /dev/ttyUSB0 or /dev/ttyACM0). Ensure your user account is in group dialout (sudo usermod -a -G dialout $USER).'
            : platform.os === 'windows'
            ? 'Plug in via USB cable and click Connect (select your USB-Serial COM port, e.g. COM3 or COM4).'
            : 'Plug in via USB cable, click Connect, and choose your serial port from the list.';

        const steps: string[] = [
            `Open your ${platform.osName} Bluetooth settings (${platform.os === 'windows' ? 'Settings > Bluetooth & devices' : platform.os === 'linux' ? 'Settings > Bluetooth' : 'Bluetooth Settings'}).`,
            'Turn on your printer and click "Add device" or "Pair".'
        ];

        if (platform.os === 'windows' && hints?.windowsClassicHint) {
            steps.push(hints.windowsClassicHint);
        } else if (hints?.bluetoothClassicHint) {
            steps.push(hints.bluetoothClassicHint);
        } else if (profile) {
            const pinPart = hints?.pairingPin ? ` (PIN is ${hints.pairingPin} if prompted)` : '';
            steps.push(`Select your ${profile.brand} ${profile.model} in the list.${pinPart}`);
        } else {
            steps.push('Select your printer name in the list.');
        }

        steps.push('Once paired in your operating system, return here, click Connect, and choose your paired printer from the list.');

        return {
            tier: isRecommended ? 'recommended' : 'alternative',
            badge,
            usbHint,
            hints: 'Supports wired USB cables (USB-Serial) or OS-paired Bluetooth Classic.',
            steps
        };
    }

    // 4. DIRECT USB (WebUSB / Vendor USB)
    if (isUsb) {
        if (supported && !supported.includes('usb')) {
            return {
                tier: 'discouraged',
                badge: 'Unsupported by printer',
                discouragedReason: `${profile?.brand ?? 'This printer'} does not support Direct WebUSB. For USB cable connections, use Serial (USB & Bluetooth) above if supported.`,
                warning: 'This printer does not support Direct WebUSB.'
            };
        }

        if (platform.environment === 'browser' && (!platform.supportsWebUsb || isAvailable === false)) {
            return {
                tier: 'discouraged',
                badge: 'Unsupported in this browser',
                discouragedReason: 'Direct WebUSB is not supported in this browser. If connecting via USB cable, use Serial (USB & Bluetooth) instead.'
            };
        }

        if (platform.os === 'linux') {
            return {
                tier: 'discouraged',
                badge: 'Not recommended on Linux',
                discouragedReason: 'Direct WebUSB on Linux typically fails to claim printer interfaces without custom udev rules. If connecting via USB cable, use Serial (USB & Bluetooth) instead.',
                warning: 'Direct WebUSB on Linux often cannot claim printer interfaces or conflicts with kernel drivers. If connecting via USB cable, use Serial (USB & Bluetooth) above.',
                hints: 'Use Serial (USB & Bluetooth) above for USB cable connections.'
            };
        }

        if (platform.os === 'windows') {
            return {
                tier: 'alternative',
                badge: 'Direct USB',
                hints: 'Plug in via USB. (WebUSB on Windows may require a one-time WinUSB driver setup with Zadig. For USB-Serial COM cables, use Serial above).'
            };
        }

        return {
            tier: 'recommended',
            badge: 'Direct USB',
            hints: 'Plug in via USB cable and click Connect.'
        };
    }

    // Fallback
    return {
        tier: 'alternative',
        badge: 'Standard'
    };
}
