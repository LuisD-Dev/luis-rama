/**
 * Content fixtures - plain JS objects matching seeded content records
 * These are used for testing and validation
 */

export const pianoBasicsVideo = {
  title: 'Piano Basics - Getting Started',
  description: 'Learn the fundamental concepts of piano playing for beginners',
  type: 'video',
  body: 'Learn the fundamental concepts of piano playing for beginners. This video covers hand positioning, basic music notation, and your first scales.',
  url: 'https://example.com/piano-basics-1',
  is_free: 1,
  plan_tier: 'free',
  tags: ['piano', 'basics', 'beginner']
};

export const advancedPianoVideo = {
  title: 'Advanced Piano Techniques',
  description: 'Master complex finger techniques and advanced patterns',
  type: 'video',
  body: 'Learn advanced piano techniques including arpeggios, trills, and complex rhythmic patterns. Designed for intermediate to advanced students.',
  url: 'https://example.com/piano-advanced-1',
  is_free: 0,
  plan_tier: 'basico',
  tags: ['piano', 'advanced', 'techniques']
};

export const musicTheoryArticle = {
  title: 'Understanding Music Theory Fundamentals',
  description: 'A comprehensive guide to music theory basics',
  type: 'article',
  body: 'This article covers scales, intervals, chords, and harmonic progressions. Perfect for students who want to understand the theoretical foundation of music.',
  url: 'https://example.com/theory-fundamentals',
  is_free: 1,
  plan_tier: 'free',
  tags: ['theory', 'fundamentals', 'music']
};

export const jazzImprovArticle = {
  title: 'Jazz Improvisation Guide',
  description: 'Learn how to improvise jazz music at the piano',
  type: 'article',
  body: 'A detailed guide on jazz improvisation, including chord progressions, scale choices, and listening to great jazz pianists.',
  url: 'https://example.com/jazz-improv-guide',
  is_free: 0,
  plan_tier: 'basico',
  tags: ['jazz', 'improvisation', 'intermediate']
};

export const theoryBasicsQuiz = {
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
};

export const intermediateSkillsQuiz = {
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
};

/**
 * Export all fixtures as an object for convenience
 */
export default {
  pianoBasicsVideo,
  advancedPianoVideo,
  musicTheoryArticle,
  jazzImprovArticle,
  theoryBasicsQuiz,
  intermediateSkillsQuiz
};
