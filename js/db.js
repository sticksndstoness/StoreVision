/* StoreVision storage layer (window.SVDB).
 *
 * - IndexedDB is the primary store (survives much longer than localStorage and is not capped at ~5 MB).
 * - Falls back to localStorage if IndexedDB is unavailable, so the app still works (with fewer safeguards).
 * - Entries are never overwritten silently: every create / update / delete also appends an audit event holding the
 *   full before/after snapshot, so any change can be recovered from the event log or a backup.
 * - All writes are serialised and the in-memory "last persisted" snapshot only advances after a commit succeeds.
 */
(function (root) {
  'use strict';
  const C = root.SVCore;
  const DB_NAME = 'storevision', DB_VERSION = 1;
  const LEGACY_KEY = 'sv_inventory_log', LEGACY_DONE = 'sv_inventory_log_migrated', LEGACY_BAD = 'sv_inventory_log_corrupt';
  const DRAFT_LS = 'sv_draft', CRASH_LS = 'sv_crash';
  const MAX_EVENTS = 5000, MAX_CRASH = 50;

  let db = null, mode = 'none';
  let snapshot = new Map();         // id -> JSON of what is committed in the DB
  let queue = Promise.resolve();    // serialises writes
  let opening = null;
  const memCrash = [];

  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  };
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const txDone = (tx) => new Promise((res, rej) => {
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('Transaction aborted'));
  });

  function openIdb() {
    return new Promise((resolve, reject) => {
      if (!root.indexedDB) return reject(new Error('IndexedDB unavailable'));
      let r;
      try { r = root.indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { return reject(e); }
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('entries')) d.createObjectStore('entries', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('events')) d.createObjectStore('events', { keyPath: 'seq', autoIncrement: true });
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv', { keyPath: 'key' });
        if (!d.objectStoreNames.contains('crash')) d.createObjectStore('crash', { keyPath: 'seq', autoIncrement: true });
      };
      r.onsuccess = () => {
        const d = r.result;
        d.onversionchange = () => { d.close(); db = null; };   // another tab upgraded the schema
        d.onclose = () => { db = null; };                       // browser dropped the connection; reopened lazily
        resolve(d);
      };
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error('Database upgrade blocked by another tab. Close other StoreVision tabs.'));
    });
  }

  async function ensure() {
    if (mode === 'local') return;
    if (db) return;
    db = await openIdb();
  }

  async function pruneStore(name, max) {
    try {
      const tx = db.transaction(name, 'readwrite'); const st = tx.objectStore(name);
      const count = await req(st.count());
      let extra = count - max;
      if (extra > 0) {
        await new Promise((res, rej) => {
          const cur = st.openCursor();
          cur.onsuccess = () => { const c = cur.result; if (c && extra > 0) { c.delete(); extra--; c.continue(); } else res(); };
          cur.onerror = () => rej(cur.error);
        });
      }
      await txDone(tx);
    } catch (e) { /* pruning is best-effort */ }
  }

  /** One-time import of the v2 localStorage log into IndexedDB. The old copy is kept under a different key as a backup. */
  async function migrateLegacy() {
    const raw = ls.get(LEGACY_KEY);
    if (raw === null) return { imported: 0 };
    let list;
    try { list = JSON.parse(raw); if (!Array.isArray(list)) throw new Error('legacy log is not a list'); }
    catch (e) {
      ls.set(LEGACY_BAD, raw); ls.del(LEGACY_KEY);
      await logCrash(C.makeCrashRecord('migration', e, 'legacy log unreadable; raw copy kept under ' + LEGACY_BAD));
      return { imported: 0, corrupt: true };
    }
    const { entries } = C.sanitizeEntries(list);
    const fresh = entries.filter((e) => !snapshot.has(e.id));
    if (fresh.length) {
      const at = new Date().toISOString();
      const tx = db.transaction(['entries', 'events'], 'readwrite');
      fresh.forEach((e) => { tx.objectStore('entries').put(e); tx.objectStore('events').add({ type: 'import-legacy', entryId: e.id, at, after: e }); });
      await txDone(tx);
      fresh.forEach((e) => snapshot.set(e.id, JSON.stringify(e)));
    }
    ls.set(LEGACY_DONE, raw); ls.del(LEGACY_KEY);
    return { imported: fresh.length };
  }

  const SVDB = {};

  SVDB.mode = () => mode;

  /** Opens storage. Resolves {mode, migrated}. Never rejects: falls back to localStorage. */
  SVDB.open = function () {
    if (opening) return opening;
    opening = (async () => {
      try {
        db = await openIdb(); mode = 'idb';
        const rows = await req(db.transaction('entries').objectStore('entries').getAll());
        snapshot = new Map(rows.map((r) => [r && r.id, JSON.stringify(r)]));
        const m = await migrateLegacy();
        pruneStore('events', MAX_EVENTS); pruneStore('crash', MAX_CRASH);
        return { mode, migrated: m.imported || 0, corrupt: !!m.corrupt };
      } catch (e) {
        db = null; mode = 'local';
        return { mode, migrated: 0, error: String(e && e.message || e) };
      }
    })();
    return opening;
  };

  /**
   * Returns all entries, newest first, sanitised. Rows that cannot be repaired are skipped (never thrown on).
   * Runs through the write queue and re-syncs the committed snapshot, so changes made by another tab are picked up safely.
   */
  SVDB.loadEntries = function () {
    const run = async () => {
      let raw = [];
      if (mode === 'idb') {
        await ensure(); raw = await req(db.transaction('entries').objectStore('entries').getAll());
        snapshot = new Map(raw.filter((r) => r && r.id).map((r) => [r.id, JSON.stringify(r)]));
      } else { try { raw = JSON.parse(ls.get(LEGACY_KEY) || '[]'); } catch (e) { raw = []; } }
      const { entries, dropped } = C.sanitizeEntries(raw);
      entries.sort((a, b) => (a.isoTime < b.isoTime ? 1 : a.isoTime > b.isoTime ? -1 : 0));
      return { entries, dropped };
    };
    queue = queue.then(run, run);
    return queue;
  };

  /** Persist the current list: writes only what changed and appends audit events. Resolves when committed. */
  SVDB.saveDiff = function (list) {
    const run = async () => {
      const norm = list.map(C.sanitizeEntry).filter(Boolean);
      if (mode === 'local') {
        if (!ls.set(LEGACY_KEY, JSON.stringify(norm))) throw new Error('Device storage is full or blocked.');
        return;
      }
      await ensure();
      const d = C.diffEntries(snapshot, norm);
      if (!d.puts.length && !d.deletes.length) return;
      const tx = db.transaction(['entries', 'events'], 'readwrite');
      const es = tx.objectStore('entries'), ev = tx.objectStore('events');
      d.puts.forEach((e) => es.put(e)); d.deletes.forEach((id) => es.delete(id)); d.events.forEach((e) => ev.add(e));
      await txDone(tx);
      d.puts.forEach((e) => snapshot.set(e.id, JSON.stringify(e))); d.deletes.forEach((id) => snapshot.delete(id));
      if (d.events.length && Math.random() < 0.02) pruneStore('events', MAX_EVENTS);
    };
    queue = queue.then(run, run);
    return queue;
  };

  /* ---------- drafts (work in progress) ---------- */
  SVDB.saveDraft = async function (draft) {
    if (mode === 'idb') {
      await ensure();
      const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put({ key: 'draft', value: draft, at: Date.now() });
      return txDone(tx);
    }
    if (!ls.set(DRAFT_LS, JSON.stringify(draft))) {                 // image too big for localStorage: keep the text fields at least
      const slim = { ...draft, stackDataUrl: null };
      if (!ls.set(DRAFT_LS, JSON.stringify(slim))) throw new Error('Cannot save draft');
    }
  };
  SVDB.loadDraft = async function () {
    if (mode === 'idb') { await ensure(); const r = await req(db.transaction('kv').objectStore('kv').get('draft')); return r ? r.value : null; }
    try { return JSON.parse(ls.get(DRAFT_LS) || 'null'); } catch (e) { return null; }
  };
  SVDB.clearDraft = async function () {
    if (mode === 'idb') { await ensure(); const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').delete('draft'); return txDone(tx); }
    ls.del(DRAFT_LS);
  };

  /* ---------- generic small values ---------- */
  SVDB.getMeta = async function (key) {
    if (mode === 'idb') { await ensure(); const r = await req(db.transaction('kv').objectStore('kv').get('meta:' + key)); return r ? r.value : null; }
    try { return JSON.parse(ls.get('sv_meta_' + key) || 'null'); } catch (e) { return null; }
  };
  SVDB.setMeta = async function (key, value) {
    if (mode === 'idb') { await ensure(); const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put({ key: 'meta:' + key, value }); return txDone(tx); }
    ls.set('sv_meta_' + key, JSON.stringify(value));
  };

  /* ---------- crash log ---------- */
  async function logCrash(rec) {
    memCrash.push(rec); if (memCrash.length > MAX_CRASH) memCrash.shift();
    try {
      if (mode === 'idb') {
        await ensure(); const tx = db.transaction('crash', 'readwrite'); tx.objectStore('crash').add(rec); await txDone(tx);
        if (memCrash.length % 10 === 0) pruneStore('crash', MAX_CRASH);
      } else ls.set(CRASH_LS, JSON.stringify(memCrash));
    } catch (e) { /* the crash logger must never throw */ }
  }
  SVDB.logCrash = logCrash;
  SVDB.getCrashLog = async function () {
    try {
      if (mode === 'idb') { await ensure(); return await req(db.transaction('crash').objectStore('crash').getAll()); }
      return JSON.parse(ls.get(CRASH_LS) || '[]');
    } catch (e) { return memCrash.slice(); }
  };
  SVDB.clearCrashLog = async function () {
    memCrash.length = 0;
    if (mode === 'idb') { await ensure(); const tx = db.transaction('crash', 'readwrite'); tx.objectStore('crash').clear(); return txDone(tx); }
    ls.del(CRASH_LS);
  };

  /* ---------- backup / restore ---------- */
  SVDB.exportAll = async function () {
    const { entries } = await SVDB.loadEntries();
    let events = [];
    if (mode === 'idb') { await ensure(); events = await req(db.transaction('events').objectStore('events').getAll()); }
    return C.makeBackup(entries, events, { storageMode: mode });
  };

  /** Adds entries from a validated backup that are not already present. Existing data is never overwritten. */
  SVDB.importBackup = async function (parsed) {
    const { entries: have } = await SVDB.loadEntries();
    const { add, skipped } = C.mergeBackup(have, parsed.entries);
    if (mode === 'idb' && add.length) {
      await ensure(); const at = new Date().toISOString();
      const tx = db.transaction(['entries', 'events'], 'readwrite');
      add.forEach((e) => { tx.objectStore('entries').put(e); tx.objectStore('events').add({ type: 'restore', entryId: e.id, at, after: e }); });
      await txDone(tx); add.forEach((e) => snapshot.set(e.id, JSON.stringify(e)));
    } else if (mode === 'local' && add.length) {
      ls.set(LEGACY_KEY, JSON.stringify(have.concat(add)));
    }
    return { added: add.length, skipped, dropped: parsed.dropped || 0 };
  };

  /* ---------- storage health ---------- */
  SVDB.requestPersistence = async function () {
    try { if (root.navigator.storage && root.navigator.storage.persist) return await root.navigator.storage.persist(); } catch (e) { /* ignore */ }
    return false;
  };
  SVDB.storageInfo = async function () {
    const out = { mode, persisted: null, usageMB: null, quotaMB: null };
    try {
      const s = root.navigator.storage;
      if (s && s.persisted) out.persisted = await s.persisted();
      if (s && s.estimate) { const e = await s.estimate(); out.usageMB = Math.round((e.usage || 0) / 1048576 * 10) / 10; out.quotaMB = Math.round((e.quota || 0) / 1048576); }
    } catch (e) { /* ignore */ }
    return out;
  };

  root.SVDB = SVDB;
})(typeof self !== 'undefined' ? self : this);
