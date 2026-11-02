import crypto from "node:crypto";

const activeOperations = new Map();
const listeners = new Set();
const idleWaiters = new Set();

function snapshot() {
  return Array.from(activeOperations.values()).map((operation) => ({ ...operation }));
}

function notify() {
  const operations = snapshot();
  listeners.forEach((listener) => listener(operations));
  if (!operations.length) {
    idleWaiters.forEach((resolve) => resolve());
    idleWaiters.clear();
  }
}

export class ServerBusyError extends Error {
  constructor(serverId, operation) {
    super(`This server is currently ${operation}. Wait for that operation to finish and try again.`);
    this.name = "ServerBusyError";
    this.code = "SERVER_BUSY";
    this.serverId = serverId;
    this.operation = operation;
  }
}

export function getServerOperation(serverId) {
  return activeOperations.get(Number(serverId))?.label || null;
}

export function getActiveOperations() {
  return snapshot();
}

export function subscribeOperations(listener) {
  listeners.add(listener);
  listener(snapshot());
  return () => listeners.delete(listener);
}

export function waitForOperations() {
  if (!activeOperations.size) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.add(resolve));
}

export function updateOperation(operationId, changes = {}) {
  const entry = Array.from(activeOperations.values()).find((operation) => operation.id === operationId);
  if (!entry) return false;
  if (changes.stage !== undefined) entry.stage = String(changes.stage || "working");
  if (changes.description !== undefined) entry.description = String(changes.description || entry.label);
  if (changes.percent === null) entry.percent = null;
  else if (changes.percent !== undefined) entry.percent = Math.max(0, Math.min(100, Number(changes.percent) || 0));
  if (changes.cancellable !== undefined) entry.cancellable = Boolean(changes.cancellable);
  notify();
  return true;
}

export async function withServerOperation(serverId, operation, task) {
  const id = Number(serverId);
  const current = activeOperations.get(id);
  if (current) throw new ServerBusyError(id, current.label);

  const descriptor = typeof operation === "object" && operation ? operation : { label: operation };
  const label = String(descriptor.label || descriptor.description || "working");
  const entry = {
    id: crypto.randomUUID(),
    serverId: id,
    feature: String(descriptor.feature || label.split(/\s+/)[0] || "server"),
    label,
    stage: String(descriptor.stage || "working"),
    percent: descriptor.percent === undefined ? null : Math.max(0, Math.min(100, Number(descriptor.percent) || 0)),
    description: String(descriptor.description || label),
    cancellable: Boolean(descriptor.cancellable),
    startedAt: new Date().toISOString(),
  };
  activeOperations.set(id, entry);
  notify();
  try {
    return await task(entry);
  } finally {
    if (activeOperations.get(id)?.id === entry.id) activeOperations.delete(id);
    notify();
  }
}
