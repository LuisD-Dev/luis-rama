import express from 'express';
import localProvider from '../storage/localProvider.js';
import prisma from '../utils/prismaClient.js';
import { buildFreeContentWhere } from '../utils/contentAccess.js';

const router = express.Router();

router.get('/signed', (req, res) => {
  if (process.env.LOCAL_UPLOADS?.toLowerCase() !== 'true') {
    return res.status(404).json({ error: 'Signed local media is not enabled' });
  }

  return localProvider.serveSignedFile(req, res);
});

router.get('/public', async (req, res) => {
  if (process.env.LOCAL_UPLOADS?.toLowerCase() !== 'true') {
    return res.status(404).json({ error: 'Public local media is not enabled' });
  }

  try {
    const storagePath = req.query.path;
    if (typeof storagePath !== 'string' || !storagePath.startsWith('content/')) {
      return res.status(404).json({ error: 'Media not found' });
    }

    const content = await prisma.content.findFirst({
      where: buildFreeContentWhere({
        url: { in: [storagePath, `/uploads/${storagePath}`] },
      }),
      select: { id: true },
    });

    if (!content) {
      return res.status(404).json({ error: 'Media not found' });
    }

    return localProvider.servePublicFile(storagePath, res);
  } catch (_error) {
    return res.status(404).json({ error: 'Media not found' });
  }
});

export default router;
