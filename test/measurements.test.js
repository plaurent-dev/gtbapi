const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { createMeasurementsPool, INSERT_MEASUREMENT_SQL } = require("../src/measurements");
const { createProfileInventoryPool } = require("../src/profile-inventory");
const app = require("../src/app");

const KEY = "measurement-test-key-not-a-real-secret";
const measurement = {
  time: "2026-10-05T14:00:00.123456+02:00",
  capteur_id: 501,
  valeur: -10.1,
  site: "CORDON_SMB",
  waveshare_ip: "192.0.2.10",
  mesure: "temperature",
  unite: "degC"
};

async function fixture(context, { key = KEY, pool } = {}) {
  const previous = { ...app.locals };
  const calls = [];
  app.locals.measurementsApiKey = key;
  app.locals.measurementsPool = pool === undefined ? {
    query: async (sql, values) => { calls.push({ sql, values }); return { rowCount: 1 }; }
  } : pool;
  app.locals.profileInventoryPool = null;
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  context.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    Object.assign(app.locals, previous);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body = measurement, headers = {}) => fetch(`${base}/api/v1/meter/measurements`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
  return { base, post, calls };
}

test("one POST maps all seven columns to one parameterized INSERT and preserves source microseconds", async context => {
  const { post, calls } = await fixture(context);
  const response = await post();
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { inserted: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sql, INSERT_MEASUREMENT_SQL);
  assert.match(calls[0].sql, /INSERT INTO public\.mesures_rs485\s+\(time, capteur_id, valeur, site, waveshare_ip, mesure, unite\)/);
  assert.match(calls[0].sql, /VALUES \(\$1::timestamptz, \$2::integer, \$3::double precision, \$4::text, \$5::inet, \$6::text, \$7::text\)/);
  assert.doesNotMatch(calls[0].sql, /RETURNING|ON CONFLICT/i);
  assert.deepEqual(calls[0].values, Object.values(measurement));
});

test("each repeated POST appends, including a zero value and an empty unit", async context => {
  const { post, calls } = await fixture(context);
  const body = { ...measurement, valeur: 0, unite: "" };
  for (let i = 0; i < 2; i++) {
    assert.equal((await post(body)).status, 201);
  }
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[0].values[2], 0);
  assert.equal(calls[0].values[6], "");
});

test("text is parameterized, not SQL, and surrounding metadata whitespace is trimmed", async context => {
  const { post, calls } = await fixture(context);
  const site = "test'); DROP TABLE public.mesures_rs485; --";
  assert.equal((await post({ ...measurement, site: ` ${site} `, mesure: " energie ", valeur: 123.45 })).status, 201);
  assert.equal(calls[0].values[3], site);
  assert.equal(calls[0].values[5], "energie");
  assert.doesNotMatch(calls[0].sql, /DROP TABLE/);
});

test("authentication precedes JSON parsing and all database access", async context => {
  const { post, calls, base } = await fixture(context);
  for (const authorization of ["", "Basic abc", "Bearer wrong-key", `Bearer ${KEY} extra`, `Bearer ${KEY},Bearer ${KEY}`]) {
    const response = await post("{ invalid JSON", { authorization });
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate"), /^Bearer /);
    assert.doesNotMatch(JSON.stringify(await response.json()), new RegExp(KEY));
  }
  const noHeader = await fetch(`${base}/api/v1/meter/measurements`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(measurement)
  });
  assert.equal(noHeader.status, 401);
  assert.equal(calls.length, 0);
  assert.equal((await post(measurement, { authorization: `bearer ${KEY}` })).status, 201);
});

