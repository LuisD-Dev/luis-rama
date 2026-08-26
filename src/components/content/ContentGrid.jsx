import { useState } from 'react';
import { Icon, UIIcon } from '../common/Icons.jsx';
import { planLabel } from '../../utils/plans.js';
import { useContent } from '../../context/ContentContext.jsx';
import { ContentCard } from './ContentCard.jsx';

const FILTERS = [
  { value: 'all', label: 'Todos' },
  { value: 'video', label: 'Video' },
  { value: 'pdf', label: 'PDF' },
  { value: 'audio', label: 'Audio' },
  { value: 'image', label: 'Imagen' },
];

const SkeletonCard = () => (
  <div className="skeleton-card" aria-hidden="true">
    <div className="skeleton-thumb" />
    <div className="skeleton-card-body">
      <div className="skeleton-line skeleton-line-lg" />
      <div className="skeleton-line skeleton-line-md" />
      <div className="skeleton-line skeleton-line-sm" />
    </div>
  </div>
);

export const ContentGrid = ({ content = [], onDelete, isAdmin = false, user = null, loading = false }) => {
  const [filter, setFilter] = useState('all');
  const { error, openContent } = useContent();

  const handleOpen = (event, item) => {
    event.preventDefault();
    openContent(item);
  };

  const filteredContent = filter === 'all'
    ? content
    : content.filter((item) => item.type === filter);

  const getIcon = (type) => <Icon type={type} className="content-type-icon" />;

  return (
    <div className="content-section">
      <div className="content-header">
        <h2>Contenido</h2>
        <div className="content-filters tc-filters">
          {FILTERS.map((item) => (
            <button
              key={item.value}
              className={`filter-btn ${filter === item.value ? 'active' : ''}`}
              onClick={() => setFilter(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="error-message" role="alert">{error}</div>}

      {loading ? (
        <div className="tc-grid">
          {[1, 2, 3, 4].map((item) => <SkeletonCard key={item} />)}
        </div>
      ) : filteredContent.length === 0 ? (
        <div className="empty-state">
          <span className="empty-state-icon" aria-hidden="true"><UIIcon name="music" size={26} /></span>
          <p>No hay contenido {filter !== 'all' ? `de tipo ${filter}` : 'disponible'} por ahora.</p>
          <p className="text-muted">Vuelve pronto: se añaden recursos con frecuencia.</p>
        </div>
      ) : isAdmin ? (
        <div className="content-table-wrapper">
          <table className="content-table">
            <thead>
              <tr>
                <th>Título</th>
                <th>Tipo</th>
                <th>Autor</th>
                <th>Plan</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {filteredContent.map((item) => (
                <tr key={item.id} className="content-row">
                  <td className="td-title">
                    <div className="td-title-inner">
                      <span className="content-icon-inline">{getIcon(item.type)}</span>
                      <div>
                        <div className="row-title">{item.title}</div>
                        <div className="row-desc">{item.description || 'Sin descripción'}</div>
                      </div>
                    </div>
                  </td>
                  <td><span className="badge small">{item.type.toUpperCase()}</span></td>
                  <td>{item.uploaded_by_name}</td>
                  <td><span className="badge small">{planLabel(item.plan_tier || 'basico')}</span></td>
                  <td className="td-actions">
                    <a href={item.url} onClick={(event) => handleOpen(event, item)} target="_blank" rel="noopener noreferrer" className="button button-secondary small">Ver</a>
                    <button onClick={() => onDelete(item.id)} className="button button-danger small">Eliminar</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="tc-grid">
          {filteredContent.map((item) => (
            <ContentCard key={item.id} item={item} user={user} onOpen={handleOpen} />
          ))}
        </div>
      )}
    </div>
  );
};
