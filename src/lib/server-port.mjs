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
