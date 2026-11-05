const { test } = require("node:test");
const assert = require("node:assert/strict");
const ModbusRTU = require("modbus-serial");
const { readDeviceProfile, writeRelay, readRelayInputs } = require("../src/modbus");
const app = require("../src/app");
app.locals.profileInventoryPool = null;
const params = { host: "10.107.31.5", port: 4196, unitId: 1, profile: "stm8-4relay",
  relay: 3, state: true, commandConfirmed: true };
function board(context, { failure = false, mismatch = false, invalid = false, readbackFailure = false, onWrite } = {}) {
  const calls = [], states = [false, true, false, true];
  context.mock.method(ModbusRTU.prototype, "connectTCP", async () => {});
  context.mock.method(ModbusRTU.prototype, "close", () => {});
  context.mock.method(ModbusRTU.prototype, "readCoils", async function (address, count) {
    calls.push({ fn: 1, id: this.getID(), address, count });
    if (readbackFailure && calls.some(call => call.fn === 5)) throw new Error("Read timeout");
    return { data: invalid ? ["bad"] : states.slice(address, address + count) };
  });
  context.mock.method(ModbusRTU.prototype, "writeCoil", async function (address, value) {
    calls.push({ fn: 5, id: this.getID(), address, value });
    if (onWrite) await onWrite();
    if (failure) throw new Error("Timeout");
    if (!mismatch) states[address] = value;
  });
  return calls;
}
test("relay profile reads exactly four coils without any writes", async context => {
  const calls = board(context);
  assert.deepEqual((await readDeviceProfile(params)).data, { relay_1: 0, relay_2: 1, relay_3: 0, relay_4: 1 });
  assert.deepEqual(calls, Array.from({ length: 4 }, (_, address) => ({ fn: 1, id: 1, address, count: 1 })));
});
test("individual command probes FC01 then writes FC05 once and verifies ON and OFF", async context => {
  const calls = board(context);
  assert.equal((await writeRelay(params)).verified, true);
  assert.equal((await writeRelay({ ...params, state: false })).verified, true);
  assert.deepEqual(calls, [true, false].flatMap(value => [
    { fn: 1, id: 1, address: 2, count: 1 }, { fn: 5, id: 1, address: 2, value }, { fn: 1, id: 1, address: 2, count: 1 }
  ]));
});
for (const options of [{ failure: true }, { mismatch: true }, { readbackFailure: true }]) test(`unconfirmed relay command never retries: ${JSON.stringify(options)}`, async context => {
  const calls = board(context, options);
  await assert.rejects(writeRelay(params), error => error.statusCode === 502 && /peut avoir change/.test(error.message));
  assert.equal(calls.filter(call => call.fn === 5).length, 1);
});
test("first and fourth relay map to coils zero and three, not global command addresses", async context => {
  const calls = board(context);
  for (const relay of [1, 4]) await writeRelay({ ...params, relay });
  assert.deepEqual(calls.filter(call => call.fn === 5).map(call => call.address), [0, 3]);
});
test("invalid or unresponsive initial state prevents writing", async context => {
  const calls = board(context, { invalid: true });
  await assert.rejects(writeRelay(params), /prealable/);
  assert.equal(calls.some(call => call.fn === 5), false);
  await assert.rejects(readDeviceProfile(params), /invalide/);
});
test("invalid relay requests never connect", async context => {
  const connect = context.mock.method(ModbusRTU.prototype, "connectTCP", async () => assert.fail("Must not connect"));
  for (const patch of [{ relay: 0 }, { relay: 5 }, { relay: 1.5 }, { state: 1 }, { commandConfirmed: false }, { profile: "ts85-b" }, { unitId: 0 }]) {
    await assert.rejects(writeRelay({ ...params, ...patch }), error => error.statusCode === 400);
  }
  assert.equal(connect.mock.callCount(), 0);
});
test("relay commands are serialized per gateway and release the lock", async context => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { started = resolve; });
  board(context, { onWrite: () => { started(); return gate; } });
  const first = writeRelay(params); await ready;
  await assert.rejects(writeRelay({ ...params, unitId: 2 }), error => error.statusCode === 409);
  release(); await first;
  assert.equal((await writeRelay(params)).verified, true);
});
test("HTTP capability and strictly validated POST relay command", async context => {
  const calls = board(context);
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  context.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/meter`;
  const profiles = await (await fetch(`${base}/profiles`)).json();
  assert.equal(profiles.profiles.find(row => row.name === params.profile).canWriteRelay, true);
  const post = body => fetch(`${base}/write-relay`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  for (const patch of [{ commandConfirmed: false }, { relay: 255 }, { state: "true" }, { address: 1 }]) assert.equal((await post({ ...params, ...patch })).status, 400);
  assert.equal(calls.length, 0);
  const response = await post(params);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).verified, true);
});
test("FC02 requests eight bits at zero and exposes only IN1-IN4 without coil reads or writes", async context => {
  const calls = board(context);
  const read = context.mock.method(ModbusRTU.prototype, "readDiscreteInputs", async function (address, count) {
    assert.equal(this.getID(), 1);
    assert.equal(address, 0); assert.equal(count, 8);
    return { data: [false, true, 0, 1, true, false, 1, 0] };
  });
  assert.deepEqual(await readRelayInputs(params), {
    profile: "stm8-4relay", unitId: 1, data: { input_1: 0, input_2: 1, input_3: 0, input_4: 1 }
  });
  assert.equal(read.mock.callCount(), 1);
  assert.equal(calls.length, 0);
});
for (const data of [[true, false], [0, 1, 0, 1], [0, 1, 0, 1, 0, 0, 0],
  [0, 1, null, 0, 0, 0, 0, 0], ["0", 1, 0, 1, 0, 0, 0, 0], [0, 1, 0, 1, 0, 0, 0, null]]) test(`invalid input response is explicitly unavailable: ${JSON.stringify(data)}`, async context => {
  const calls = board(context);
  context.mock.method(ModbusRTU.prototype, "readDiscreteInputs", async () => ({ data }));
  await assert.rejects(readRelayInputs(params), error => error.statusCode === 502 && /indisponibles/.test(error.message));
  assert.equal(calls.length, 0);
});
test("FC02 timeout does not block relay reads or commands and never retries", async context => {
  board(context);
  const read = context.mock.method(ModbusRTU.prototype, "readDiscreteInputs", async () => { throw new Error("Timeout"); });
  await assert.rejects(readRelayInputs(params), error => error.statusCode === 502);
  assert.equal(read.mock.callCount(), 1);
  assert.equal((await readDeviceProfile(params)).data.relay_1, 0);
  assert.equal((await writeRelay(params)).verified, true);
});
test("invalid digital input parameters never connect", async context => {
  const connect = context.mock.method(ModbusRTU.prototype, "connectTCP", async () => assert.fail("Must not connect"));
  for (const patch of [{ profile: "ts85-b" }, { unitId: 0 }, { unitId: 248 }, { unitId: 1.5 }]) {
    await assert.rejects(readRelayInputs({ ...params, ...patch }), error => error.statusCode === 400);
  }
  assert.equal(connect.mock.callCount(), 0);
});
test("HTTP discrete input read validates target and reports FC02 failures", async context => {
  board(context);
  let fail = false;
  const read = context.mock.method(ModbusRTU.prototype, "readDiscreteInputs", async (address, count) => {
    assert.equal(address, 0); assert.equal(count, 8);
    if (fail) throw new Error("Illegal function");
    return { data: [0, 1, 0, 1, 1, 1, 1, 1] };
  });
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  context.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/meter`;
  const query = { host: params.host, port: params.port, unitId: 1, profile: params.profile };
  for (const patch of [{ unitId: 0 }, { profile: "ts85-b" }, { count: 8 }]) {
    assert.equal((await fetch(`${base}/read-relay-inputs?${new URLSearchParams({ ...query, ...patch })}`)).status, 400);
  }
  assert.equal(read.mock.callCount(), 0);
  const response = await fetch(`${base}/read-relay-inputs?${new URLSearchParams(query)}`);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.data, { input_1: 0, input_2: 1, input_3: 0, input_4: 1 });
  assert.equal(result.target.port, params.port);
  assert.ok(Number.isFinite(Date.parse(result.timestamp)));
  fail = true;
  assert.equal((await fetch(`${base}/read-relay-inputs?${new URLSearchParams(query)}`)).status, 502);
});
