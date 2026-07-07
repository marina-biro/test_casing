// Privremeni sloj za podatke (korak 1).
// Imitira window.storage API iz Claude artifact okruzenja preko localStorage-a,
// tako da QATestCaseTool radi lokalno bez ikakvih izmena.
// U koraku 2-4 ovaj fajl se menja Supabase implementacijom - komponenta ostaje ista.

const PREFIX = "qa-tc:";

window.storage = {
  async get(key) {
    const v = localStorage.getItem(PREFIX + key);
    if (v === null) throw new Error("Key not found: " + key);
    return { key, value: v, shared: false };
  },
  async set(key, value) {
    localStorage.setItem(PREFIX + key, value);
    return { key, value, shared: false };
  },
  async delete(key) {
    localStorage.removeItem(PREFIX + key);
    return { key, deleted: true, shared: false };
  },
  async list(prefix = "") {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith(PREFIX + prefix)) keys.push(k.slice(PREFIX.length));
    }
    return { keys, prefix, shared: false };
  },
};
