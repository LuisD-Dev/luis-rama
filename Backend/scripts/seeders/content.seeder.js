const SEED_CONTENT = [
  // Videos
  {
    title: 'Piano Basics - Getting Started',
    description: 'Learn the fundamental concepts of piano playing for beginners',
    type: 'video',
    body: 'Learn the fundamental concepts of piano playing for beginners. This video covers hand positioning, basic music notation, and your first scales.',
    url: 'https://example.com/piano-basics-1',
    is_free: 1,
    plan_tier: 'free',
    tags: ['piano', 'basics', 'beginner']
  },
  {
    title: 'Advanced Piano Techniques',
    description: 'Master complex finger techniques and advanced patterns',
    type: 'video',
    body: 'Learn advanced piano techniques including arpeggios, trills, and complex rhythmic patterns. Designed for intermediate to advanced students.',
    url: 'https://example.com/piano-advanced-1',
    is_free: 0,
    plan_tier: 'basico',
    tags: ['piano', 'advanced', 'techniques']
  },

  // Articles
  {
    title: 'Understanding Music Theory Fundamentals',
    description: 'A comprehensive guide to music theory basics',
    type: 'article',
    body: 'This article covers scales, intervals, chords, and harmonic progressions. Perfect for students who want to understand the theoretical foundation of music.',
    url: 'https://example.com/theory-fundamentals',
    is_free: 1,
    plan_tier: 'free',
    tags: ['theory', 'fundamentals', 'music']
  },
  {
    title: 'Jazz Improvisation Guide',
    description: 'Learn how to improvise jazz music at the piano',
    type: 'article',
    body: 'A detailed guide on jazz improvisation, including chord progressions, scale choices, and listening to great jazz pianists.',
    url: 'https://example.com/jazz-improv-guide',
    is_free: 0,
    plan_tier: 'basico',
    tags: ['jazz', 'improvisation', 'intermediate']
  },

  // Quizzes
  {
    title: 'Music Theory Basics Quiz',
    description: 'Test your knowledge of basic music theory concepts',
    type: 'quiz',
    body: JSON.stringify({
      questions: [
        {
          id: 1,
          question: 'How many keys are on a standard piano?',
          options: ['88', '100', '72', '96'],
          correctAnswer: 0
        },
        {
          id: 2,
          question: 'What is the most common time signature in music?',
          options: ['3/4', '4/4', '2/4', '6/8'],
          correctAnswer: 1
        }
      ]
    }),
    url: 'https://example.com/quiz-theory-basics',
    is_free: 1,
    plan_tier: 'free',
    tags: ['quiz', 'theory', 'assessment']
  },
  {
    title: 'Intermediate Piano Skills Assessment',
    description: 'Assess your intermediate piano playing abilities',
    type: 'quiz',
    body: JSON.stringify({
      questions: [
        {
          id: 1,
          question: 'What is a dominant seventh chord?',
          options: ['V7', 'VII7', 'IV7', 'II7'],
          correctAnswer: 0
        },
        {
          id: 2,
          question: 'In what key is a piece with 3 sharps?',
          options: ['A major', 'D major', 'G major', 'E major'],
          correctAnswer: 0
        }
      ]
    }),
    url: 'https://example.com/quiz-intermediate',
    is_free: 0,
    plan_tier: 'basico',
    tags: ['quiz', 'intermediate', 'assessment']
  }
];

export const seedContent = async (db, isPostgres, adminUserId) => {
  console.log('🌱 Seeding content...');

  if (!adminUserId) {
    throw new Error('Admin user ID not provided. Ensure users are seeded first.');
  }

  for (const content of SEED_CONTENT) {
    try {
      const tagsString = content.tags ? JSON.stringify(content.tags) : null;

      if (isPostgres) {
        // PostgreSQL: use ON CONFLICT DO NOTHING
        await db.run(
          `INSERT INTO content (title, description, type, url, is_free, plan_tier, uploaded_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
           ON CONFLICT DO NOTHING`,
          [
            content.title,
            content.description,
            content.type,
            content.url,
            content.is_free,
            content.plan_tier,
            adminUserId
          ]
        );
      } else {
        // SQLite: use INSERT OR IGNORE
        await db.run(
          `INSERT OR IGNORE INTO content (title, description, type, url, is_free, plan_tier, uploaded_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          [
            content.title,
            content.description,
            content.type,
            content.url,
            content.is_free,
            content.plan_tier,
            adminUserId
          ]
        );
      }

      console.log(`  ✓ Content "${content.title}" (${content.type}) seeded successfully`);
    } catch (error) {
      console.error(`  ✗ Error seeding content "${content.title}":`, error.message);
      throw error;
    }
  }

  console.log('✅ Content seeding complete');
};

export { SEED_CONTENT };
