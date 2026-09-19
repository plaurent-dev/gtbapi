const dgram = require("dgram");
const mqtt = require("mqtt");
const config = require("./config");
const logger = require("./logger");

let mqttClient;

function getMqttClient() {
  if (!config.MQTT_ENABLED) {
    return null;
  }

  if (!mqttClient) {
    mqttClient = mqtt.connect(config.MQTT_URL);
    mqttClient.on("connect", () => logger.info({ broker: config.MQTT_URL }, "MQTT connected"));
    mqttClient.on("error", (err) => logger.warn({ err }, "MQTT connection error"));
  }

  return mqttClient;
}

function sendGelf(message) {
  if (!config.GELF_ENABLED) {
    return;
  }

  const socket = dgram.createSocket("udp4");
  const gelf = {
    version: "1.1",
    host: "modbus-reader-api",
    short_message: "Modbus measurement",
    level: 6
  };

  for (const [key, value] of Object.entries(message)) {
    gelf[`_${key}`] = value;
  }

  const payload = Buffer.from(JSON.stringify(gelf), "utf8");

  socket.send(payload, config.GELF_PORT, config.GELF_HOST, (err) => {
    socket.close();
    if (err) {
      logger.warn({ err }, "Failed to send GELF packet");
    }
  });
}

function publishMeasurements(message) {
  const client = getMqttClient();
  if (client) {
    client.publish(config.MQTT_TOPIC, JSON.stringify(message), { qos: 0 }, (err) => {
      if (err) {
        logger.warn({ err }, "MQTT publish failed");
      }
    });
  }

  sendGelf(message);
}

function closePublishers() {
  if (mqttClient) {
    mqttClient.end(true);
    mqttClient = undefined;
  }
}

module.exports = {
  publishMeasurements,
  closePublishers
};
