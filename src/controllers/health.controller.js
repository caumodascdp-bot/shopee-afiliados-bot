// ==============================================================================
// Controlador de Keep-Alive (/api/ping) e Diagnóstico (/api/health)
// /api/ping NÃO acessa banco, Redis, filas ou Shopee (resposta ultrarrápida)
// ==============================================================================

function createHealthController({ pgClient, redisClient, whatsapp, repository, config }) {
  function ping(_req, res) {
    return res.status(200).json({
      ok: true,
      service: 'shopee-afiliados-bot',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
    });
  }

  async function health(_req, res, next) {
    try {
      const mem = process.memoryUsage();
      const [pgStatus, redisStatus, queueStats] = await Promise.all([
        pgClient ? pgClient.healthCheck() : Promise.resolve({ ok: false, mode: 'memory_fallback' }),
        redisClient ? redisClient.healthCheck() : Promise.resolve({ ok: false, mode: 'memory_fallback' }),
        repository ? repository.getQueueStats() : Promise.resolve({}),
      ]);

      const waStatus = whatsapp ? whatsapp.getStatus() : { status: 'OFFLINE', connected: false };

      return res.status(200).json({
        ok: true,
        service: 'shopee-afiliados-bot',
        port: config.port,
        nodeEnv: config.nodeEnv,
        timestamp: new Date().toISOString(),
        uptimeSeconds: Math.floor(process.uptime()),
        memoryMb: {
          rss: Math.round((mem.rss / 1024 / 1024) * 100) / 100,
          heapUsed: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
          heapTotal: Math.round((mem.heapTotal / 1024 / 1024) * 100) / 100,
          external: Math.round((mem.external / 1024 / 1024) * 100) / 100,
        },
        dependencies: {
          postgres: pgStatus,
          redis: redisStatus,
        },
        whatsapp: {
          status: waStatus.status,
          connected: waStatus.connected,
          phone: waStatus.phone,
        },
        queue: queueStats,
      });
    } catch (err) {
      return next(err);
    }
  }

  return { ping, health };
}

module.exports = { createHealthController };
