const ModbusRTU = require("modbus-serial");
const config = require("./config");
const { setTimeout: delay } = require("node:timers/promises");

const REGISTER_DEFINITION = [
  { address: 0x00, name: "serial_number", count: 1 },
  { address: 0x16, name: "intensity", count: 2 },
  { address: 0x3c, name: "seconds_minutes", count: 1 },
  { address: 0x3d, name: "days_weeks", count: 1 },
  { address: 0x3e, name: "date_month", count: 1 },
  { address: 0x3f, name: "year", count: 1 }
];

const PROFILE_DEFINITIONS = {
  "polier-mm80lmzmod": {
    defaultUnitId: 91,
    fields: [
      { name: "serial_number", type: "holding", address: 0x00, count: 1, decode: "uint16" },
      { name: "intensity", type: "holding", address: 0x16, count: 2, decode: "float32be" },
      { name: "seconds_minutes", type: "holding", address: 0x3c, count: 1, decode: "seconds_minutes_bcd" },
      { name: "days_weeks", type: "holding", address: 0x3d, count: 1, decode: "day_month_bcd" },
      { name: "date_month", type: "holding", address: 0x3e, count: 1, decode: "day_month_bcd" },
      { name: "year", type: "holding", address: 0x3f, count: 1, decode: "year_bcd" }
    ]
  },
  "eastron-sdm120ct": {
    defaultUnitId: 1,
    canChangeUnitId: true,
    fields: [
      { name: "device_address", type: "holding", address: 0x0014, count: 2, decode: "float32be" },
      { name: "voltage_v", type: "input", address: 0x0000, count: 2, decode: "float32be" },
      { name: "current_a", type: "input", address: 0x0006, count: 2, decode: "float32be" },
      { name: "active_power_w", type: "input", address: 0x000c, count: 2, decode: "float32be" },
      { name: "power_factor", type: "input", address: 0x001e, count: 2, decode: "float32be" },
      { name: "frequency_hz", type: "input", address: 0x0046, count: 2, decode: "float32be" },
      { name: "import_energy_kwh", type: "input", address: 0x0048, count: 2, decode: "float32be" },
      { name: "export_energy_kwh", type: "input", address: 0x004a, count: 2, decode: "float32be" },
      { name: "total_energy_kwh", type: "input", address: 0x0156, count: 2, decode: "float32be" }
    ]
  },
  "ts85-b": {
    defaultUnitId: 1,
    fields: [
      { name: "temperature_c", type: "holding", address: 0x0000, count: 1, decode: "int16_tenths" },
      { name: "humidity_percent", type: "holding", address: 0x0001, count: 1, decode: "uint16_tenths" },
      { name: "co2_ppm", type: "holding", address: 0x0002, count: 1, decode: "uint16" }
    ]
  },
  "tuf-2000m": {
    defaultUnitId: 1,
    fields: [
      { name: "flow_rate_m3_h", type: "holding", address: 0, count: 2, decode: "float32be" },
      { name: "energy_flow_rate_gj_h", type: "holding", address: 2, count: 2, decode: "float32be" },
      { name: "velocity_m_s", type: "holding", address: 4, count: 2, decode: "float32be" },
      { name: "fluid_sound_speed_m_s", type: "holding", address: 6, count: 2, decode: "float32be" },
      { name: "net_total_m3", type: "holding", address: 112, count: 2, decode: "float32be" },
      { name: "positive_total_m3", type: "holding", address: 114, count: 2, decode: "float32be" },
      { name: "negative_total_m3", type: "holding", address: 116, count: 2, decode: "float32be" },
      { name: "net_energy_gj", type: "holding", address: 118, count: 2, decode: "float32be" },
      { name: "positive_energy_gj", type: "holding", address: 120, count: 2, decode: "float32be" },
      { name: "negative_energy_gj", type: "holding", address: 122, count: 2, decode: "float32be" },
      { name: "flow_today_m3", type: "holding", address: 124, count: 2, decode: "float32be" },
      { name: "flow_this_month_m3", type: "holding", address: 126, count: 2, decode: "float32be" },
      { name: "temperature_1_c", type: "holding", address: 32, count: 2, decode: "float32be" },
      { name: "temperature_2_c", type: "holding", address: 34, count: 2, decode: "float32be" },
      { name: "error_code", type: "holding", address: 71, count: 1, decode: "uint16" },
      { name: "working_step_signal_quality", type: "holding", address: 91, count: 1, decode: "uint16" },
      { name: "flow_rate_unit_code", type: "holding", address: 1436, count: 1, decode: "uint16" },
      { name: "totalizer_unit_code", type: "holding", address: 1437, count: 1, decode: "uint16" },
      { name: "totalizer_multiplier", type: "holding", address: 1438, count: 1, decode: "uint16" },
      { name: "energy_multiplier", type: "holding", address: 1439, count: 1, decode: "uint16" },
      { name: "energy_rate_unit_code", type: "holding", address: 1440, count: 1, decode: "uint16" },
      { name: "device_address", type: "holding", address: 1441, count: 1, decode: "uint16" }
    ]
  }
};

