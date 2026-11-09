const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { parseUplink, storeUplink } = require("../src/lorawan/events");
const { decodeUplink } = require("../src/lorawan/codec");
const { parseConfig, createRuntime } = require("../src/lorawan/runtime");
const { pages, fetchSnapshot, storeSnapshot, createClients } = require("../src/lorawan/inventory");
const grpc = require("@grpc/grpc-js");
const { Pool } = require("pg");
const { ListGatewaysRequest, GatewayListItem, ListGatewaysResponse, GatewayState } = require("@chirpstack/chirpstack-api/api/gateway_pb");
const { ApplicationListItem, ListApplicationsResponse } = require("@chirpstack/chirpstack-api/api/application_pb");
const { DeviceListItem, ListDevicesResponse } = require("@chirpstack/chirpstack-api/api/device_pb");
const { GatewayServiceService } = require("@chirpstack/chirpstack-api/api/gateway_grpc_pb");
const { ApplicationServiceService } = require("@chirpstack/chirpstack-api/api/application_grpc_pb");
const { DeviceServiceService } = require("@chirpstack/chirpstack-api/api/device_grpc_pb");

const tenant = "11111111-1111-4111-8111-111111111111";
const app = "22222222-2222-4222-8222-222222222222";
const profile = "33333333-3333-4333-8333-333333333333";
const dev = "a840000000000001";
const gateway = "a840000000000002";
const topic = `application/${app}/device/${dev}/event/up`;
const base = {
  deduplicationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", time: "2026-11-06T08:11:26.716793+00:00",
  deviceInfo: { tenantId: tenant, applicationId: app, deviceProfileId: profile, deviceProfileName: "Dragino-LDS02", devEui: dev },
  fPort: 10, data: "DH4BAAABAAAAAA==",
  object: { door_open: 0, battery_voltage: 3.198, door_open_count: 1, last_open_duration: 0, alarm: 0 },
  rxInfo: [{ gatewayId: gateway, rssi: -45, snr: 14.8 }]
};
const parse = (input = base, selectedTopic = topic) => parseUplink(selectedTopic, Buffer.from(JSON.stringify(input)), tenant);

