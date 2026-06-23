import { getLocalModelById } from './localModels.js';

export const isLocalAIAvailable = () => typeof window !== 'undefined' && !!window.localAI?.isElectron;

class LocalInferenceClient {
    async getBinaryStatus() { if (!isLocalAIAvailable()) return { exists: false }; return window.localAI.getBinaryStatus(); }
    async downloadBinary() { if (!isLocalAIAvailable()) throw new Error('Local AI only available in the desktop app.'); return window.localAI.downloadBinary(); }
    async downloadModel(modelId) { if (!isLocalAIAvailable()) throw new Error('Local AI only available in the desktop app.'); return window.localAI.downloadModel(modelId); }
    async downloadAuxiliary(auxKey) { if (!isLocalAIAvailable()) throw new Error('Local AI only available in the desktop app.'); return window.localAI.downloadAuxiliary(auxKey); }
    async deleteModel(modelId) { if (!isLocalAIAvailable()) throw new Error('Local AI only available in the desktop app.'); return window.localAI.deleteModel(modelId); }
    async getWan2gpConfig() { if (!isLocalAIAvailable()) return { url: '' }; return window.localAI.wan2gp.getConfig(); }
    async setWan2gpUrl(url) { if (!isLocalAIAvailable()) throw new Error('Local AI only available in the desktop app.'); return window.localAI.wan2gp.setUrl(url); }
    async probeWan2gp(url) { if (!isLocalAIAvailable()) return { ok: false, error: 'Not in desktop app' }; return window.localAI.wan2gp.probe(url); }
    async uploadFileToWan2gp(file) {
        if (!isLocalAIAvailable()) throw new Error('Local AI only available in the desktop app.');
        const buf = await file.arrayBuffer();
        return window.localAI.wan2gp.uploadFile({ name: file.name, type: file.type, bytes: new Uint8Array(buf) });
    }
    async listModels() {
        if (!isLocalAIAvailable()) return [];
        const [sdcpp, wan2gp] = await Promise.all([window.localAI.listModels(), window.localAI.wan2gp.listModels().catch(() => [])]);
        return [...sdcpp.map(m => ({ ...m, provider: m.provider || 'sdcpp' })), ...wan2gp];
    }
    async generate(params) {
        if (!isLocalAIAvailable()) throw new Error('Local AI only available in the desktop app.');
        const model = getLocalModelById(params.model);
        if (model?.provider === 'wan2gp') return window.localAI.wan2gp.generate(params);
        return window.localAI.generate(params);
    }
    cancelGeneration() {
        if (!isLocalAIAvailable()) return;
        window.localAI.cancelGeneration();
        window.localAI.wan2gp.cancelGeneration();
    }
    onProgress(callback) { if (!isLocalAIAvailable()) return () => {}; return window.localAI.onProgress(callback); }
    onDownloadProgress(callback) { if (!isLocalAIAvailable()) return () => {}; return window.localAI.onDownloadProgress(callback); }
}

export const localAI = new LocalInferenceClient();
