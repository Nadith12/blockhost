import { attachErrorGroup } from "./console-log.mjs";

// Keep only the current snapshot and a bounded set of rendered rows. IPC sends
// fresh objects on every poll, so object identity alone cannot detect changes.
export function createConsoleViewCache(normalizeEntry, renderEntry, capacity = 2000) {
  let snapshotKey = null;
  let snapshot = [];
  const rows = new Map();
  return {
    entries(logs, scope) {
      const key = JSON.stringify([scope, logs]);
      if (key !== snapshotKey) {
        const grouping = {};
        const next = [];
        for (const [index, value] of logs.entries()) {
          const entry = normalizeEntry(value, index, next.at(-1)?.occurredAt || "");
          next.push(attachErrorGroup({ ...entry, errorGroupId: "" }, grouping));
        }
        snapshot = next;
        snapshotKey = key;
      }
      return snapshot;
    },
    row(entry) {
      const key = JSON.stringify(entry);
      if (!rows.has(key)) {
        rows.set(key, renderEntry(entry));
        if (rows.size > capacity) rows.delete(rows.keys().next().value);
      }
      return rows.get(key);
    },
  };
}
