const net = require("net");
const config = require("./config");
const { probeMeter } = require("./modbus");

function isPortOpen(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;

    const finish = (result) => {
      if (done) {
        return;
      }
      done = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);

    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));

    socket.connect(port, host);
  });
}

async function runWithConcurrency(items, concurrency, worker) {
  const results = [];
  let currentIndex = 0;

  async function runWorker() {
    while (true) {
      const idx = currentIndex;
      currentIndex += 1;
      if (idx >= items.length) {
        return;
      }

      const item = items[idx];
      const result = await worker(item);
      if (result !== null && result !== undefined) {
        results.push(result);
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker());
  await Promise.all(workers);
  return results;
}

async function discoverMeters({
  subnet = config.DEFAULT_SUBNET,
  from = config.DISCOVERY_FROM,
  to = config.DISCOVERY_TO,
  port = config.DISCOVERY_PORT,
  unitId = config.MODBUS_UNIT_ID,
  timeoutMs = config.DISCOVERY_TIMEOUT_MS,
  concurrency = config.DISCOVERY_CONCURRENCY,
  verifyModbus = true
}) {
  if (from > to) {
    throw new Error("Invalid range: from must be <= to");
  }

  const suffixes = [];
  for (let i = from; i <= to; i += 1) {
    suffixes.push(i);
  }

  return runWithConcurrency(suffixes, concurrency, async (suffix) => {
    const host = `${subnet}.${suffix}`;
    const open = await isPortOpen(host, port, timeoutMs);
    if (!open) {
      return null;
    }

    if (!verifyModbus) {
      return { host, port, modbusVerified: false };
    }

    try {
      const serial = await probeMeter({ host, port, unitId, timeoutMs });
      return {
        host,
        port,
        modbusVerified: true,
        serial_number: serial
      };
    } catch (_err) {
      return {
        host,
        port,
        modbusVerified: false
      };
    }
  });
}

module.exports = {
  discoverMeters
};
