import net from "node:net";

export function serverEndpoint(values = {}) {
  const requestedPort = Number(values["server-port"]);
  const port = Number.isSafeInteger(requestedPort) && requestedPort >= 1 && requestedPort <= 65535
    ? requestedPort
    : 25565;
  const configuredHost = String(values["server-ip"] || "").trim();
  return {
    port,
    host: configuredHost || "0.0.0.0",
    displayHost: configuredHost || "all network addresses",
  };
}

export function serverJoinAddress({ host, port }) {
  if (!host || !port) return "";
  if (host === "0.0.0.0") host = "localhost";
  if (host === "::") host = "::1";
  const address = net.isIP(host) === 6 ? "[" + host + "]" : host;
  return port === 25565 ? address : address + ":" + port;
}

export function probeServerPort(endpoint) {
  const { port, host } = endpoint;
  return new Promise((resolve, reject) => {
    const probe = net.createServer({ pauseOnConnect: true });
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    probe.once("error", (error) => {
      if (error?.code === "EADDRINUSE" || error?.code === "EACCES") {
        finish({ available: false, code: error.code, port, host });
        return;
      }
      reject(error);
    });
    probe.once("listening", () => {
      probe.close((error) => {
        if (error) reject(error);
        else finish({ available: true, port, host });
      });
    });
    probe.listen({ port, host, exclusive: true });
  });
}

export async function serverPortIsListening({ host, port }) {
  const address = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  const result = await new Promise(resolve => {
    const socket = net.createConnection({ host: address, port });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(1000, () => finish("timeout"));
    socket.once("error", error => finish(error.code));
    socket.once("connect", () => finish("connected"));
  });
  if (result === "connected") return true;
  // Some Windows app containers restrict connecting to a local listener.
  if (result !== "EACCES" && result !== "EPERM") return false;
  return (await probeServerPort({ host, port })).code === "EADDRINUSE";
}
