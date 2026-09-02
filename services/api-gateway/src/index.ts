import app from './app';

const PORT = process.env.PORT || 3001;

const server = app.listen(PORT, () => {
  console.log(`===============================================`);
  console.log(`BIS-API-PLATFORM GATEWAY RUNNING ON PORT ${PORT}`);
  console.log(`Server-Sent Events stream: http://localhost:${PORT}/api/dashboard/stream`);
  console.log(`===============================================`);
});

// P3-3: Graceful shutdown — drain in-flight requests before closing
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('Gateway shutting down...');

  // Stop accepting new connections
  server.close(() => {
    console.log('Gateway stopped.');
    process.exit(0);
  });

  // Force kill after 30s
  setTimeout(() => {
    console.error('Gateway forced shutdown after timeout');
    process.exit(1);
  }, 30_000).unref();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
