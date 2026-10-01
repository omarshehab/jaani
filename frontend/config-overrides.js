module.exports = function override(config, env) {
  // Disable host check for ngrok
  config.devServer = {
    ...config.devServer,
    allowedHosts: ['localhost', '127.0.0.1'],
  };
  return config;
};
