module.exports = {
  apps: [
    {
      name: "telegram-bot-v2",
      script: "./bot.js",
      watch: false,
      ignore_watch: ["node_modules", "users", "sessions.json", "domains.json", "backups"],
      env: {
        NODE_ENV: "production",
      },
      env_development: {
        NODE_ENV: "development",
        watch: true
      },
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "./logs/err.log",
      out_file: "./logs/out.log",
      merge_logs: true,
      autorestart: true
    }
  ]
};
