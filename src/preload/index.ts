import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('simsHelper', {})
