import { hostBridge } from "./host-bridge";

export async function installPreferences() {
    const prefix = "upstream-pref:";
    const saved = await hostBridge.storageList();
    const preferences = new Map(Object.entries(saved)
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => [key.slice(prefix.length), value]));
    const ignoredFailure = () => { console.warn("Canvas preferences could not be saved."); };
    const scopedStorage: Storage = {
        get length() { return preferences.size; },
        getItem: key => preferences.get(key) ?? null,
        key: index => [...preferences.keys()][index] ?? null,
        setItem(key, value) {
            preferences.set(key, value);
            void hostBridge.storageSet(prefix + key, value).catch(ignoredFailure);
        },
        removeItem(key) {
            preferences.delete(key);
            void hostBridge.storageRemove(prefix + key).catch(ignoredFailure);
        },
        clear() {
            for (const key of preferences.keys()) scopedStorage.removeItem(key);
        },
    };
    Object.defineProperty(window, "localStorage", { value: scopedStorage });
}
