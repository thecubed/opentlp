<script lang="ts">
    import {
        DesignerApp,
        EditorStore,
        PrinterSession,
        type TransportOption
    } from 'universal-label-ui';
    import { DummyTransport } from 'universal-label-core/transport/dummy';
    import { UniversalBluetoothTransport } from 'universal-label-core/transport/web';
    import { WebUsbTransport } from 'universal-label-core/transport/usb';
    import { WebSerialTransport } from 'universal-label-core/transport/web-serial';
    import DevicePicker from './DevicePicker.svelte';
    import { dymoNativeOption, dymoNativeUnavailableReason } from './native-rfcomm';

    const editor = new EditorStore();
    const session = new PrinterSession();
    const dymoNative = dymoNativeOption();
    const transports: TransportOption[] = $state([
        ...(dymoNative ? [dymoNative] : []),
        {
            id: 'bluetooth', label: 'Bluetooth',
            description: 'BLE label printers', available: true,
            create: () => new UniversalBluetoothTransport()
        },
        {
            id: 'usb', label: 'Direct USB',
            description: 'Direct USB label printers (vendor WebUSB)', available: true,
            create: () => new WebUsbTransport()
        },
        {
            id: 'serial', label: 'Serial (USB & Bluetooth)',
            description: 'Wired USB cable (USB-Serial) or paired Bluetooth Classic printer', available: true,
            create: () => new WebSerialTransport()
        },
        {
            id: 'dummy', label: 'Virtual printer',
            description: 'No hardware — exercises the full print pipeline',
            available: true, isDummy: true,
            create: () => new DummyTransport()
        }
    ]);
    if (dymoNative) {
        void dymoNativeUnavailableReason().then(reason => {
            const option = transports.find(t => t.id === dymoNative.id);
            if (option && reason) {
                option.available = false;
                option.unavailableReason = reason;
            }
        });
    }
</script>

{#snippet hardwareTab()}
    <section class="hardware-link">
        <h1>Hardware database</h1>
        <p>
            Explore printer specifications and compatibility notes in the
            OpenTLP Table of Hardware.
        </p>
        <a href="https://opentlp.github.io/table-of-hardware/" target="_blank" rel="noopener noreferrer" class="btn">
            Open the Table of Hardware
        </a>
        <p class="aside">OpenTLP Studio shows compatible models in the printer selection flow.</p>
    </section>
{/snippet}

<DesignerApp
    {editor}
    {session}
    {transports}
    extraTabs={[{ id: 'hardware', label: 'Hardware', content: hardwareTab, fullBleed: true }]}
    title="OpenTLP Studio"
    reportBuild={import.meta.env.VITE_COMMIT_SHA?.slice(0, 12) ?? 'development'}
    reportRuntime="desktop"
/>
<DevicePicker />

<style>
    .hardware-link { max-width: 46rem; margin: 0 auto; padding: 3rem 1.5rem; }
    .hardware-link h1 { margin: 0 0 0.75rem; font-size: 1.5rem; }
    .hardware-link p { color: var(--muted); line-height: 1.6; margin: 0 0 1.25rem; }
    .hardware-link .btn { display: inline-block; padding: 0.6rem 1.1rem; border-radius: 8px; background: var(--accent, #0f5c9c); color: #fff; text-decoration: none; font-weight: 600; }
    .hardware-link .aside { margin-top: 1.5rem; font-size: 0.9rem; }
</style>
