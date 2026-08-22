import { useEffect } from 'react';
import { useContent } from '../../context/ContentContext.jsx';
import { ContentGrid } from '../../components/content/ContentGrid.jsx';

const FreeResources = () => {
  const { content, error, loadFreeContent, openContent, loading } = useContent();

  useEffect(() => {
    loadFreeContent();
  }, []);

  const freeItems = content.filter((item) => item.plan_tier === 'free');

  return (
    <div className="page-shell">
      <section className="section-surface">
        <div className="section-intro">
          <p className="eyebrow">Recursos gratuitos</p>
          <h2>Contenido gratuito para tu práctica</h2>
          <p className="section-copy">Accede a una selección de lecciones y recursos pensados para tu aprendizaje.</p>
        </div>

        <div className="feature-grid">
          {error && <div className="error-message" role="alert">{error}</div>}
          {loading ? (
            <p>Cargando...</p>
          ) : freeItems.length === 0 ? (
            <p>No hay recursos gratuitos disponibles aún.</p>
          ) : (
            freeItems.map((item) => (
              <article key={item.id} className="feature-card">
                <h3>{item.title}</h3>
                <p>{item.description}</p>
                <p className="content-author">Por: {item.uploaded_by_name}</p>
                <a href={item.url} onClick={(event) => { event.preventDefault(); openContent(item); }} target="_blank" rel="noopener noreferrer" className="button button-secondary">Ver</a>
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  );
};

export default FreeResources;
