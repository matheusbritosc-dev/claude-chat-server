'use strict';

/**
 * PM2 Ecosystem Config
 * Deploy: pm2 start ecosystem.config.js --env production
 * Logs:   pm2 logs shopee-automation
 */

module.exports = {
  apps: [
    {
      name: 'shopee-automation',
      script: './orchestrator.js',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      env: {
        NODE_ENV: 'development',
        PORT: 3457,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3457,
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: './logs/error.log',
      out_file: './logs/out.log',
      merge_logs: true,
      max_memory_restart: '512M',
    },
  ],
};
