const { z } = require("zod");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.string().default("info"),

  MODBUS_HOST: z.string().optional().default(""),
  MODBUS_PORT: z.coerce.number().int().min(1).max(65535).default(4196),
  MODBUS_UNIT_ID: z.coerce.number().int().min(1).max(247).default(91),
  MODBUS_TIMEOUT_MS: z.coerce.number().int().min(200).max(30000).default(2000),

  POLL_INTERVAL_MS: z.coerce.number().int().min(0).max(3600000).default(0),

  DEFAULT_SUBNET: z.string().default("192.168.1"),
  DISCOVERY_FROM: z.coerce.number().int().min(1).max(254).default(1),
  DISCOVERY_TO: z.coerce.number().int().min(1).max(254).default(254),
  DISCOVERY_PORT: z.coerce.number().int().min(1).max(65535).default(4196),
  DISCOVERY_TIMEOUT_MS: z.coerce.number().int().min(100).max(5000).default(700),
  DISCOVERY_CONCURRENCY: z.coerce.number().int().min(1).max(256).default(40),

  MQTT_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
  MQTT_URL: z.string().default("mqtt://127.0.0.1:1883"),
  MQTT_TOPIC: z.string().default("modbus/mesures"),

  GELF_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
  GELF_HOST: z.string().default("127.0.0.1"),
  GELF_PORT: z.coerce.number().int().min(1).max(65535).default(12201)
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((i) => `${i.path.join(".")}: ${i.message}`)
    .join("; ");
  throw new Error(`Invalid environment configuration: ${details}`);
}

module.exports = parsed.data;
