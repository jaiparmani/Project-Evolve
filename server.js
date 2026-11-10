const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve runtime assets from the public directory when present.
app.use(express.static(path.join(__dirname, 'public')));

// Serve the application shell at the root route.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Lightweight health probe for hosting platforms and uptime checks.
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Fallback handler so unknown routes return a consistent JSON payload.
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

// Start the server only when run directly; importing the module (e.g. tests)
// returns the Express app without binding a port.
if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });

  // Close the listener cleanly when the process is signalled to stop.
  ['SIGINT', 'SIGTERM'].forEach((signal) => {
    process.on(signal, () => {
      server.close(() => process.exit(0));
    });
  });
}

module.exports = app;
