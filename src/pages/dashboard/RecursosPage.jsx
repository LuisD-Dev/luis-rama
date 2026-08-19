import { useEffect } from 'react';
import { useContent } from '../../context/ContentContext.jsx';
import { useAuth } from '../../hooks/useAuth.js';
import { ContentGrid } from '../../components/content/ContentGrid.jsx';
import { planLabel } from '../../utils/plans.js';

const RecursosPage = () => {
  const { content, loadContent, loading } = useContent();
  const { user } = useAuth();

  useEffect(() => {
    if (!content || content.length === 0) {
      loadContent();
    }
  }, []);

  return (
    <div className="page-shell">
      <section className="section-surface">
        <div className="section-intro">
          <p className="eyebrow-gold">Tu biblioteca</p>
          <h2>Recursos disponibles</h2>
          <p className="section-copy">
            Accede a los recursos compartidos para tu práctica y avance musical.
          </p>
          <div style={{ marginTop: '0.75rem' }}>
            <span className="chip chip-gold">Plan {planLabel(user?.plan_tier).replace(/^[^\w]+/, '')}</span>
          </div>
        </div>

        <ContentGrid content={content} isAdmin={false} user={user} loading={loading} />
      </section>
    </div>
  );
};

export default RecursosPage;
