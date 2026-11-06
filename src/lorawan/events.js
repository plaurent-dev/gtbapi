const { z } = require("zod");
const { decodeUplink } = require("./codec");

class UplinkConflictError extends Error {}

const uuid = z.uuid();
const eui = z.string().regex(/^[0-9a-f]{16}$/);
const infoSchema = z.object({
  tenantId: uuid, applicationId: uuid, deviceProfileId: uuid,
  deviceProfileName: z.string().max(255), devEui: eui
}).passthrough();
const eventSchema = z.object({
  deduplicationId: uuid,
  time: z.iso.datetime({ offset: true }).optional(),
  deviceInfo: infoSchema,
  fPort: z.number().int().min(1).max(255),
  data: z.string().max(2048).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  object: z.record(z.string(), z.unknown()).nullable().optional(),
  rxInfo: z.array(z.object({
    gatewayId: eui, rssi: z.number().finite().optional(), snr: z.number().finite().optional(),
    gwTime: z.iso.datetime({ offset: true }).optional(), nsTime: z.iso.datetime({ offset: true }).optional()
  }).passthrough()).max(50).default([])
}).passthrough();

function parseUplink(topic, payload, tenantId, lds02ProfileIds = [], receivedAt = new Date().toISOString()) {
  if (!Buffer.isBuffer(payload) || payload.length > 65536) throw new Error("MQTT message exceeds 64 KiB");
  let value;
  try { value = JSON.parse(payload.toString("utf8")); }
  catch { throw new Error("Invalid MQTT JSON"); }
  const parsed = eventSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid ChirpStack uplink fields");
  const event = parsed.data;
  const info = event.deviceInfo;
  if (info.tenantId !== tenantId || topic !== `application/${info.applicationId}/device/${info.devEui}/event/up`) {
    throw new Error("MQTT topic or tenant does not match uplink");
  }
  const bytes = Buffer.from(event.data, "base64");
  if (bytes.toString("base64") !== event.data) throw new Error("Invalid base64 payload");
  let decoded;
  try {
    decoded = decodeUplink({ port: event.fPort, bytes, object: event.object,
      profileId: info.deviceProfileId, profileName: info.deviceProfileName }, lds02ProfileIds);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    decoded = { status: "invalid", measurements: [], error: error.message };
  }
  return {
    tenantId, deduplicationId: event.deduplicationId, applicationId: info.applicationId,
    devEui: info.devEui, profileId: info.deviceProfileId, profileName: info.deviceProfileName,
    fPort: event.fPort, bytes, object: event.object ?? null,
    rxInfo: event.rxInfo.map(({ gatewayId, rssi, snr, gwTime, nsTime }) => ({ gatewayId, rssi, snr, gwTime, nsTime })),
    sourceTime: event.time ?? null, receivedAt, ...decoded
  };
}

async function storeUplink(pool, event) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(`INSERT INTO public.gtb_lorawan_events
      (tenant_id, deduplication_id, application_id, dev_eui, profile_id, profile_name, f_port,
       payload, decoded_object, rx_info, source_time, received_at, decode_status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::timestamptz,$12::timestamptz,$13)
      ON CONFLICT (tenant_id,deduplication_id) DO NOTHING RETURNING deduplication_id`,
    [event.tenantId, event.deduplicationId, event.applicationId, event.devEui, event.profileId,
      event.profileName, event.fPort, event.bytes, JSON.stringify(event.object), JSON.stringify(event.rxInfo),
      event.sourceTime, event.receivedAt, event.status]);
    if (inserted.rowCount) {
      for (const item of event.measurements) {
        await client.query(`INSERT INTO public.gtb_lorawan_measurements
          (tenant_id, deduplication_id, name, unit, value) VALUES ($1,$2,$3,$4,$5)`,
        [event.tenantId, event.deduplicationId, item.name, item.unit, item.value]);
      }
    } else {
      const previous = await client.query(`SELECT application_id, dev_eui, f_port, payload FROM public.gtb_lorawan_events
        WHERE tenant_id=$1 AND deduplication_id=$2`, [event.tenantId, event.deduplicationId]);
      const row = previous.rows[0];
      if (!row || row.application_id !== event.applicationId || row.dev_eui !== event.devEui
        || row.f_port !== event.fPort || !Buffer.from(row.payload).equals(event.bytes)) {
        throw new UplinkConflictError("Conflicting uplinks share a deduplication ID");
      }
    }
    await client.query("COMMIT");
    return inserted.rowCount === 1;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (rollbackError) {
      error.rollbackError = rollbackError;
    }
    throw error;
  } finally { client.release(); }
}

module.exports = { parseUplink, storeUplink, UplinkConflictError };