test("LDS02 measurements come exclusively from ChirpStack object with historical units and source timestamps", () => {
  const closed = parse();
  const opened = parse({ ...base, object: { ...base.object, door_open: 1, battery_voltage: 3.054 },
    deduplicationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
  assert.equal(opened.status, "decoded");
  assert.deepEqual(opened.bytes, closed.bytes);
  assert.equal(closed.measurements.find(item => item.name === "door_open").value, 0);
  assert.equal(opened.measurements.find(item => item.name === "door_open").value, 1);
  assert.deepEqual(opened.measurements.find(item => item.name === "battery_voltage"),
    { name: "battery_voltage", value: 3.054, unit: "V" });
  assert.equal(opened.measurements.find(item => item.name === "door_open_count").value, 1);
  assert.equal(closed.sourceTime, base.time);
  assert.deepEqual(closed.rxInfo, [{ gatewayId: gateway, rssi: -45, snr: 14.8, gwTime: undefined, nsTime: undefined }]);
  const alarm = parse({ ...base, object: { ...base.object, door_open_count: 123, last_open_duration: 37, alarm: true } });
  assert.equal(alarm.measurements.find(item => item.name === "battery_voltage").value, 3.198);
  assert.equal(alarm.measurements.find(item => item.name === "door_open_count").value, 123);
  assert.deepEqual(alarm.measurements.find(item => item.name === "last_open_duration"),
    { name: "last_open_duration", value: 37, unit: "min" });
  assert.equal(alarm.measurements.find(item => item.name === "alarm").value, 1);
  const withoutTime = { ...base }; delete withoutTime.time;
  assert.equal(parse(withoutTime).sourceTime, null);
});

test("missing or nonnumeric ChirpStack objects never fall back to raw LDS02 decoding", () => {
  for (const object of [undefined, null, {}, { label: "open", nested: { door_open: 1 } }]) {
    for (const data of [base.data, "jH4BAAABAAAAAA==", "AA=="]) {
      const missing = parse({ ...base, object, data });
      assert.equal(missing.status, "unsupported");
      assert.deepEqual(missing.measurements, []);
      assert.match(missing.error, /ChirpStack object/);
    }
  }
  const alias = parseUplink(topic, Buffer.from(JSON.stringify({
    ...base, object: null, deviceInfo: { ...base.deviceInfo, deviceProfileName: "Custom door" }
  })), tenant, [profile]);
  assert.equal(alias.status, "unsupported");
  const upstreamOnly = parse({ ...base, data: "AA==", fPort: 7 });
  assert.equal(upstreamOnly.status, "decoded");
  assert.deepEqual(upstreamOnly.measurements, parse().measurements);
});

test("invalid LDS02 decoded fields reject all measurements instead of fabricating states or recording partial data", () => {
  for (const [name, value] of [
    ["door_open", 2], ["door_open", "OUVERT"], ["door_open", null],
    ["battery_voltage", -1], ["battery_voltage", true], ["battery_voltage", "3.2"],
    ["door_open_count", -1], ["door_open_count", 1.5], ["door_open_count", 16777216],
    ["last_open_duration", -1], ["last_open_duration", 16777216], ["alarm", 2]
  ]) {
    const invalid = parse({ ...base, object: { ...base.object, [name]: value } });
    assert.equal(invalid.status, "invalid", name);
    assert.deepEqual(invalid.measurements, []);
    assert.match(invalid.error, new RegExp(name));
  }
  const states = parse({ ...base, object: { door_open: true, alarm: false } });
  assert.deepEqual(states.measurements, [
    { name: "door_open", value: 1, unit: "" }, { name: "alarm", value: 0, unit: "" }
  ]);
  const batteryOnly = parse({ ...base, object: { battery_voltage: 3.2 } });
  assert.deepEqual(batteryOnly.measurements, [{ name: "battery_voltage", value: 3.2, unit: "V" }]);
  const alias = parseUplink(topic, Buffer.from(JSON.stringify({
    ...base, deviceInfo: { ...base.deviceInfo, deviceProfileName: "Custom door" }
  })), tenant, [profile]);
  assert.deepEqual(alias.measurements, parse().measurements);
});

test("generic ChirpStack measurements including AQS01-L remain numeric without inferred units", () => {
  const generic = parse({ ...base, deviceInfo: { ...base.deviceInfo, deviceProfileName: "Other" }, object: { temperature: 21.2, active: true, label: "unknown" } });
  assert.deepEqual(generic.measurements, [{ name: "temperature", value: 21.2, unit: "" }, { name: "active", value: 1, unit: "" }]);
  const object = { battery_voltage: 3.612, temperature_c: 21.58, humidity_percent: 49.5, pressure_hpa: 1003.1, co2_ppm: 1330 };
  const aqs01 = parse({ ...base, fPort: 2, data: "DhwIbgHvJy8FMhA=", object,
    deviceInfo: { ...base.deviceInfo, deviceProfileName: "Dragino-AQS01-L" } });
  assert.equal(aqs01.status, "decoded");
  assert.deepEqual(aqs01.measurements, Object.entries(object).map(([name, value]) => ({ name, value, unit: "" })));
});

test("invalid measurement names, non-finite numbers and oversized objects are explicitly rejected", () => {
  for (const object of [{ "": 1 }, { ["x".repeat(201)]: 1 }, Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`value_${i}`, i]))]) {
    const invalid = parse({ ...base, object });
    assert.equal(invalid.status, "invalid");
    assert.deepEqual(invalid.measurements, []);
  }
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.throws(() => decodeUplink({ object: { temperature: value }, profileName: "Other" }), /Non-finite/);
  }
});

test("uplink envelopes still validate JSON, object shape, base64, tenant and topic", () => {
  assert.throws(() => parse({ ...base, object: [] }), /uplink fields/);
  assert.throws(() => parseUplink(topic, Buffer.from("{"), tenant), /Invalid MQTT JSON/);
  assert.throws(() => parse(base, topic.replace(dev, "0000000000000000")), /topic or tenant/);
  assert.throws(() => parse({ ...base, deviceInfo: { ...base.deviceInfo, tenantId: app } }), /topic or tenant/);
  assert.throws(() => parse({ ...base, data: "%%%=" }), /uplink fields/);
});

test("insertion is transactional and duplicate events do not repeat measurements", async () => {
  const events = new Set(), calls = [];
  const client = {
    async query(sql, values) {
      calls.push(sql.trim());
      if (sql.includes("INSERT INTO public.gtb_lorawan_events")) {
        const key = values[1], already = events.has(key); events.add(key);
        return { rowCount: already ? 0 : 1 };
      }
      if (sql.includes("SELECT application_id, dev_eui, f_port, payload")) {
        return { rows: [{ application_id: app, dev_eui: dev, f_port: 10, payload: Buffer.from(base.data, "base64") }] };
      }
      return { rowCount: 1 };
    },
    release() {}
  };
  const pool = { connect: async () => client };
  assert.equal(await storeUplink(pool, parse()), true);
  assert.equal(await storeUplink(pool, parse()), false);
  assert.equal(calls.filter(sql => sql.startsWith("INSERT INTO public.gtb_lorawan_measurements")).length, 5);
  assert.equal(calls.filter(sql => sql === "COMMIT").length, 2);
  await assert.rejects(storeUplink(pool, parse({ ...base, data: "jH4BAAABAAAAAA==" })), /Conflicting uplinks/);
  assert.equal(calls.at(-1), "ROLLBACK");
  client.query = async sql => {
    calls.push(sql.trim());
    if (sql.includes("INSERT INTO public.gtb_lorawan_events")) return { rowCount: 1 };
    if (sql.includes("INSERT INTO public.gtb_lorawan_measurements")) throw new Error("database down");
    return { rowCount: 1 };
  };
  await assert.rejects(storeUplink(pool, parse()), /database down/);
  assert.equal(calls.at(-1), "ROLLBACK");
});

