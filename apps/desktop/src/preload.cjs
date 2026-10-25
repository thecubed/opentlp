const { contextBridge, ipcRenderer } = require('electron');

function subscription(channel, callback) {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.off(channel, listener);
}

contextBridge.exposeInMainWorld('electronAPI', {
    onBluetoothDeviceList: callback => subscription('bluetooth-device-list', callback),
    chooseBluetoothDevice: deviceId => ipcRenderer.send('choose-bluetooth-device', deviceId),
    cancelBluetoothDevice: () => ipcRenderer.send('cancel-bluetooth-device'),
    onUsbDeviceList: callback => subscription('usb-device-list', callback),
    chooseUsbDevice: deviceId => ipcRenderer.send('choose-usb-device', deviceId),
    cancelUsbDevice: () => ipcRenderer.send('cancel-usb-device'),
    onSerialDeviceList: callback => subscription('serial-device-list', callback),
    chooseSerialDevice: portId => ipcRenderer.send('choose-serial-device', portId),
    cancelSerialDevice: () => ipcRenderer.send('cancel-serial-device'),
    rfcomm: {
        status: () => ipcRenderer.invoke('rfcomm:status'),
        listDevices: () => ipcRenderer.invoke('rfcomm:list'),
        open: (address, channel) => ipcRenderer.invoke('rfcomm:open', address, channel),
        write: (handle, data) => ipcRenderer.invoke('rfcomm:write', handle, data),
        close: handle => ipcRenderer.invoke('rfcomm:close', handle),
        onData: callback => subscription('rfcomm:data', callback),
        onClosed: callback => subscription('rfcomm:closed', callback)
    }
});
