import prisma from '../../utils/prismaClient.js';

const isDryRun = process.argv.includes('--dry-run');

const main = async () => {
  console.log(isDryRun ? 'Running in dry-run mode.' : 'Running in normal mode.');

  const matchingContent = await prisma.content.findMany({
    where: {
      planTier: 'premium',
    },
    select: {
      id: true,
      planTier: true,
    },
  });

  console.log(`Found ${matchingContent.length} content records with plan tier "premium".`);

  if (isDryRun) {
    if (matchingContent.length > 0) {
      console.log('Would update the following records:');
      matchingContent.forEach((content) => {
        console.log(`- Content #${content.id}: ${content.planTier} -> basico`);
      });
    }
    console.log('No records were modified.');
    return;
  }

  const result = await prisma.content.updateMany({
    where: {
      planTier: 'premium',
    },
    data: {
      planTier: 'basico',
    },
  });

  console.log(`Updated ${result.count} content records to "basico".`);
  console.log('Migration completed successfully.');
};

const run = async () => {
  try {
    await main();
  } catch (error) {
    console.error('Migration failed.');
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
};

await run();
