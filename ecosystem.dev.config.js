module.exports = {
  apps: [
    {
      name: "gtb-api-dev",
      script: "src/server.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      watch: false,
      max_memory_restart: "200M",
      env: {
        NODE_ENV: "development",
        PORT: 7001,
        PGHOST: "localhost",
        PGPORT: 5432,
        PGDATABASE: "gtb_db_restore",
        POLL_INTERVAL_MS: 0
      }
    }
  ]
};
