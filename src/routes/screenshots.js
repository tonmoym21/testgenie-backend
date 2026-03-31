const { Router } = require('express');
const path = require('path');
const fs = require('fs');
const { authenticate } = require('../middleware/auth');

const router = Router();
const SCREENSHOTS_DIR = path.join(process.cwd(), 'screenshots');

// GET /api/screenshots/:filename
router.get('/:filename', authenticate, (req, res) => {
  const filename = path.basename(req.params.filename); // prevent path traversal
  const filepath = path.join(SCREENSHOTS_DIR, filename);

  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Screenshot not found' } });
  }

  res.sendFile(filepath);
});

module.exports = router;