test("feature is opt-in and rejects insecure credential embedding and incomplete configuration", () => {
  assert.equal(parseConfig({}, {}), null);
  const env = { LORAWAN_ENABLED: "true", LORAWAN_TENANT_ID: tenant, LORAWAN_API_SERVER: "localhost:8080",
    LORAWAN_API_TOKEN: "test-token", LORAWAN_MQTT_URL: "mqtt://localhost:1883", LORAWAN_MQTT_CLIENT_ID: "" };
  assert.throws(() => parseConfig(env, {}), /PGUSER/);
  assert.equal(parseConfig(env, { PGUSER: "test" }).apiTls, true);
  assert.match(parseConfig(env, { PGUSER: "test" }).mqttClientId, /^gtbapi-/);
  assert.throws(() => parseConfig({ ...env, LORAWAN_MQTT_URL: "mqtt://user:password@localhost:1883" }, { PGUSER: "test" }), /embedded credentials/);
  assert.throws(() => parseConfig({ ...env, LORAWAN_LDS02_PROFILE_IDS: "invalid" }, { PGUSER: "test" }), /PROFILE_IDS/);
});

test("LoRaWAN initialization failures remain visible without stopping other services or leaking secrets", async () => {
  const logs = [];
  const env = { LORAWAN_ENABLED: "true", LORAWAN_TENANT_ID: tenant, LORAWAN_API_SERVER: "localhost:8080",
    LORAWAN_API_TOKEN: "test-token", LORAWAN_MQTT_URL: "mqtt://localhost:1883" };
  const runtime = createRuntime(env, { PGUSER: "test" }, { error: (...args) => logs.push(args) }, {
    connectMqtt() {
      const error = new Error("a private credential");
      error.code = "TEST_CONNECT_FAILURE";
      throw error;
    }
  });
  assert.equal(runtime.status.enabled, true);
  assert.equal(runtime.status.error, "Initialisation LoRaWAN impossible");
  assert.equal(runtime.status.mqttConnected, false);
  assert.equal(logs[0][0].code, "TEST_CONNECT_FAILURE");
  assert.doesNotMatch(JSON.stringify(logs), /a private credential|test-token/);
  await runtime.close();
});

test("MQTT acknowledgements wait for commit and failed writes disconnect for replay", { timeout: 10000 }, async context => {
  let releaseCommit, commitStarted, failCommit = false, destroyed = false;
  const gate = new Promise(resolve => { releaseCommit = resolve; });
  const started = new Promise(resolve => { commitStarted = resolve; });
  const db = {
    async query(sql) {
      if (sql === "COMMIT") {
        if (failCommit) throw new Error("database down");
        commitStarted();
        await gate;
      }
      return { rowCount: 1 };
    },
    release() {}
  };
  context.mock.method(Object.getPrototypeOf(Pool.prototype), "connect", async () => db);
  const client = new EventEmitter();
  client.stream = { destroy() { destroyed = true; } };
  client.endAsync = async () => {};
  const env = { LORAWAN_ENABLED: "true", LORAWAN_TENANT_ID: tenant, LORAWAN_API_SERVER: "localhost:1",
    LORAWAN_API_TOKEN: "test-token", LORAWAN_MQTT_URL: "mqtt://localhost:1883" };
  const logger = { info() {}, warn() {}, error() {} };
  const runtime = createRuntime(env, { PGUSER: "test" }, logger, { connectMqtt: () => client });
  context.after(() => runtime.close());
  const packet = { topic, payload: Buffer.from(JSON.stringify(base)) };
  let acknowledged = false;
  const first = new Promise(resolve => client.handleMessage(packet, error => { acknowledged = true; resolve(error); }));
  await started;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(acknowledged, false);
  releaseCommit();
  assert.equal(await first, undefined);
  assert.equal(runtime.status.ingestionError, null);
  failCommit = true;
  const error = await new Promise(resolve => client.handleMessage(packet, resolve));
  assert.match(error.message, /database down/);
  assert.equal(destroyed, true);
  assert.equal(runtime.status.ingestionError, "Enregistrement MQTT impossible");
});

