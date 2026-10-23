const { test } = require("node:test");
const assert = require("node:assert/strict");
const ModbusRTU = require("modbus-serial");
const { readDeviceProfile } = require("../src/modbus");
const app = require("../src/app");
app.locals.profileInventoryPool = null;

function sensor(context, registers) {
  const calls = [];
  context.mock.method(ModbusRTU.prototype, "connectTCP", async function (host, options) {
    calls.push({ type: "connect", host, port: options.port });
  });
  context.mock.method(ModbusRTU.prototype, "close", () => calls.push({ type: "close" }));
  context.mock.method(ModbusRTU.prototype, "readHoldingRegisters", async function (address, count) {
    calls.push({ type: "holding", unitId: this.getID(), address, count });
    assert.equal(count, 1);
    assert.ok(Object.hasOwn(registers, address), `Unexpected register ${address}`);
    return { data: [registers[address]] };
  });
  for (const method of ["readInputRegisters", "writeRegister", "writeRegisters"]) {
    context.mock.method(ModbusRTU.prototype, method, () => assert.fail(`TS85 must not call ${method}`));
  }
  return calls;
}

for (const [name, raw, expected] of [
  ["manual example", [0x0111, 0x0237, 0x01a7], { temperature_c: 27.3, humidity_percent: 56.7, co2_ppm: 423 }],
  ["negative temperature from manual", [0xff9b, 0x0237, 5000], { temperature_c: -10.1, humidity_percent: 56.7, co2_ppm: 5000 }],
  ["minimum specified temperature and zero humidity", [0xfe70, 0, 400], { temperature_c: -40, humidity_percent: 0, co2_ppm: 400 }],
  ["maximum specified temperature and humidity", [1200, 1000, 5000], { temperature_c: 120, humidity_percent: 100, co2_ppm: 5000 }],
  ["zero readings", [0, 0, 0], { temperature_c: 0, humidity_percent: 0, co2_ppm: 0 }]
]) {
  test(`TS85-B reads FC03 and decodes ${name}`, async context => {
    const calls = sensor(context, raw);
    const result = await readDeviceProfile({ host: "10.107.31.4", port: 4196, profile: "ts85-b" });
    assert.deepEqual(result, { profile: "ts85-b", unitId: 1, data: expected });
    assert.deepEqual(calls, [
      { type: "connect", host: "10.107.31.4", port: 4196 },
      { type: "holding", unitId: 1, address: 0, count: 1 },
      { type: "holding", unitId: 1, address: 1, count: 1 },
      { type: "holding", unitId: 1, address: 2, count: 1 },
      { type: "close" }
    ]);
  });
}

test("HTTP exposes TS85-B metadata and reads the requested gateway and Unit ID", async context => {
  const calls = sensor(context, [0xff9b, 0x0237, 0x01a7]);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  context.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/meter`;
  const profiles = await (await fetch(`${base}/profiles`)).json();
  assert.deepEqual(profiles.profiles.find(profile => profile.name === "ts85-b"), {
    name: "ts85-b", defaultUnitId: 1, canChangeUnitId: false, gateways: null,
    fields: [
      { name: "temperature_c", type: "holding", address: 0, count: 1, decode: "int16_tenths" },
      { name: "humidity_percent", type: "holding", address: 1, count: 1, decode: "uint16_tenths" },
      { name: "co2_ppm", type: "holding", address: 2, count: 1, decode: "uint16" }
    ]
  });
  const response = await fetch(`${base}/read-profile?host=10.107.31.25&port=502&unitId=7&profile=ts85-b`);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.target, { host: "10.107.31.25", port: 502, unitId: 7 });
  assert.equal(result.profile, "ts85-b");
  assert.deepEqual(result.data, { temperature_c: -10.1, humidity_percent: 56.7, co2_ppm: 423 });
  assert.ok(Number.isFinite(Date.parse(result.timestamp)));
  assert.deepEqual(calls[0], { type: "connect", host: "10.107.31.25", port: 502 });
  assert.equal(calls.filter(call => call.type === "holding").every(call => call.unitId === 7), true);
});

test("TS85-B propagates communication errors and closes the connection without partial success", async context => {
  sensor(context, [273, 567, 423]);
  context.mock.method(ModbusRTU.prototype, "readHoldingRegisters", async () => { throw new Error("TS85 timeout"); });
  await assert.rejects(readDeviceProfile({ host: "10.107.31.4", profile: "ts85-b" }), /TS85 timeout/);
  assert.equal(ModbusRTU.prototype.close.mock.callCount(), 1);
});
