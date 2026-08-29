import { useEffect, useState } from 'react';
import { adminService } from '../../services/api.js';
import { useToast } from '../../context/ToastContext.jsx';

const formatJson = (value) => {
  if (!value) return '—';
  try { return JSON.stringify(JSON.parse(value)); } catch { return '[inválido]'; }
};

export const AdminAuditPage = () => {
  const [events, setEvents] = useState([]);
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState(null);
  const [action, setAction] = useState('');
  const [loading, setLoading] = useState(true);
  const toast = useToast();

  useEffect(() => {
    setLoading(true);
    adminService.getAuditEvents({ page, limit: 25, ...(action ? { action } : {}) })
      .then((response) => { setEvents(response.data.events || []); setPagination(response.data.pagination); })
      .catch((error) => toast.error(error.response?.data?.error || 'No se pudo cargar la auditoría.'))
      .finally(() => setLoading(false));
  }, [page, action]);

  return (
    <div className="dashboard-layout">
      <div className="dashboard-main">
        <div className="dashboard-header">
          <h1>Auditoría administrativa</h1>
          <p>Registro inmutable de cambios realizados por administradores.</p>
        </div>
        <div className="students-toolbar">
          <select className="filter-select" value={action} onChange={(event) => { setAction(event.target.value); setPage(1); }} aria-label="Filtrar por acción">
            <option value="">Todas las acciones</option>
            <option value="plan.assign">Asignación de plan</option>
            <option value="plan.clear">Retiro de plan</option>
            <option value="student.suspend">Suspensión</option>
            <option value="student.unsuspend">Reactivación</option>
            <option value="student.delete">Eliminación de estudiante</option>
            <option value="content.delete">Eliminación de contenido</option>
          </select>
        </div>
        {loading ? <div className="loading-container">Cargando auditoría...</div> : (
          <div className="content-table-wrapper">
            <table className="content-table audit-table">
              <thead><tr><th>Fecha</th><th>Acción</th><th>Actor</th><th>Objetivo</th><th>Antes</th><th>Después</th><th>Request ID</th><th>Hash</th></tr></thead>
              <tbody>{events.map((event) => (
                <tr key={event.id}>
                  <td>{new Date(event.createdAt).toLocaleString('es-CR')}</td>
                  <td>{event.action}</td><td>{event.actorUserId}</td>
                  <td>{event.targetType} #{event.targetId}</td>
                  <td className="audit-json">{formatJson(event.beforeJson)}</td>
                  <td className="audit-json">{formatJson(event.afterJson)}</td>
                  <td>{event.requestId || '—'}</td><td title={event.entryHash}>{event.entryHash.slice(0, 12)}…</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        {pagination && pagination.pages > 1 && <div className="pagination-controls">
          <button className="button button-secondary small" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>Anterior</button>
          <span>Página {page} de {pagination.pages}</span>
          <button className="button button-secondary small" disabled={page >= pagination.pages} onClick={() => setPage((current) => current + 1)}>Siguiente</button>
        </div>}
      </div>
    </div>
  );
};

export default AdminAuditPage;