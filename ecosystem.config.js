module.exports = {
  apps: [
    {
      name: "gtb-api",
      script: "src/server.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      watch: false,
      max_memory_restart: "200M",
      env: {
        NODE_ENV: "production",
        PORT: 3000
      }
    }
  ]
};
