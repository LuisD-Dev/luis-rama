import { useMemo } from 'react';
import { ContentGrid } from '../../components/content/ContentGrid.jsx';
import { hasAccess } from '../../components/content/ContentCard.jsx';
import { NextStepBanner } from '../../components/dashboard/NextStepBanner.jsx';
import { UIIcon } from '../../components/common/Icons.jsx';
import { useContent } from '../../context/ContentContext.jsx';
import { useAuth } from '../../hooks/useAuth.js';
import { resolveAvatar } from '../../utils/avatar.js';
import { planLabel } from '../../utils/plans.js';

export const DashboardPage = () => {
  const { content, loading } = useContent();
  const { user } = useAuth();

  const avatarSrc = resolveAvatar(user?.avatar_url || '');
  const initial = user?.name?.charAt(0)?.toUpperCase() || 'T';
  const hasPlan = Boolean(user?.plan_tier) || user?.role === 'premium' || user?.role === 'admin';

  const unlockedCount = useMemo(
    () => content.filter((item) => hasAccess(item, user)).length,
    [content, user]
  );

  const nextStep = hasPlan
    ? {
        title: 'Continúa con tus recursos',
        description: 'Retoma tus lecciones y sigue avanzando desde donde lo dejaste.',
        ctaLabel: 'Ir a recursos',
        to: '/recursos',
      }
    : {
        title: 'Desbloquea todo el contenido',
        description: 'Mejora tu plan para acceder a partituras exclusivas y clases 1:1.',
        ctaLabel: 'Ver planes',
        to: '/profile?tab=subscription',
      };

  return (
    <div className="dashboard-layout">
      <div className="dashboard-main">
        <div className="welcome-banner animate-fade-up">
          {avatarSrc ? (
            <img src={avatarSrc} alt="" className="welcome-avatar" width={58} height={58} />
          ) : (
            <div className="welcome-avatar" aria-hidden="true">{initial}</div>
          )}
          <div>
            <h1>¡Hola, {user?.name || 'estudiante'}!</h1>
            <p>Bienvenido de nuevo a tu espacio de aprendizaje.</p>
            <div className="welcome-meta">
              <span className="chip chip-gold">{planLabel(user?.plan_tier) }</span>
              <span className="chip chip-success"><span className="chip-dot" /> Cuenta activa</span>
            </div>
          </div>
        </div>

        <NextStepBanner {...nextStep} />

        <div className="dash-stats">
          <div className="dash-stat">
            <div className="dash-stat-top"><span className="dash-stat-icon" aria-hidden="true"><UIIcon name="book" size={17} /></span> Recursos disponibles</div>
            <div className="dash-stat-value">{loading ? '—' : content.length}</div>
          </div>
          <div className="dash-stat">
            <div className="dash-stat-top"><span className="dash-stat-icon" aria-hidden="true"><UIIcon name="unlock" size={17} /></span> Desbloqueados para ti</div>
            <div className="dash-stat-value">{loading ? '—' : unlockedCount}</div>
          </div>
          <div className="dash-stat">
            <div className="dash-stat-top"><span className="dash-stat-icon" aria-hidden="true"><UIIcon name="star" size={17} /></span> Tu plan</div>
            <div className="dash-stat-value" style={{ fontSize: '1.35rem' }}>{planLabel(user?.plan_tier)}</div>
          </div>
        </div>

        <ContentGrid content={content} isAdmin={false} user={user} loading={loading} />
      </div>
    </div>
  );
};

export default DashboardPage;
