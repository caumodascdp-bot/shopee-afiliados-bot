const path = require('path');

module.exports = {
  apps: [
    {
      name: 'shopee-bot',
      script: path.join(__dirname, 'index.js'),
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '350M',
      kill_timeout: 15000,
      out_file: path.join(__dirname, 'logs', 'pm2-out.log'),
      error_file: path.join(__dirname, 'logs', 'pm2-error.log'),
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        PORT: 3850,
      },
    },
  ],
};
