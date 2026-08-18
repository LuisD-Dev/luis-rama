import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '../../components/common/Icons.jsx';
import { useContent } from '../../context/ContentContext.jsx';
import { adminService } from '../../services/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { ConfirmDialog } from '../../components/admin/ConfirmDialog.jsx';
import { StatusBadge } from '../../components/admin/StatusBadge.jsx';
import { useKeyboardShortcuts, KeyboardShortcutsHelp } from '../../components/common/KeyboardShortcuts.jsx';

export const AdminContentPage = () => {
  const navigate = useNavigate();
  const { content, error, openContent, removeContent } = useContent();
  const toast = useToast();
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [filter, setFilter] = useState('all');
  const [showShortcuts, setShowShortcuts] = useState(false);

  useKeyboardShortcuts({
    showHelp: () => setShowShortcuts((p) => !p),
    createContent: () => navigate('/admin/upload'),
    goDashboard: () => navigate('/admin'),
    goStudents: () => navigate('/admin/students'),
    goContent: () => navigate('/admin/content'),
  });

  const filteredContent = filter === 'all'
    ? content
    : content.filter(item => item.type === filter);

  const handleDelete = async (item) => {
    setDeletingId(item.id);
    try {
      await adminService.deleteContent(item.id);
      removeContent(item.id);
      toast.success(`"${item.title}" eliminado correctamente`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Error al eliminar contenido');
    } finally {
      setDeletingId(null);
      setDeleteTarget(null);
    }
  };

  const stats = {
    total: content.length,
    videos: content.filter(c => c.type === 'video').length,
    pdfs: content.filter(c => c.type === 'pdf').length,
    audios: content.filter(c => c.type === 'audio').length,
    images: content.filter(c => c.type === 'image').length,
  };

  const getIcon = (type) => <Icon type={type} className="content-type-icon" />;

  return (
    <div className="dashboard-layout">
      <div className="dashboard-main">
        <div className="dashboard-header">
          <h1>Gestor de contenido</h1>
          <p>Administra el contenido publicado en la plataforma</p>
        </div>

        <div className="stats-grid">
          <div className="stat-card">
            <div className="stat-value">{stats.total}</div>
            <div className="stat-label">Total</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{stats.videos}</div>
            <div className="stat-label">Videos</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{stats.pdfs}</div>
            <div className="stat-label">PDFs</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{stats.audios}</div>
            <div className="stat-label">Audios</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{stats.images}</div>
            <div className="stat-label">Imágenes</div>
          </div>
        </div>

        <div className="content-section">
          <div className="content-header">
            <h2>Todo el contenido</h2>
            <div className="content-filters">
              <button className="button button-ghost small" onClick={() => setShowShortcuts(true)} title="Atajos de teclado" aria-label="Atajos de teclado">
                ⌨️
              </button>
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
            <div className="content-table-wrapper">
              <table className="content-table">
                <thead>
                  <tr>
                    <th>Título</th>
                    <th>Tipo</th>
                    <th>Estado</th>
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
                      <td><StatusBadge status={item.type} type="content-type" /></td>
                      <td><StatusBadge status={item.status || 'published'} type="publish-status" /></td>
                      <td>{item.uploaded_by_name}</td>
                      <td><StatusBadge status={item.plan_tier || 'basico'} type="plan" /></td>
                      <td className="td-actions">
                        <a href={item.url} onClick={(event) => { event.preventDefault(); openContent(item); }} target="_blank" rel="noopener noreferrer" className="button button-secondary small">Ver</a>
                        <button
                          onClick={() => setDeleteTarget(item)}
                          className="button button-danger small"
                          disabled={deletingId === item.id}
                        >
                          {deletingId === item.id ? 'Eliminando...' : 'Eliminar'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {deleteTarget && (
        <ConfirmDialog
          title="Eliminar contenido"
          message={`¿Eliminar "${deleteTarget.title}"? Esta acción no se puede deshacer.`}
          confirmLabel="Eliminar"
          onConfirm={() => handleDelete(deleteTarget)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {showShortcuts && (
        <KeyboardShortcutsHelp onClose={() => setShowShortcuts(false)} />
      )}
    </div>
  );
};

export default AdminContentPage;
