import assert from "node:assert/strict";
import test from "node:test";
import {
  getActiveOperations,
  getServerOperation,
  ServerBusyError,
  subscribeOperations,
  updateOperation,
  waitForOperations,
  withServerOperation,
} from "../src/lib/operation-manager.mjs";

test("withServerOperation prevents overlapping changes and always releases its lock", async () => {
  const snapshots = [];
  const unsubscribe = subscribeOperations((operations) => snapshots.push(operations));
  let release;
  const pending = withServerOperation(42, "exporting", () => new Promise((resolve) => {
    release = resolve;
  }));
  assert.equal(getServerOperation(42), "exporting");
  assert.equal(getActiveOperations()[0].serverId, 42);
  assert.equal(getActiveOperations()[0].cancellable, false);
  assert.equal(updateOperation(getActiveOperations()[0].id, { stage: "archive", percent: 50, description: "Creating archive" }), true);
  assert.equal(getActiveOperations()[0].percent, 50);
  const idle = waitForOperations();
  await assert.rejects(
    withServerOperation(42, "deleting", async () => {}),
    (error) => error instanceof ServerBusyError && error.operation === "exporting"
  );
  release("done");
  assert.equal(await pending, "done");
  await idle;
  assert.equal(getServerOperation(42), null);

  await assert.rejects(withServerOperation(42, "failing", async () => {
    throw new Error("failure");
  }), /failure/);
  assert.equal(getServerOperation(42), null);
  assert(snapshots.some((operations) => operations.some((operation) => operation.label === "exporting")));
  unsubscribe();
});
