// Early startup test - this should be the first thing that runs
console.log('[STARTUP] Node version:', process.version);
console.log('[STARTUP] Current directory:', process.cwd());
console.log('[STARTUP] Environment:', process.env.NODE_ENV || 'not set');

// Try to load the server
try {
  console.log('[STARTUP] Loading server.js...');
  require('./dist/server.js');
  console.log('[STARTUP] Server.js loaded successfully');
} catch (error) {
  console.error('[STARTUP] Failed to load server.js:', error.message);
  console.error('[STARTUP] Stack trace:', error.stack);
  process.exit(1);
}