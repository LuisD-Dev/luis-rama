export const CONTENT_PLANS = [
  { value: 'free', label: 'Gratis — todos los estudiantes' },
  { value: 'basico', label: 'Plan Básico ($9.99)' },
  { value: 'pro', label: 'Plan Pro ($24.99)' },
  { value: 'master', label: 'Plan Master ($49.99)' },
];

export const STUDENT_PLANS = [
  { value: '', label: 'Sin plan (Estudiante)' },
  { value: 'basico', label: 'Plan Básico' },
  { value: 'pro', label: 'Plan Pro' },
  { value: 'master', label: 'Plan Master' },
];

export const planLabel = (tier) => {
  if (!tier || tier === 'student') return 'Estudiante';
  const found = CONTENT_PLANS.find((p) => p.value === tier);
  if (found) return found.label.replace(/ —.*/, '').replace(/\(\$.*\)/, '').trim();
  if (tier === 'premium') return 'Premium';
  return tier;
};
