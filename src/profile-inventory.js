const { Pool } = require("pg");
const logger = require("./logger");

function createProfileInventoryPool(config) {
  if (!config.PGUSER) return null;
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
    options: "-c default_transaction_read_only=on"
  });
  pool.on("error", error => logger.warn({ code: error.code }, "Profile inventory connection failed"));
  return pool;
}

async function readProfileInventory(pool, profileNames) {
  const unavailable = warning => ({ gatewaysAvailable: false, gatewaysWarning: warning, byProfile: null });
  if (!pool) {
    return unavailable("Inventaire des passerelles non configure dans GTBApi : renseigner PGUSER et les variables PostgreSQL. Les lectures Modbus restent disponibles.");
  }
  try {
    const { rows } = await pool.query(`SELECT s.profile,host(s.host) AS host,s.port,s.unit_id AS "unitId"
      FROM public.gtb_sensors s WHERE s.profile=ANY($1::text[])
      ORDER BY s.profile,s.host,s.port,s.unit_id LIMIT 1001`, [profileNames]);
    if (rows.length > 1000) {
      return unavailable("Inventaire des passerelles trop volumineux : maximum 1000 capteurs. Aucune liste partielle renvoyee.");
    }
    const byProfile = new Map(profileNames.map(name => [name, []]));
    for (const row of rows) {
      byProfile.get(row.profile).push({ host: row.host, port: row.port, unitId: row.unitId });
    }
    return { gatewaysAvailable: true, gatewaysWarning: null, byProfile };
  } catch (error) {
    logger.warn({ code: error.code || error.name }, "Profile gateway inventory unavailable");
    const warning = ["42P01", "42703"].includes(error.code)
      ? "Inventaire des passerelles indisponible : verifier public.gtb_sensors et la migration 009 de cordongtb."
      : error.code === "42501"
        ? "Inventaire des passerelles indisponible : droits PostgreSQL de lecture insuffisants."
        : "Inventaire des passerelles indisponible : verifier la connexion PostgreSQL.";
    return unavailable(`${warning} Les lectures Modbus restent disponibles.`);
  }
}

module.exports = { createProfileInventoryPool, readProfileInventory };
