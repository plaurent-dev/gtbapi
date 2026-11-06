const grpc = require("@grpc/grpc-js");
const { GatewayServiceClient } = require("@chirpstack/chirpstack-api/api/gateway_grpc_pb");
const { ApplicationServiceClient } = require("@chirpstack/chirpstack-api/api/application_grpc_pb");
const { DeviceServiceClient } = require("@chirpstack/chirpstack-api/api/device_grpc_pb");
const { ListGatewaysRequest, GatewayState } = require("@chirpstack/chirpstack-api/api/gateway_pb");
const { ListApplicationsRequest } = require("@chirpstack/chirpstack-api/api/application_pb");
const { ListDevicesRequest } = require("@chirpstack/chirpstack-api/api/device_pb");

const pageSize = 100;
const limit = 10000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const eui = /^[0-9a-f]{16}$/;
class InventoryValidationError extends Error {}
function checked(value, pattern, field) {
  if (typeof value !== "string" || !pattern.test(value)) throw new InventoryValidationError(`Invalid ChirpStack ${field}`);
  return value;
}
function name(value, field) {
  if (typeof value !== "string" || !value.trim() || value.length > 255) throw new InventoryValidationError(`Invalid ChirpStack ${field}`);
  return value.trim();
}
function timestamp(value) {
  if (!value) return null;
  const date = value.toDate();
  if (!Number.isFinite(date.getTime())) throw new InventoryValidationError("Invalid ChirpStack timestamp");
  return date.toISOString();
}

function createClients(config) {
  const credentials = config.apiTls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
  const clients = {};
  try {
    clients.gateway = new GatewayServiceClient(config.apiServer, credentials);
    clients.application = new ApplicationServiceClient(config.apiServer, credentials);
    clients.device = new DeviceServiceClient(config.apiServer, credentials);
    return clients;
  } catch (error) {
    for (const client of Object.values(clients)) client.close();
    throw error;
  }
}

async function pages(client, Request, scopeMethod, scope, metadata) {
  const items = [];
  let total;
  for (;;) {
    const request = new Request();
    request.setLimit(pageSize);
    request.setOffset(items.length);
    request[scopeMethod](scope);
    const response = await new Promise((resolve, reject) => {
      client.list(request, metadata, { deadline: new Date(Date.now() + 10000) },
        (error, value) => error ? reject(error) : resolve(value));
    });
    const count = response.getTotalCount(), rows = response.getResultList();
    if (!Number.isInteger(count) || count > limit || (total !== undefined && count !== total)
      || rows.length > pageSize || items.length + rows.length > count || (!rows.length && items.length < count)) {
      throw new InventoryValidationError("ChirpStack inventory changed during pagination or exceeds the limit");
    }
    total = count;
    items.push(...rows);
    if (items.length === total) return items;
  }
}

async function fetchSnapshot(clients, config) {
  const metadata = new grpc.Metadata();
  metadata.set("authorization", `Bearer ${config.apiToken}`);
  const [gatewayRows, appRows] = await Promise.all([
    pages(clients.gateway, ListGatewaysRequest, "setTenantId", config.tenantId, metadata),
    pages(clients.application, ListApplicationsRequest, "setTenantId", config.tenantId, metadata)
  ]);
  const gateways = gatewayRows.map(row => {
    if (row.getTenantId() !== config.tenantId) throw new InventoryValidationError("Gateway tenant mismatch");
    const state = { [GatewayState.NEVER_SEEN]: "never_seen", [GatewayState.ONLINE]: "online",
      [GatewayState.OFFLINE]: "offline" }[row.getState()];
    if (!state) throw new InventoryValidationError("Unknown ChirpStack gateway state");
    return { eui: checked(row.getGatewayId(), eui, "gateway EUI"), name: name(row.getName(), "gateway name"),
      description: row.getDescription(), lastSeen: timestamp(row.getLastSeenAt()), state };
  });
  const applications = appRows.map(row => ({ id: checked(row.getId(), uuid, "application ID"),
    name: name(row.getName(), "application name") }));
  const devices = [];
  for (const app of applications) {
    const rows = await pages(clients.device, ListDevicesRequest, "setApplicationId", app.id, metadata);
    for (const row of rows) devices.push({
      eui: checked(row.getDevEui(), eui, "device EUI"), name: name(row.getName(), "device name"),
      description: row.getDescription(), applicationId: app.id, applicationName: app.name,
      profileId: checked(row.getDeviceProfileId(), uuid, "profile ID"),
      profileName: name(row.getDeviceProfileName(), "profile name"), lastSeen: timestamp(row.getLastSeenAt())
    });
    if (devices.length > limit) throw new InventoryValidationError("ChirpStack device inventory exceeds the limit");
  }
  for (const rows of [gateways, applications, devices]) {
    if (new Set(rows.map(row => row.eui || row.id)).size !== rows.length) throw new InventoryValidationError("Duplicate ChirpStack inventory identifier");
  }
  return { gateways, devices };
}

async function storeSnapshot(pool, tenantId, snapshot) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE public.gtb_lorawan_gateways SET present = false, synced_at = now() WHERE tenant_id = $1", [tenantId]);
    await client.query("UPDATE public.gtb_lorawan_devices SET present = false, synced_at = now() WHERE tenant_id = $1", [tenantId]);
    for (const row of snapshot.gateways) {
      await client.query(`INSERT INTO public.gtb_lorawan_gateways
        (tenant_id,gateway_eui,name,description,last_seen_at,state,present,synced_at)
        VALUES ($1,$2,$3,$4,$5,$6,true,now())
        ON CONFLICT (tenant_id,gateway_eui) DO UPDATE SET
          name=EXCLUDED.name,description=EXCLUDED.description,last_seen_at=EXCLUDED.last_seen_at,
          state=EXCLUDED.state,present=true,synced_at=now()`,
      [tenantId, row.eui, row.name, row.description, row.lastSeen, row.state]);
    }
    for (const row of snapshot.devices) {
      await client.query(`INSERT INTO public.gtb_lorawan_devices
        (tenant_id,dev_eui,application_id,application_name,profile_id,profile_name,name,description,last_seen_at,present,synced_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,now())
        ON CONFLICT (tenant_id,dev_eui) DO UPDATE SET
          application_id=EXCLUDED.application_id,application_name=EXCLUDED.application_name,
          profile_id=EXCLUDED.profile_id,profile_name=EXCLUDED.profile_name,name=EXCLUDED.name,
          description=EXCLUDED.description,last_seen_at=EXCLUDED.last_seen_at,present=true,synced_at=now()`,
      [tenantId, row.eui, row.applicationId, row.applicationName, row.profileId, row.profileName,
        row.name, row.description, row.lastSeen]);
    }
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (rollbackError) { error.rollbackError = rollbackError; }
    throw error;
  } finally { client.release(); }
}

module.exports = { createClients, fetchSnapshot, storeSnapshot, pages, InventoryValidationError };
