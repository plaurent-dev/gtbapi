const { z } = require("zod");

const binaryState = z.union([z.literal(0), z.literal(1), z.boolean()]).transform(Number);
const lds02Fields = {
  door_open: binaryState,
  battery_voltage: z.number().finite().nonnegative(),
  door_open_count: z.number().int().min(0).max(16777215),
  last_open_duration: z.number().int().min(0).max(16777215),
  alarm: binaryState
};

function decodedMeasurements(object, lds02) {
  if (!object || typeof object !== "object" || Array.isArray(object)) return [];
  const result = [];
  for (const [name, original] of Object.entries(object)) {
    let value = original;
    if (lds02 && Object.hasOwn(lds02Fields, name)) {
      const parsed = lds02Fields[name].safeParse(value);
      if (!parsed.success) throw new Error(`Invalid ChirpStack LDS02 measurement: ${name}`);
      value = parsed.data;
    }
    if (typeof value === "boolean") value = Number(value);
    if (typeof value !== "number") continue;
    if (!Number.isFinite(value)) throw new Error(`Non-finite ChirpStack measurement: ${name}`);
    if (!name || name.length > 200) throw new Error("Invalid ChirpStack measurement name");
    const unit = lds02 && name === "battery_voltage" ? "V"
      : lds02 && name === "last_open_duration" ? "min" : "";
    result.push({ name, value, unit });
    if (result.length > 100) throw new Error("Too many decoded measurements");
  }
  return result;
}

function decodeUplink({ object, profileId, profileName }, lds02ProfileIds = []) {
  const lds02 = lds02ProfileIds.includes(profileId) || /^(dragino[-_ ]?)?lds02$/i.test(profileName.trim());
  const values = decodedMeasurements(object, lds02);
  if (!values.length) {
    return { status: "unsupported", measurements: [], error: "No numeric measurements in ChirpStack object; configure its device-profile codec" };
  }
  return { status: "decoded", measurements: values };
}

module.exports = { decodeUplink };
