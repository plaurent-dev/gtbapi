const { createHash, timingSafeEqual } = require("node:crypto");
const express = require("express");
const { Pool } = require("pg");
const { z } = require("zod");
const logger = require("./logger");

const measurementSchema = z.strictObject({
  time: z.iso.datetime({ offset: true }).max(64),
  capteur_id: z.number().int().min(1).max(2147483647),
  valeur: z.number().finite(),
  site: z.string().trim().min(1).max(200),
  waveshare_ip: z.ipv4(),
  mesure: z.string().trim().min(1).max(200),
  unite: z.string().trim().max(200)
});

const INSERT_MEASUREMENT_SQL = `INSERT INTO public.mesures_rs485
  (time, capteur_id, valeur, site, waveshare_ip, mesure, unite)
  VALUES ($1::timestamptz, $2::integer, $3::double precision, $4::text, $5::inet, $6::text, $7::text)`;

function createMeasurementsPool(config) {
  if (!config.PGUSER || !config.MEASUREMENTS_API_KEY) return null;
  const pool = new Pool({
    host: config.PGHOST,
    port: config.PGPORT,
    database: config.PGDATABASE,
    user: config.PGUSER,
    password: config.PGPASSWORD,
    max: 2,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 30000,
    statement_timeout: 3000,
    query_timeout: 4000,
    allowExitOnIdle: true,
    options: "-c default_transaction_read_only=off"
  });
  pool.on("error", error => logger.warn({ code: error.code }, "Measurement connection failed"));
  return pool;
}

function authenticate(req, res, next) {
  const key = req.app.locals.measurementsApiKey;
  if (!key) {
    return res.status(503).json({ error: "Insertion desactivee : configurer MEASUREMENTS_API_KEY dans GTBApi." });
  }
  const match = /^Bearer +([A-Za-z0-9._~+/-]+={0,2})$/i.exec(req.get("authorization") || "");
  // Fixed-size digests also avoid revealing the configured key's length.
  const digest = value => createHash("sha256").update(value).digest();
  if (!match || !timingSafeEqual(digest(match[1]), digest(key))) {
    res.set("WWW-Authenticate", 'Bearer realm="gtb-measurements"');
    return res.status(401).json({ error: "Cle Bearer absente ou invalide." });
  }
  next();
}

function createMeasurementsRouter() {
  const router = express.Router();
  router.post("/", authenticate, (req, res, next) => {
    if (!req.is("application/json")) {
      return res.status(415).json({ error: "Content-Type application/json requis." });
    }
    next();
  }, express.json({ limit: "16kb", inflate: false }), async (req, res) => {
    const parsed = measurementSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Mesure invalide.",
        details: parsed.error.issues.map(issue => ({ path: issue.path.join("."), message: issue.message }))
      });
    }
    const pool = req.app.locals.measurementsPool;
    if (!pool) {
      return res.status(503).json({ error: "Insertion indisponible : configurer PGUSER et la connexion PostgreSQL dans GTBApi." });
    }
    const { time, capteur_id, valeur, site, waveshare_ip, mesure, unite } = parsed.data;
    try {
      const result = await pool.query(INSERT_MEASUREMENT_SQL, [
        time, capteur_id, valeur, site, waveshare_ip, mesure, unite
      ]);
      if (result.rowCount !== 1) {
        logger.error({ rowCount: result.rowCount }, "Unexpected measurement insert count");
        return res.status(503).json({
          error: "Insertion non confirmee. Verifier l'historique avant de renvoyer : un nouvel appel peut creer un doublon.",
          outcome: "unknown"
        });
      }
      return res.status(201).json({ inserted: 1 });
    } catch (error) {
      logger.warn({ code: error.code || error.name }, "Measurement insert failed");
      if (/^(22|23)/.test(error.code || "")) {
        return res.status(error.code === "23505" ? 409 : 400).json({
          error: "Mesure refusee par les contraintes PostgreSQL. Aucune ligne inseree.",
          outcome: "not_inserted"
        });
      }
      if (["42P01", "42703", "42501", "25006"].includes(error.code)) {
        return res.status(503).json({
          error: "Insertion indisponible : verifier public.mesures_rs485, ses colonnes et le droit INSERT du role PostgreSQL sur une connexion en ecriture.",
          outcome: "not_inserted"
        });
      }
      return res.status(503).json({
        error: "Insertion non confirmee (connexion PostgreSQL ou delai depasse). Verifier l'historique avant de renvoyer : un nouvel appel peut creer un doublon.",
        outcome: "unknown"
      });
    }
  });
  router.use((error, _req, res, next) => {
    if (error.type === "entity.too.large") {
      return res.status(413).json({ error: "Corps JSON trop volumineux : maximum 16 Kio." });
    }
    if (error.status === 415) {
      return res.status(415).json({ error: "Encodage non pris en charge : envoyer du JSON UTF-8 non compresse." });
    }
    if (error.type === "entity.parse.failed" || error.type === "request.size.invalid") {
      return res.status(400).json({ error: "Corps JSON invalide." });
    }
    next(error);
  });
  return router;
}

module.exports = { createMeasurementsPool, createMeasurementsRouter, INSERT_MEASUREMENT_SQL };
