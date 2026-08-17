import app from './app';

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`===============================================`);
  console.log(`🚀 BIS-API-PLATFORM GATEWAY RUNNING ON PORT ${PORT}`);
  console.log(`🌐 Server-Sent Events stream: http://localhost:${PORT}/api/dashboard/stream`);
  console.log(`===============================================`);
});
