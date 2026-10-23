require("dotenv").config();

const app = require("./app");
const config = require("./config");
const logger = require("./logger");
const { readMeter } = require("./modbus");
const { publishMeasurements, closePublishers } = require("./publisher");

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, "GTB API listening");
});

let poller;
if (config.POLL_INTERVAL_MS > 0 && config.MODBUS_HOST) {
  logger.info(
    { host: config.MODBUS_HOST, everyMs: config.POLL_INTERVAL_MS },
    "Background polling enabled"
  );

  poller = setInterval(async () => {
    try {
      const data = await readMeter({ host: config.MODBUS_HOST });
      publishMeasurements(data);
    } catch (err) {
      logger.warn({ err }, "Polling failed");
    }
  }, config.POLL_INTERVAL_MS);
}

async function shutdown(signal) {
  logger.info({ signal }, "Shutting down");

  if (poller) {
    clearInterval(poller);
  }

  closePublishers();

  server.close(async (err) => {
    if (err) {
      logger.error({ err }, "Error while closing server");
      process.exit(1);
      return;
    }
    try {
      const results = await Promise.allSettled([
        app.locals.profileInventoryPool?.end(),
        app.locals.measurementsPool?.end()
      ]);
      const failure = results.find(result => result.status === "rejected");
      if (failure) throw failure.reason;
    } catch (error) {
      logger.error({ err: error }, "Error while closing PostgreSQL pools");
      process.exit(1);
      return;
    }
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
 