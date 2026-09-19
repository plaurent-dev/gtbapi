const pino = require("pino");
const config = require("./config");

const logger = pino({
  level: config.LOG_LEVEL,
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime
});

module.exports = logger;
