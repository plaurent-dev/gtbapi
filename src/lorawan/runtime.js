const { z } = require("zod");
const { Pool } = require("pg");
const mqtt = require("mqtt");
const { createClients, fetchSnapshot, storeSnapshot, InventoryValidationError } = require("./inventory");
const { parseUplink, storeUplink, UplinkConflictError } = require("./events");

const schema = z.object({
  LORAWAN_TENANT_ID: z.uuid(),
  LORAWAN_API_SERVER: z.string().regex(/^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):[0-9]{1,5}$/),
  LORAWAN_API_TOKEN: z.string().min(1).max(2048),
  LORAWAN_API_TLS: z.enum(["true", "false"]).default("true"),
  LORAWAN_MQTT_URL: z.string().url(),
  LORAWAN_MQTT_USERNAME: z.string().default(""),
  LORAWAN_MQTT_PASSWORD: z.string().default(""),
  LORAWAN_MQTT_CLIENT_ID: z.string().max(128).default(""),
  LORAWAN_SYNC_INTERVAL_MS: z.coerce.number().int().min(30000).max(3600000).default(60000),
  LORAWAN_LDS02_PROFILE_IDS: z.string().default("")
});

function parseConfig(env, pgConfig) {
  if (!env.LORAWAN_ENABLED || env.LORAWAN_ENABLED === "false") return null;
  if (env.LORAWAN_ENABLED !== "true") throw new Error("LORAWAN_ENABLED must be true or false");
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid LoRaWAN configuration: ${parsed.error.issues.map(issue => issue.path.join(".")).join(", ")}`);
  if (!pgConfig.PGUSER) throw new Error("LoRaWAN requires PGUSER");
  const value = parsed.data;
  const url = new URL(value.LORAWAN_MQTT_URL);
  if (!["mqtt:", "mqtts:"].includes(url.protocol) || url.username || url.password
    || !url.hostname || (url.port && (Number(url.port) < 1 || Number(url.port) > 65535))
    || (url.pathname && url.pathname !== "/") || url.search || url.hash) {
    throw new Error("LORAWAN_MQTT_URL must be mqtt(s) without embedded credentials");
  }
  const apiPort = Number(value.LORAWAN_API_SERVER.slice(value.LORAWAN_API_SERVER.lastIndexOf(":") + 1));
  if (apiPort < 1 || apiPort > 65535) throw new Error("Invalid LORAWAN_API_SERVER port");
  if (value.LORAWAN_MQTT_PASSWORD && !value.LORAWAN_MQTT_USERNAME) throw new Error("LORAWAN_MQTT_USERNAME required with password");
  const ids = value.LORAWAN_LDS02_PROFILE_IDS.split(",").map(id => id.trim().toLowerCase()).filter(Boolean);
  if (ids.some(id => !z.uuid().safeParse(id).success)) throw new Error("Invalid LORAWAN_LDS02_PROFILE_IDS");
  const tenantId = value.LORAWAN_TENANT_ID.toLowerCase();
  return {
    tenantId, apiServer: value.LORAWAN_API_SERVER, apiToken: value.LORAWAN_API_TOKEN,
    apiTls: value.LORAWAN_API_TLS === "true", mqttUrl: value.LORAWAN_MQTT_URL,
    mqttUsername: value.LORAWAN_MQTT_USERNAME, mqttPassword: value.LORAWAN_MQTT_PASSWORD,
    mqttClientId: value.LORAWAN_MQTT_CLIENT_ID || `gtbapi-${tenantId.slice(0, 8)}`,
    syncInterval: value.LORAWAN_SYNC_INTERVAL_MS, lds02ProfileIds: ids
  };
}

function createRuntime(env, pgConfig, logger, { connectMqtt = mqtt.connect } = {}) {
  const status = { enabled: false, mqttConnected: false, lastSync: null, lastEvent: null,
    error: null, syncError: null, ingestionError: null };
  let config;
  try { config = parseConfig(env, pgConfig); }
  catch (error) {
    status.enabled = true;
    status.error = error.message;
    logger.error({ message: error.message }, "LoRaWAN configuration invalid");
    return { status, close: async () => {} };
  }
  if (!config) return { status, close: async () => {} };
  status.enabled = true;
  let pool, clients, client;
  try {
    pool = new Pool({ host: pgConfig.PGHOST, port: pgConfig.PGPORT, database: pgConfig.PGDATABASE,
      user: pgConfig.PGUSER, password: pgConfig.PGPASSWORD, max: 2, connectionTimeoutMillis: 5000,
      statement_timeout: 10000, query_timeout: 12000, allowExitOnIdle: true,
      options: "-c default_transaction_read_only=off" });
    pool.on("error", error => logger.error({ code: error.code || error.name }, "LoRaWAN database connection failed"));
    clients = createClients(config);
    client = connectMqtt(config.mqttUrl, {
      username: config.mqttUsername || undefined, password: config.mqttPassword || undefined,
      clientId: config.mqttClientId, clean: false, protocolVersion: 4, reconnectPeriod: 5000,
      resubscribe: false
    });
  } catch (error) {
    status.error = "Initialisation LoRaWAN impossible";
    logger.error({ code: error?.code || error?.name || "UnknownError" }, "LoRaWAN initialization failed");
    for (const value of Object.values(clients || {})) value.close();
    const cleanup = pool ? pool.end() : Promise.resolve();
    void cleanup.catch(cleanupError => logger.error(
      { code: cleanupError.code || cleanupError.name }, "LoRaWAN database cleanup failed"));
    return { status, async close() { await cleanup; } };
  }
  let syncing = false, closing = false;
  async function synchronize() {
    if (syncing || closing) return;
    syncing = true;
    try {
      const snapshot = await fetchSnapshot(clients, config);
      if (closing) return;
      await storeSnapshot(pool, config.tenantId, snapshot);
      status.lastSync = new Date().toISOString();
      status.syncError = null;
      logger.info({ gateways: snapshot.gateways.length, devices: snapshot.devices.length }, "LoRaWAN inventory synchronized");
    } catch (error) {
      status.syncError = "Synchronisation ChirpStack impossible";
      logger.error({ code: error.code || error.name,
        message: error instanceof InventoryValidationError ? error.message : undefined }, "LoRaWAN inventory synchronization failed");
    } finally { syncing = false; }
  }
  const timer = setInterval(synchronize, config.syncInterval);
  void synchronize();
  client.on("connect", () => {
    client.subscribe("application/+/device/+/event/up", { qos: 1 }, (error, grants) => {
      if (error || grants.some(grant => grant.qos === 128)) {
        status.mqttConnected = false;
        logger.error({ code: error?.code || error?.name }, "LoRaWAN MQTT subscription rejected");
        client.stream.destroy();
        return;
      }
      status.mqttConnected = true;
      logger.info("LoRaWAN MQTT subscribed");
    });
  });
  client.on("close", () => { status.mqttConnected = false; });
  client.on("error", error => logger.error({ code: error.code || error.name }, "LoRaWAN MQTT error"));
  client.handleMessage = (packet, done) => {
    let event;
    try { event = parseUplink(packet.topic, packet.payload, config.tenantId, config.lds02ProfileIds); }
    catch (error) {
      status.ingestionError = "Une trame MQTT invalide a ete refusee";
      logger.warn({ message: error.message }, "Rejected LoRaWAN uplink");
      done();
      return;
    }
    if (event.status === "invalid") logger.warn({ devEui: event.devEui, message: event.error }, "Invalid LoRaWAN payload");
    storeUplink(pool, event).then(inserted => {
      if (inserted) status.lastEvent = new Date().toISOString();
      status.ingestionError = null;
      done();
    }, error => {
      if (error instanceof UplinkConflictError) {
        status.ingestionError = "Deux trames differentes partagent le meme identifiant";
        logger.error({ devEui: event.devEui }, "Conflicting LoRaWAN deduplication ID");
        done();
        return;
      }
      status.ingestionError = "Enregistrement MQTT impossible";
      logger.error({ code: error.code || error.name }, "LoRaWAN uplink storage failed");
      client.stream.destroy();
      done(error);
    });
  };
  return { status, async close() {
    closing = true;
    clearInterval(timer);
    await client.endAsync(true);
    for (const value of Object.values(clients)) value.close();
    while (syncing) await new Promise(resolve => setTimeout(resolve, 50));
    await pool.end();
  } };
}

module.exports = { createRuntime, parseConfig };