test("gRPC lists are scoped, paginated, deadline-bound and reject inconsistent snapshots", async () => {
  const offsets = [];
  const client = { list(req, _metadata, options, callback) {
    offsets.push(req.getOffset());
    assert.equal(req.getTenantId(), tenant);
    assert.ok(options.deadline instanceof Date);
    const count = 205;
    callback(null, { getTotalCount: () => count, getResultList: () => Array.from({ length: Math.min(100, count - req.getOffset()) }, (_, i) => i) });
  } };
  assert.equal((await pages(client, ListGatewaysRequest, "setTenantId", tenant, {})).length, 205);
  assert.deepEqual(offsets, [0, 100, 200]);
  const inconsistent = { list(req, _metadata, _options, callback) {
    callback(null, { getTotalCount: () => req.getOffset() ? 199 : 200, getResultList: () => Array(100).fill(1) });
  } };
  await assert.rejects(pages(inconsistent, ListGatewaysRequest, "setTenantId", tenant, {}), /changed during pagination/);
  const failed = { list(_req, _metadata, _options, callback) { callback(new Error("not authorized")); } };
  await assert.rejects(fetchSnapshot({ gateway: failed, application: failed }, { tenantId: tenant, apiToken: "test" }), /not authorized/);
});

test("official ChirpStack gRPC clients synchronize scoped gateway and device metadata", async context => {
  const server = new grpc.Server();
  const seen = [];
  function verify(call) {
    assert.deepEqual(call.metadata.get("authorization"), ["Bearer test-token"]);
    seen.push(call.request);
  }
  server.addService(GatewayServiceService, { list(call, callback) {
    verify(call); assert.equal(call.request.getTenantId(), tenant);
    const item = new GatewayListItem(); item.setTenantId(tenant); item.setGatewayId(gateway);
    item.setName("Gateway"); item.setState(GatewayState.ONLINE);
    const result = new ListGatewaysResponse(); result.setTotalCount(1); result.setResultList([item]); callback(null, result);
  } });
  server.addService(ApplicationServiceService, { list(call, callback) {
    verify(call); assert.equal(call.request.getTenantId(), tenant);
    const item = new ApplicationListItem(); item.setId(app); item.setName("Application");
    const result = new ListApplicationsResponse(); result.setTotalCount(1); result.setResultList([item]); callback(null, result);
  } });
  server.addService(DeviceServiceService, { list(call, callback) {
    verify(call); assert.equal(call.request.getApplicationId(), app);
    const item = new DeviceListItem(); item.setDevEui(dev); item.setName("Porte");
    item.setDeviceProfileId(profile); item.setDeviceProfileName("Dragino-LDS02");
    const result = new ListDevicesResponse(); result.setTotalCount(1); result.setResultList([item]); callback(null, result);
  } });
  const port = await new Promise((resolve, reject) => server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(),
    (error, value) => error ? reject(error) : resolve(value)));
  const clients = createClients({ apiServer: `127.0.0.1:${port}`, apiTls: false });
  context.after(() => { for (const client of Object.values(clients)) client.close(); server.forceShutdown(); });
  const result = await fetchSnapshot(clients, { tenantId: tenant, apiToken: "test-token" });
  assert.equal(result.gateways[0].state, "online");
  assert.equal(result.devices[0].eui, dev);
  assert.equal(result.devices[0].applicationId, app);
  assert.equal(result.devices[0].profileName, "Dragino-LDS02");
  assert.equal(seen.length, 3);
});

test("inventory snapshots roll back on failure and never overwrite local placements", async () => {
  const statements = [];
  let fail = false, released = false;
  const client = {
    async query(sql) {
      statements.push(sql);
      if (fail && sql.includes("INSERT INTO public.gtb_lorawan_devices")) throw new Error("storage failed");
      return { rowCount: 1 };
    },
    release() { released = true; }
  };
  const pool = { connect: async () => client };
  const snapshot = { gateways: [{ eui: gateway, name: "Gateway", description: "", lastSeen: null, state: "online" }],
    devices: [{ eui: dev, name: "Door", description: "", applicationId: app, applicationName: "App", profileId: profile, profileName: "LDS02", lastSeen: null }] };
  await storeSnapshot(pool, tenant, snapshot);
  assert.equal(statements.at(-1), "COMMIT");
  assert.ok(released);
  assert.doesNotMatch(statements.join("\n"), /object_id|placement_revision/i);
  fail = true; released = false;
  await assert.rejects(storeSnapshot(pool, tenant, snapshot), /storage failed/);
  assert.equal(statements.at(-1), "ROLLBACK");
  assert.ok(released);
});
