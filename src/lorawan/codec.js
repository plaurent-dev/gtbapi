function measurement(name, value, unit = "") {
  return { name, value, unit };
}

function decodeLds02(port, bytes) {
  if (port !== 10) return null;
  if (bytes.length !== 10 || bytes[2] !== 1) throw new Error("Invalid LDS02 FPort 10 payload");
  return [
    measurement("door_open", (bytes[0] & 0x80) === 0 ? 0 : 1),
    measurement("battery_voltage", (((bytes[0] << 8) | bytes[1]) & 0x3fff) / 1000, "V"),
    measurement("door_open_count", bytes.readUIntBE(3, 3)),
    measurement("last_open_duration", bytes.readUIntBE(6, 3), "min"),
    measurement("alarm", bytes[9] & 1)
  ];
}

function decodedMeasurements(object) {
  if (!object || typeof object !== "object" || Array.isArray(object)) return [];
  const result = [];
  for (const [name, value] of Object.entries(object)) {
    if (!name || name.length > 200) continue;
    if (typeof value === "number" && Number.isFinite(value)) result.push(measurement(name, value));
    else if (typeof value === "boolean") result.push(measurement(name, Number(value)));
    if (result.length > 100) throw new Error("Too many decoded measurements");
  }
  return result;
}

function decodeUplink({ port, bytes, object, profileId, profileName }, lds02ProfileIds = []) {
  const lds02 = lds02ProfileIds.includes(profileId) || /^(dragino[-_ ]?)?lds02$/i.test(profileName.trim());
  if (lds02) {
    const values = decodeLds02(port, bytes);
    if (values) return { status: "decoded", measurements: values };
  }
  const values = decodedMeasurements(object);
  return { status: values.length ? "decoded" : "unsupported", measurements: values };
}

module.exports = { decodeLds02, decodeUplink };
