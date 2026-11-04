import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { probeServerPort, serverEndpoint } from "../src/lib/server-port.mjs";

test("server endpoint uses Minecraft defaults and accepts configured values", () => {
  assert.deepEqual(serverEndpoint({}), {
    port: 25565,
    host: "0.0.0.0",
    displayHost: "all network addresses",
  });
  assert.deepEqual(serverEndpoint({ "server-port": 25570, "server-ip": "127.0.0.1" }), {
    port: 25570,
    host: "127.0.0.1",
    displayHost: "127.0.0.1",
  });
});

test("port probe detects an external listener and succeeds after it closes", async () => {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const port = listener.address().port;

  const occupied = await probeServerPort({ port, host: "127.0.0.1" });
  assert.equal(occupied.available, false);
  assert.equal(occupied.code, "EADDRINUSE");

  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  const available = await probeServerPort({ port, host: "127.0.0.1" });
  assert.equal(available.available, true);
});