function decodeBcdByte(byte) {
  const tens = (byte >> 4) & 0x0f;
  const ones = byte & 0x0f;
  return tens * 10 + ones;
}

function decodeSecondsMinutes(raw) {
  const high = (raw >> 8) & 0xff;
  const low = raw & 0xff;
  return {
    seconds: decodeBcdByte(high),
    minutes: decodeBcdByte(low)
  };
}

function decodeDayMonth(raw) {
  const high = (raw >> 8) & 0xff;
  const low = raw & 0xff;
  return {
    high: decodeBcdByte(high),
    low: decodeBcdByte(low)
  };
}

function decodeYear(raw) {
  const high = (raw >> 8) & 0xff;
  const yy = decodeBcdByte(high);
  return 2000 + yy;
}

function decodeFloat32BE(highReg, lowReg) {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt16BE(highReg, 0);
  buffer.writeUInt16BE(lowReg, 2);
  return buffer.readFloatBE(0);
}

function decodeRegisterValue(definition, registers) {
  if (definition.count === 2) {
    return decodeFloat32BE(registers[0], registers[1]);
  }

  const raw = registers[0];

  if (definition.address === 0x3c) {
    return decodeSecondsMinutes(raw);
  }

  if (definition.address === 0x3f) {
    return decodeYear(raw);
  }

  if (definition.address === 0x3d || definition.address === 0x3e) {
    return decodeDayMonth(raw);
  }

  return raw;
}

function decodeByType(decode, registers) {
  if (decode === "uint16") {
    return registers[0];
  }

  if (decode === "int16_tenths") {
    const raw = registers[0];
    return (raw >= 0x8000 ? raw - 0x10000 : raw) / 10;
  }

  if (decode === "uint16_tenths") {
    return registers[0] / 10;
  }

  if (decode === "float32be") {
    return decodeFloat32BE(registers[0], registers[1]);
  }

  if (decode === "seconds_minutes_bcd") {
    return decodeSecondsMinutes(registers[0]);
  }

  if (decode === "day_month_bcd") {
    return decodeDayMonth(registers[0]);
  }

  if (decode === "year_bcd") {
    return decodeYear(registers[0]);
  }

  throw new Error(`Unsupported decode type: ${decode}`);
}

async function withClient(host, port, unitId, timeoutMs, fn) {
  const client = new ModbusRTU();

  try {
    await client.connectTCP(host, { port });
    client.setID(unitId);
    client.setTimeout(timeoutMs);
    return await fn(client);
  } finally {
    try {
      client.close();
    } catch (_err) {
      // Ignore close errors.
    }
  }
}

async function readMeter({ host, port = config.MODBUS_PORT, unitId = config.MODBUS_UNIT_ID, timeoutMs = config.MODBUS_TIMEOUT_MS }) {
  if (!host) {
    throw new Error("Modbus host is required");
  }

  return withClient(host, port, unitId, timeoutMs, async (client) => {
    const payload = {};

    for (const definition of REGISTER_DEFINITION) {
      const data = await client.readHoldingRegisters(definition.address, definition.count);
      payload[definition.name] = decodeRegisterValue(definition, data.data);
    }

    return payload;
  });
}

async function probeMeter({ host, port = config.MODBUS_PORT, unitId = config.MODBUS_UNIT_ID, timeoutMs = config.MODBUS_TIMEOUT_MS }) {
  return withClient(host, port, unitId, timeoutMs, async (client) => {
    const data = await client.readHoldingRegisters(0x00, 1);
    return data.data[0];
  });
}

async function discoverUnitIds({
  host,
  port = config.MODBUS_PORT,
  fromUnitId = 1,
  toUnitId = 247,
  timeoutMs = 400,
  probe = "both"
}) {
  if (!host) {
    throw new Error("Modbus host is required");
  }

  if (fromUnitId > toUnitId) {
    throw new Error("Invalid unit ID range: fromUnitId must be <= toUnitId");
  }

  const client = new ModbusRTU();
  const found = [];

  try {
    await client.connectTCP(host, { port });
    client.setTimeout(timeoutMs);

    for (let unitId = fromUnitId; unitId <= toUnitId; unitId += 1) {
      client.setID(unitId);

      if (probe === "holding" || probe === "both") {
        try {
          const data = await client.readHoldingRegisters(0x00, 1);
          found.push({
            unitId,
            method: "holding",
            address: 0,
            value: data.data
          });
          continue;
        } catch (_err) {
          // Try next probe type.
        }
      }

      if (probe === "input" || probe === "both") {
        try {
          const data = await client.readInputRegisters(0x00, 2);
          found.push({
            unitId,
            method: "input",
            address: 0,
            value: data.data
          });
        } catch (_err) {
          // No response for this unit ID.
        }
      }
    }

    return found;
  } finally {
    try {
      client.close();
    } catch (_err) {
      // Ignore close errors.
    }
  }
}

