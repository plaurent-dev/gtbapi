const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Pool } = require("pg");
const ModbusRTU = require("modbus-serial");
const { createProfileInventoryPool } = require("../src/profile-inventory");
const { PROFILE_DEFINITIONS } = require("../src/modbus");
const app = require("../src/app");

async function fixture(context, pool) {
  const previous = app.locals.profileInventoryPool;
  app.locals.profileInventoryPool = pool;
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  context.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    app.locals.profileInventoryPool = previous;
  });
  return `http://127.0.0.1:${server.address().port}/api/v1/meter`;
}

function assertDefinitions(body) {
  assert.equal(body.count, Object.keys(PROFILE_DEFINITIONS).length);
  assert.deepEqual(body.profiles.map(({ name, defaultUnitId, canChangeUnitId, fields }) => ({
    name, defaultUnitId, canChangeUnitId, fields
  })), Object.entries(PROFILE_DEFINITIONS).map(([name, def]) => ({
    name, defaultUnitId: def.defaultUnitId, canChangeUnitId: def.canChangeUnitId === true,
    fields: def.fields.map(({ name, type, address, count, decode }) => ({ name, type, address, count, decode }))
  })));
}

test("profiles list every registered gateway/Unit ID and refresh changes without changing definitions", async context => {
  let rows = [
    { profile: "eastron-sdm120ct", host: "10.107.31.4", port: 4196, unitId: 10 },
    { profile: "eastron-sdm120ct", host: "10.107.31.4", port: 4196, unitId: 20 },
    { profile: "eastron-sdm120ct", host: "10.107.31.5", port: 502, unitId: 1 },
    { profile: "ts85-b", host: "10.107.31.4", port: 4196, unitId: 7 }
  ];
  let reads = 0;
  const base = await fixture(context, { query: async (sql, values) => {
    reads++;
    assert.match(sql, /SELECT s\.profile,host\(s\.host\) AS host,s\.port,s\.unit_id AS "unitId"/);
    assert.match(sql, /FROM public\.gtb_sensors s WHERE s\.profile=ANY\(\$1::text\[\]\)/);
    assert.match(sql, /ORDER BY s\.profile,s\.host,s\.port,s\.unit_id LIMIT 1001/);
    assert.deepEqual(values, [Object.keys(PROFILE_DEFINITIONS)]);
    return { rows };
  } });
  const response = await fetch(`${base}/profiles`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assertDefinitions(body);
  assert.equal(body.gatewaysAvailable, true);
  assert.equal(body.gatewaysWarning, null);
  const profile = name => body.profiles.find(p => p.name === name);
  assert.deepEqual(profile("eastron-sdm120ct").gateways, [
    { host: "10.107.31.4", port: 4196, unitId: 10 },
    { host: "10.107.31.4", port: 4196, unitId: 20 },
    { host: "10.107.31.5", port: 502, unitId: 1 }
  ]);
  assert.deepEqual(profile("ts85-b").gateways, [{ host: "10.107.31.4", port: 4196, unitId: 7 }]);
  assert.deepEqual(profile("polier-mm80lmzmod").gateways, []);
  assert.deepEqual(profile("tuf-2000m").gateways, []);
  rows = [{ profile: "ts85-b", host: "10.107.31.25", port: 4196, unitId: 12 }];
  const refreshed = await (await fetch(`${base}/profiles`)).json();
  assert.equal(reads, 2);
  assert.deepEqual(refreshed.profiles.find(p => p.name === "eastron-sdm120ct").gateways, []);
  assert.deepEqual(refreshed.profiles.find(p => p.name === "ts85-b").gateways, [{ host: "10.107.31.25", port: 4196, unitId: 12 }]);
});

for (const [name, pool, warning] of [
  ["no configuration", null, /renseigner PGUSER/],
  ["missing inventory table", { query: async () => { throw Object.assign(new Error("private SQL"), { code: "42P01" }); } }, /migration 009/],
  ["missing privileges", { query: async () => { throw Object.assign(new Error("private role"), { code: "42501" }); } }, /droits PostgreSQL/],
  ["connection failure", { query: async () => { throw new Error("private connection details"); } }, /connexion PostgreSQL/],
  ["oversized inventory", { query: async () => ({ rows: Array.from({ length: 1001 }, () => ({})) }) }, /maximum 1000/]
]) {
  test(`profiles remain usable with null gateways and an explicit warning on ${name}`, async context => {
    const base = await fixture(context, pool);
    const response = await fetch(`${base}/profiles`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assertDefinitions(body);
    assert.equal(body.gatewaysAvailable, false);
    assert.match(body.gatewaysWarning, warning);
    assert.doesNotMatch(body.gatewaysWarning, /private/);
    assert.ok(body.profiles.every(p => p.gateways === null));
  });
}

test("an available but empty inventory returns arrays rather than null", async context => {
  const base = await fixture(context, { query: async () => ({ rows: [] }) });
  const body = await (await fetch(`${base}/profiles`)).json();
  assert.equal(body.gatewaysAvailable, true);
  assert.equal(body.gatewaysWarning, null);
  assert.ok(body.profiles.every(p => Array.isArray(p.gateways) && p.gateways.length === 0));
});

test("exactly 1000 registered sensors are returned without truncation", async context => {
  const rows = Array.from({ length: 1000 }, (_, i) => ({
    profile: "ts85-b", host: `10.107.31.${1 + Math.floor(i / 32)}`, port: 4196, unitId: i % 32 + 1
  }));
  const base = await fixture(context, { query: async () => ({ rows }) });
  const body = await (await fetch(`${base}/profiles`)).json();
  assert.equal(body.gatewaysAvailable, true);
  assert.equal(body.profiles.find(p => p.name === "ts85-b").gateways.length, 1000);
});

test("a failed inventory lookup does not prevent Modbus readings", async context => {
  let inventoryReads = 0;
  const base = await fixture(context, { query: async () => { inventoryReads++; throw new Error("offline"); } });
  context.mock.method(ModbusRTU.prototype, "connectTCP", async () => {});
  context.mock.method(ModbusRTU.prototype, "close", () => {});
  context.mock.method(ModbusRTU.prototype, "readHoldingRegisters", async address => ({ data: [[273, 567, 423][address]] }));
  assert.equal((await (await fetch(`${base}/profiles`)).json()).gatewaysAvailable, false);
  const response = await fetch(`${base}/read-profile?host=10.107.31.4&unitId=7&profile=ts85-b`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, { temperature_c: 27.3, humidity_percent: 56.7, co2_ppm: 423 });
  assert.equal(inventoryReads, 1);
});

test("inventory pool is optional, bounded and read-only without connecting during construction", async context => {
  assert.equal(createProfileInventoryPool({ PGUSER: "" }), null);
  const pool = createProfileInventoryPool({
    PGUSER: "test-reader", PGPASSWORD: "test-only", PGHOST: "127.0.0.1", PGPORT: 5432, PGDATABASE: "test-only"
  });
  context.after(() => pool.end());
  assert.ok(pool instanceof Pool);
  assert.equal(pool.totalCount, 0);
  assert.equal(pool.options.max, 2);
  assert.equal(pool.options.connectionTimeoutMillis, 3000);
  assert.equal(pool.options.statement_timeout, 3000);
  assert.equal(pool.options.query_timeout, 4000);
  assert.equal(pool.options.options, "-c default_transaction_read_only=on");
});
