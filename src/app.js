const express = require("express");
const { z } = require("zod");
const pinoHttp = require("pino-http");
const config = require("./config");
const logger = require("./logger");
const { readMeter, discoverUnitIds } = require("./modbus");
const { discoverMeters } = require("./discovery");
const { publishMeasurements } = require("./publisher");

const app = express();
app.disable("x-powered-by");

function zodIssues(error) {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message
  }));
}

app.use(express.json({ limit: "100kb" }));
app.use(
  pinoHttp({
    logger,
    customLogLevel: (req, res, err) => {
      if (err || res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      if (res.statusCode >= 300) return "silent";
      return "info";
    }
  })
);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

const readQuerySchema = z.object({
  host: z.string().optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  unitId: z.coerce.number().int().min(1).max(247).optional(),
  timeoutMs: z.coerce.number().int().min(100).max(30000).optional(),
  publish: z
    .string()
    .optional()
    .transform((v) => v === "true")
});

app.get("/api/v1/meter/read", async (req, res, next) => {
  try {
    const parsed = readQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid query", details: zodIssues(parsed.error) });
    }

    const { host = config.MODBUS_HOST, port, unitId, timeoutMs, publish } = parsed.data;
    if (!host) {
      return res.status(400).json({
        error: "Missing host",
        message: "Provide ?host=x.x.x.x or set MODBUS_HOST in .env"
      });
    }

    const data = await readMeter({ host, port, unitId, timeoutMs });

    if (publish) {
      publishMeasurements(data);
    }

    return res.json({
      target: { host, port: port ?? config.MODBUS_PORT, unitId: unitId ?? config.MODBUS_UNIT_ID },
      timestamp: new Date().toISOString(),
      data
    });
  } catch (err) {
    return next(err);
  }
});

const discoverQuerySchema = z.object({
  subnet: z.string().optional(),
  from: z.coerce.number().int().min(1).max(254).optional(),
  to: z.coerce.number().int().min(1).max(254).optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  unitId: z.coerce.number().int().min(1).max(247).optional(),
  timeoutMs: z.coerce.number().int().min(100).max(5000).optional(),
  concurrency: z.coerce.number().int().min(1).max(256).optional(),
  verifyModbus: z
    .string()
    .optional()
    .transform((v) => v !== "false")
});

app.get("/api/v1/meter/discover", async (req, res, next) => {
  try {
    const parsed = discoverQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid query", details: zodIssues(parsed.error) });
    }

    const result = await discoverMeters(parsed.data);
    return res.json({
      count: result.length,
      result
    });
  } catch (err) {
    return next(err);
  }
});

const discoverUnitIdQuerySchema = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  fromUnitId: z.coerce.number().int().min(1).max(247).optional(),
  toUnitId: z.coerce.number().int().min(1).max(247).optional(),
  timeoutMs: z.coerce.number().int().min(100).max(5000).optional(),
  probe: z.enum(["holding", "input", "both"]).optional()
});

app.get("/api/v1/meter/discover-unitid", async (req, res, next) => {
  try {
    const parsed = discoverUnitIdQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid query", details: zodIssues(parsed.error) });
    }

    const {
      host,
      port,
      fromUnitId,
      toUnitId,
      timeoutMs,
      probe
    } = parsed.data;

    const result = await discoverUnitIds({
      host,
      port,
      fromUnitId,
      toUnitId,
      timeoutMs,
      probe
    });

    return res.json({
      target: { host, port: port ?? config.MODBUS_PORT },
      range: {
        fromUnitId: fromUnitId ?? 1,
        toUnitId: toUnitId ?? 247
      },
      probe: probe ?? "both",
      count: result.length,
      result
    });
  } catch (err) {
    return next(err);
  }
});

app.use((err, _req, res, _next) => {
  logger.error({ err }, "Unhandled error");
  res.status(500).json({ error: "Internal server error", message: err.message });
});

module.exports = app;
