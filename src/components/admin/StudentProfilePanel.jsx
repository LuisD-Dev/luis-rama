import { resolveAvatar } from '../../utils/avatar.js';
import { StatusBadge } from './StatusBadge.jsx';
import { planLabel } from '../../utils/plans.js';

const InfoRow = ({ label, value }) => (
  <div className="profile-info-row">
    <span className="profile-info-label">{label}</span>
    <span className="profile-info-value">{value || '—'}</span>
  </div>
);

export const StudentProfilePanel = ({ student, onClose }) => {
  if (!student) return null;
  const avatarSrc = resolveAvatar(student.avatar_url || '');
  const status = student.status || 'active';

  return (
    <div className="slide-overlay" onClick={onClose}>
      <div className="slide-panel" onClick={(e) => e.stopPropagation()}>
        <div className="slide-panel-header">
          <h2>Detalle del estudiante</h2>
          <button className="slide-close" onClick={onClose} aria-label="Cerrar">✕</button>
        </div>

        <div className="slide-panel-body">
          <div className="student-profile-top">
            <div className="student-profile-avatar-section">
              {avatarSrc ? (
                <img src={avatarSrc} alt={student.name} className="student-profile-avatar" />
              ) : (
                <span className="student-profile-avatar student-profile-avatar-placeholder">
                  {student.name?.charAt(0)?.toUpperCase() || '?'}
                </span>
              )}
            </div>
            <div className="student-profile-name-section">
              <h3>{student.name}</h3>
              <p className="student-profile-email">{student.email}</p>
              <div className="student-profile-badges">
                <StatusBadge status={status} type="status" />
                <StatusBadge status={student.plan_tier || 'free'} type="plan" />
              </div>
            </div>
          </div>

          <div className="student-profile-section">
            <h4>Información personal</h4>
            <InfoRow label="Nombre" value={student.name} />
            <InfoRow label="Correo" value={student.email} />
            <InfoRow label="Usuario" value={student.username} />
            <InfoRow label="ID" value={student.id} />
            <InfoRow label="Fecha de registro" value={student.created_at ? new Date(student.created_at).toLocaleDateString('es-CR') : '—'} />
          </div>

          <div className="student-profile-section">
            <h4>Plan y estado</h4>
            <InfoRow label="Plan actual" value={planLabel(student.plan_tier)} />
            <InfoRow label="Estado" value={status === 'active' ? 'Activo' : status === 'inactive' ? 'Inactivo' : 'Suspendido'} />
            <InfoRow label="Nivel de piano" value={student.skill_level || 'Principiante'} />
            <InfoRow label="Progreso" value={student.progress ? `${student.progress}%` : '—'} />
          </div>

          <div className="student-profile-section">
            <h4>Cursos y asignaciones</h4>
            <InfoRow label="Cursos inscritos" value={(student.enrolled_courses_count ?? (student.enrolled_courses || []).length) || '—'} />
            <InfoRow label="Profesores asignados" value={(student.assigned_teachers_count ?? (student.assigned_teachers || []).length) || '—'} />
            <InfoRow label="Tareas completadas" value={student.completed_assignments ?? '—'} />
            <InfoRow label="Asistencia" value={student.attendance_rate ? `${student.attendance_rate}%` : '—'} />
          </div>

          {student.teacher_notes && (
            <div className="student-profile-section">
              <h4>Notas del profesor</h4>
              <p className="student-profile-notes">{student.teacher_notes}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default StudentProfilePanel;
