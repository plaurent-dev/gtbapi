const ModbusRTU = require("modbus-serial");
const config = require("./config");

const REGISTER_DEFINITION = [
  { address: 0x00, name: "serial_number", count: 1 },
  { address: 0x16, name: "intensity", count: 2 },
  { address: 0x3c, name: "seconds_minutes", count: 1 },
  { address: 0x3d, name: "days_weeks", count: 1 },
  { address: 0x3e, name: "date_month", count: 1 },
  { address: 0x3f, name: "year", count: 1 }
];

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

module.exports = {
  REGISTER_DEFINITION,
  readMeter,
  probeMeter,
  discoverUnitIds
};
