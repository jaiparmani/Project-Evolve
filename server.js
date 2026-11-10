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

// Start the server only when run directly; importing the module (e.g. tests)
// returns the Express app without binding a port.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

module.exports = app;
