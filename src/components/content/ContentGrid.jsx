import { useState } from 'react';
import { Icon } from '../common/Icons.jsx';
import { planLabel } from '../../utils/plans.js';
import { useContent } from '../../context/ContentContext.jsx';

export const ContentGrid = ({ content, onDelete, isAdmin = false }) => {
  const [filter, setFilter] = useState('all');
  const { error, openContent } = useContent();

  const handleOpen = (event, item) => {
    event.preventDefault();
    openContent(item);
  };

  const filteredContent = filter === 'all'
    ? content
    : content.filter(item => item.type === filter);

  const getIcon = (type) => <Icon type={type} className="content-type-icon" />;

  return (
    <div className="content-section">
      <div className="content-header">
        <h2>Contenido</h2>
        <div className="content-filters">
          {['all','video','pdf','audio','image'].map(f => (
            <button
              key={f}
              className={`filter-btn ${filter === f ? 'active' : ''}`}
              onClick={() => setFilter(f)}
            >
              {f === 'all' ? 'Todos' : f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="error-message" role="alert">{error}</div>}

      {filteredContent.length === 0 ? (
        <div className="empty-state">
          <p>No hay contenido {filter !== 'all' ? `de tipo ${filter}` : ''}</p>
        </div>
      ) : (
        isAdmin ? (
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
                {filteredContent.map(item => (
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
          <div className="content-grid">
            {filteredContent.map(item => (
              <div key={item.id} className="content-card">
                <div className="content-icon">{getIcon(item.type)}</div>
                <h3>{item.title}</h3>
                <p className="content-desc">{item.description || 'Sin descripción'}</p>
                <p className="content-type">
                  <span className="badge">{item.type.toUpperCase()}</span>
                </p>
                <p className="content-author">Por: {item.uploaded_by_name}</p>
                <div className="content-actions">
                  <a href={item.url} onClick={(event) => handleOpen(event, item)} target="_blank" rel="noopener noreferrer" className="button button-secondary">
                    Ver
                  </a>
                </div>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
};
