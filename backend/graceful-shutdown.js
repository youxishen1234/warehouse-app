function installGracefulShutdown(server, options = {}) {
  const runtime = options.runtime || process;
  const logger = options.logger || console;
  const configuredTimeout = Number(options.timeoutMs ?? process.env.WAREHOUSE_SHUTDOWN_TIMEOUT_MS);
  const timeout = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? Math.min(60000, Math.max(1000, configuredTimeout))
    : 10000;
  let shuttingDown = false;
  const trackResponse = (_req, res) => {
    let completed = false;
    const onComplete = () => {
      if (completed) return;
      completed = true;
      if (shuttingDown) setImmediate(() => server.closeIdleConnections?.());
    };
    res.once('finish', onComplete);
    res.once('close', onComplete);
  };
  server.prependListener('request', trackResponse);

  const shutdown = signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.log(`[server] received ${signal}; draining in-flight requests`);
    const forceTimer = setTimeout(() => {
      logger.error(`[server] shutdown timed out after ${timeout}ms; closing remaining connections`);
      server.closeAllConnections?.();
    }, timeout);
    forceTimer.unref();
    server.close(error => {
      clearTimeout(forceTimer);
      server.off('request', trackResponse);
      if (error) {
        logger.error('[server] graceful shutdown failed:', error.message);
        runtime.exitCode = 1;
        return;
      }
      logger.log('[server] shutdown complete');
    });
    server.closeIdleConnections?.();
  };

  runtime.once('SIGTERM', shutdown);
  runtime.once('SIGINT', shutdown);
  return shutdown;
}

module.exports = installGracefulShutdown;