test("missing API key disables ingestion without breaking health or profiles", async context => {
  const { post, base, calls } = await fixture(context, { key: "" });
  const response = await post();
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /MEASUREMENTS_API_KEY/);
  assert.equal(calls.length, 0);
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/api/v1/meter/profiles`)).status, 200);
});

test("configured key without PostgreSQL configuration returns 503, not success", async context => {
  const { post } = await fixture(context, { pool: null });
  const response = await post();
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /PGUSER/);
});

const invalidBodies = [
  ["numeric string identifier", { capteur_id: "1" }],
  ["numeric string value", { valeur: "23.4" }],
  ["zero identifier", { capteur_id: 0 }],
  ["fractional identifier", { capteur_id: 1.2 }],
  ["identifier overflow", { capteur_id: 2147483648 }],
  ["null value", { valeur: null }],
  ["missing timestamp offset", { time: "2026-10-05T12:00:00" }],
  ["impossible date", { time: "2026-02-30T12:00:00Z" }],
  ["invalid timestamp", { time: "yesterday" }],
  ["empty site", { site: "  " }],
  ["oversized site", { site: "a".repeat(201) }],
  ["empty metric", { mesure: "" }],
  ["oversized metric", { mesure: "a".repeat(201) }],
  ["oversized unit", { unite: "a".repeat(201) }],
  ["null unit", { unite: null }],
  ["IPv6 gateway", { waveshare_ip: "::1" }],
  ["hostname gateway", { waveshare_ip: "localhost" }],
  ["CIDR gateway", { waveshare_ip: "192.0.2.10/24" }],
  ["invalid IPv4", { waveshare_ip: "256.0.2.10" }],
  ["unknown field", { unexpected: "value" }]
];
for (const [name, changes] of invalidBodies) {
  test(`rejects ${name} without any database access`, async context => {
    const { post, calls } = await fixture(context);
    const response = await post({ ...measurement, ...changes });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "Mesure invalide.");
    assert.equal(calls.length, 0);
  });
}

test("requires all seven fields and rejects arrays or non-finite JSON numbers", async context => {
  const { post, calls } = await fixture(context);
  for (const field of Object.keys(measurement)) {
    const body = { ...measurement };
    delete body[field];
    assert.equal((await post(body)).status, 400, field);
  }
  assert.equal((await post([measurement])).status, 400);
  assert.equal((await post(JSON.stringify(measurement).replace('"valeur":-10.1', '"valeur":1e999'))).status, 400);
  assert.equal(calls.length, 0);
});

test("rejects malformed, oversized, compressed and non-JSON bodies explicitly", async context => {
  const { post, calls } = await fixture(context);
  for (const [body, headers, status] of [
    ["{ broken", {}, 400],
    ["null", {}, 400],
    ["", {}, 400],
    [JSON.stringify({ ...measurement, site: "a".repeat(17000) }), {}, 413],
    [measurement, { "content-type": "text/plain" }, 415],
    [measurement, { "content-encoding": "gzip" }, 415],
    [measurement, { "content-type": "application/json; charset=iso-8859-1" }, 415]
  ]) {
    const response = await post(body, headers);
    assert.equal(response.status, status);
    assert.equal(typeof (await response.json()).error, "string");
  }
  assert.equal(calls.length, 0);
});

for (const [code, status, outcome] of [
  ["23514", 400, "not_inserted"],
  ["23505", 409, "not_inserted"],
  ["22008", 400, "not_inserted"],
  ["42P01", 503, "not_inserted"],
  ["42703", 503, "not_inserted"],
  ["42501", 503, "not_inserted"],
  ["25006", 503, "not_inserted"],
  ["57014", 503, "unknown"],
  ["ECONNRESET", 503, "unknown"],
  [undefined, 503, "unknown"]
]) {
  test(`sanitizes database failure ${code} and never retries automatically`, async context => {
    let attempts = 0;
    const { post, base } = await fixture(context, { pool: { query: async () => {
      attempts++;
      throw Object.assign(new Error("private credentials and SQL"), { code });
    } } });
    const response = await post();
    assert.equal(response.status, status);
    const body = await response.json();
    assert.equal(body.outcome, outcome);
    assert.doesNotMatch(JSON.stringify(body), /private|credentials|SQL"/);
    if (outcome === "unknown") assert.match(body.error, /doublon/);
    assert.equal(attempts, 1);
    assert.equal((await fetch(`${base}/api/v1/meter/profiles`)).status, 200);
  });
}

test("unexpected INSERT counts cannot return a success response", async context => {
  const { post } = await fixture(context, { pool: { query: async () => ({ rowCount: 0 }) } });
  const response = await post();
  assert.equal(response.status, 503);
  assert.equal((await response.json()).outcome, "unknown");
});

test("write pool is lazy, bounded, separately writable, and disabled without a key or user", async context => {
  const config = {
    PGHOST: "192.0.2.1", PGPORT: 5432, PGDATABASE: "test",
    PGUSER: "test", PGPASSWORD: "not-a-real-password", MEASUREMENTS_API_KEY: KEY
  };
  assert.equal(createMeasurementsPool({ ...config, PGUSER: "" }), null);
  assert.equal(createMeasurementsPool({ ...config, MEASUREMENTS_API_KEY: "" }), null);
  const writePool = createMeasurementsPool(config);
  const readPool = createProfileInventoryPool(config);
  context.after(async () => { await Promise.all([writePool.end(), readPool.end()]); });
  assert.notEqual(writePool, readPool);
  assert.equal(writePool.totalCount, 0);
  assert.equal(writePool.options.max, 2);
  assert.equal(writePool.options.connectionTimeoutMillis, 3000);
  assert.equal(writePool.options.statement_timeout, 3000);
  assert.equal(writePool.options.query_timeout, 4000);
  assert.equal(writePool.options.options, "-c default_transaction_read_only=off");
  assert.equal(readPool.options.options, "-c default_transaction_read_only=on");
});

test("HTTP logs redact the actual Authorization header", () => {
  const script = `
    const app = require("./src/app");
    const server = app.listen(0, "127.0.0.1", async () => {
      try {
        const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/v1/meter/measurements", {
          method: "POST",
          headers: { authorization: "Bearer " + process.env.MEASUREMENTS_API_KEY, "content-type": "application/json" },
          body: JSON.stringify(${JSON.stringify(measurement)})
        });
        await response.text();
        if (response.status !== 503) process.exitCode = 1;
      } finally {
        server.close();
        server.closeAllConnections();
      }
    });
  `;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, LOG_LEVEL: "info", PGUSER: "", MEASUREMENTS_API_KEY: KEY },
    encoding: "utf8",
    timeout: 10000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"authorization":"\[Redacted\]"/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(KEY));
});
