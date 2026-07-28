import cors from 'cors';
import express from 'express';
import { PORT } from './config.js';
import { router } from './api/router.js';

const app = express();
app.use(cors());
app.use('/api', router);

// Under Vercel, this module is imported as a serverless function handler
// (the exported `app` is called directly per-request) — it must not also
// bind a port. Only listen when actually running as a long-lived process
// (local dev, or a non-serverless deploy).
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`transit-server listening on http://localhost:${PORT}`);
  });
}

export default app;