async function readRawRegisters({
  host,
  port = config.MODBUS_PORT,
  unitId,
  type = "holding",
  address = 0,
  count = 1,
  timeoutMs = config.MODBUS_TIMEOUT_MS
}) {
  if (!host) {
    throw new Error("Modbus host is required");
  }

  if (!unitId) {
    throw new Error("Modbus unitId is required");
  }

  return withClient(host, port, unitId, timeoutMs, async (client) => {
    if (type === "holding") {
      const data = await client.readHoldingRegisters(address, count);
      return data.data;
    }

    if (type === "input") {
      const data = await client.readInputRegisters(address, count);
      return data.data;
    }

    throw new Error("Unsupported register type. Use 'holding' or 'input'.");
  });
}

async function readDeviceProfile({
  host,
  profile,
  port = config.MODBUS_PORT,
  unitId,
  timeoutMs = config.MODBUS_TIMEOUT_MS
}) {
  if (!host) {
    throw new Error("Modbus host is required");
  }

  const profileDef = PROFILE_DEFINITIONS[profile];
  if (!profileDef) {
    throw new Error(`Unknown profile: ${profile}`);
  }

  const resolvedUnitId = unitId ?? profileDef.defaultUnitId;

  return withClient(host, port, resolvedUnitId, timeoutMs, async (client) => {
    const output = {};

    for (const field of profileDef.fields) {
      let readResult;
      if (field.type === "holding") {
        readResult = await client.readHoldingRegisters(field.address, field.count);
      } else if (field.type === "input") {
        readResult = await client.readInputRegisters(field.address, field.count);
      } else {
        throw new Error(`Unsupported field type: ${field.type}`);
      }

      output[field.name] = decodeByType(field.decode, readResult.data);
    }

    return {
      profile,
      unitId: resolvedUnitId,
      data: output
    };
  });
}

const changingGateways = new Set();

async function changeUnitId({ host, port = config.MODBUS_PORT, unitId, newUnitId, profile, setupConfirmed, timeoutMs = config.MODBUS_TIMEOUT_MS }) {
  if (!host || profile !== "eastron-sdm120ct" || setupConfirmed !== true ||
      !Number.isInteger(unitId) || unitId < 1 || unitId > 247 ||
      !Number.isInteger(newUnitId) || newUnitId < 1 || newUnitId > 247 || newUnitId === unitId) {
    throw Object.assign(new Error("Profil Eastron, mode SET confirme et deux Unit ID distincts entre 1 et 247 requis."), { statusCode: 400 });
  }
  const gateway = `${host}:${port}`;
  if (changingGateways.has(gateway)) {
    throw Object.assign(new Error("Un changement d'Unit ID est deja en cours sur cette passerelle."), { statusCode: 409 });
  }
  changingGateways.add(gateway);
  try {
    return await withClient(host, port, unitId, timeoutMs, async client => {
      const current = await client.readHoldingRegisters(0x0014, 2);
      if (decodeFloat32BE(...current.data) !== unitId) {
        throw Object.assign(new Error("L'adresse lue dans le compteur ne correspond pas a l'Unit ID cible. Aucune ecriture effectuee."), { statusCode: 409 });
      }
      client.setID(newUnitId);
      for (const probe of [
        () => client.readHoldingRegisters(0x0014, 2),
        () => client.readInputRegisters(0, 2)
      ]) {
        try {
          await probe();
        } catch (error) {
          if (error.errno === "ETIMEDOUT") continue;
          if (!error.modbusCode) throw error;
        }
        throw Object.assign(new Error("Le nouvel Unit ID repond deja sur cette passerelle. Aucune ecriture effectuee."), { statusCode: 409 });
      }
      client.setID(unitId);
      const bytes = Buffer.alloc(4);
      bytes.writeFloatBE(newUnitId);
      try {
        await client.writeRegisters(0x0014, [bytes.readUInt16BE(0), bytes.readUInt16BE(2)]);
        await delay(300);
        client.setID(newUnitId);
        const verified = await client.readHoldingRegisters(0x0014, 2);
        if (decodeFloat32BE(...verified.data) !== newUnitId) throw new Error("Adresse relue differente de l'adresse demandee.");
      } catch (error) {
        throw Object.assign(new Error(`Changement non confirme : ${error.message}. L'adresse peut avoir change. Rechercher les deux Unit ID avant toute nouvelle ecriture ; verifier le mode SET.`), { statusCode: 502 });
      }
      return { previousUnitId: unitId, unitId: newUnitId, verified: true };
    });
  } finally {
    changingGateways.delete(gateway);
  }
}

module.exports = {
  REGISTER_DEFINITION,
  PROFILE_DEFINITIONS,
  readMeter,
  probeMeter,
  discoverUnitIds,
  readRawRegisters,
  readDeviceProfile,
  changeUnitId
};
