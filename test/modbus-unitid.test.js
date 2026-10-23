const { test } = require("node:test");
const assert = require("node:assert/strict");
const ModbusRTU = require("modbus-serial");
const { changeUnitId, readDeviceProfile } = require("../src/modbus");
const app = require("../src/app");

function registers(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeFloatBE(value);
  return [bytes.readUInt16BE(0), bytes.readUInt16BE(2)];
}

function meter(context, options = {}) {
  const calls = [];
  let address = 1;
  context.mock.method(ModbusRTU.prototype, "connectTCP", async () => {});
  context.mock.method(ModbusRTU.prototype, "close", () => {});
  context.mock.method(ModbusRTU.prototype, "readHoldingRegisters", async function (register, count) {
    const id = this.getID();
    calls.push({ type: "holding", id, register, count });
    if (id === address) return { data: registers(options.mismatch ? 99 : address) };
    if (options.occupied) return { data: registers(id) };
    if (options.exception) throw Object.assign(new Error("Illegal address"), { modbusCode: 2 });
    if (options.probeFailure) throw new Error("Connection lost");
    throw Object.assign(new Error("Timed out"), { errno: "ETIMEDOUT" });
  });
  context.mock.method(ModbusRTU.prototype, "readInputRegisters", async function (register, count) {
    calls.push({ type: "input", id: this.getID(), register, count });
    if (this.getID() === address) return { data: registers(230) };
    if (options.inputOccupied) return { data: registers(230) };
    throw Object.assign(new Error("Timed out"), { errno: "ETIMEDOUT" });
  });
  context.mock.method(ModbusRTU.prototype, "writeRegisters", async function (register, values) {
    calls.push({ type: "write", id: this.getID(), register, values });
    if (options.writeFailure) throw new Error("Timed out");
    if (options.onWrite) await options.onWrite();
    address = options.notApplied ? 1 : 7;
    return { address: register, length: values.length };
  });
  return calls;
}

const params = { host: "10.107.31.4", port: 4196, unitId: 1, newUnitId: 7, profile: "eastron-sdm120ct", setupConfirmed: true };

test("Eastron profile reads the actual address using FC03", async context => {
  const calls = meter(context);
  const result = await readDeviceProfile(params);
  assert.equal(result.data.device_address, 1);
  assert.deepEqual(calls[0], { type: "holding", id: 1, register: 0x14, count: 2 });
});

test("ID change probes both functions, writes float32 BE via FC16 once and verifies the new address", async context => {
  const calls = meter(context);
  assert.deepEqual(await changeUnitId(params), { previousUnitId: 1, unitId: 7, verified: true });
  assert.deepEqual(calls, [
    { type: "holding", id: 1, register: 0x14, count: 2 },
    { type: "holding", id: 7, register: 0x14, count: 2 },
    { type: "input", id: 7, register: 0, count: 2 },
    { type: "write", id: 1, register: 0x14, values: [0x40e0, 0] },
    { type: "holding", id: 7, register: 0x14, count: 2 }
  ]);
});

for (const [name, options, message] of [
  ["occupied holding address", { occupied: true }, /repond deja/],
  ["occupied input-only address", { inputOccupied: true }, /repond deja/],
  ["Modbus exception at new address", { exception: true }, /repond deja/],
  ["unreliable collision probe", { probeFailure: true }, /Connection lost/],
  ["mismatching current address", { mismatch: true }, /ne correspond pas/]
]) {
  test(`ID change refuses ${name} without writing`, async context => {
    const calls = meter(context, options);
    await assert.rejects(changeUnitId(params), message);
    assert.equal(calls.some(call => call.type === "write"), false);
  });
}

for (const options of [{ writeFailure: true }, { notApplied: true }]) {
  test(`unconfirmed write is reported explicitly (${JSON.stringify(options)})`, async context => {
    const calls = meter(context, options);
    await assert.rejects(changeUnitId(params), error => error.statusCode === 502 && /L'adresse peut avoir change/.test(error.message));
    assert.equal(calls.filter(call => call.type === "write").length, 1);
  });
}

test("invalid change requests never connect", async context => {
  const connect = context.mock.method(ModbusRTU.prototype, "connectTCP", async () => assert.fail("Must not connect"));
  for (const patch of [{ profile: "tuf-2000m" }, { setupConfirmed: false }, { newUnitId: 1 }, { newUnitId: 0 }, { newUnitId: 248 }, { newUnitId: 1.5 }]) {
    await assert.rejects(changeUnitId({ ...params, ...patch }), error => error.statusCode === 400);
  }
  assert.equal(connect.mock.callCount(), 0);
});

test("concurrent changes on the same gateway are rejected and lock is released", async context => {
  let release;
  let writing;
  const started = new Promise(resolve => { writing = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  meter(context, { onWrite: () => { writing(); return gate; } });
  const first = changeUnitId(params);
  await started;
  await assert.rejects(changeUnitId(params), error => error.statusCode === 409);
  release();
  await first;
  await assert.rejects(changeUnitId(params), /Timed out/);
});

test("HTTP API validates POST, exposes capability and preserves conflict status", async context => {
  const calls = meter(context, { occupied: true });
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  context.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/meter`;
  const profiles = await (await fetch(`${base}/profiles`)).json();
  assert.equal(profiles.profiles.find(profile => profile.name === params.profile).canChangeUnitId, true);
  assert.equal(profiles.profiles.find(profile => profile.name === "tuf-2000m").canChangeUnitId, false);
  assert.equal((await fetch(`${base}/change-unitid`)).status, 404);
  for (const patch of [{ setupConfirmed: false }, { profile: "polier-mm80lmzmod" }, { newUnitId: 248 }, { newUnitId: 1 }, { address: 20 }]) {
    const response = await fetch(`${base}/change-unitid`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...params, ...patch }) });
    assert.equal(response.status, 400);
  }
  assert.equal(calls.length, 0);
  const response = await fetch(`${base}/change-unitid`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params) });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /repond deja/);
});

test("HTTP API returns the verified new target after a successful change", async context => {
  meter(context);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  context.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/meter/change-unitid`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params)
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    target: { host: params.host, port: 4196, unitId: 7 },
    previousUnitId: 1, unitId: 7, verified: true
  });
});
