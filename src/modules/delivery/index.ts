/** Public interface of the Delivery bounded context. */
export {
  allocateVolunteer,
  logHours,
  approveHours,
  rejectHours,
  getWorkspaceHours,
  getProjectHoursForCharity,
  getCorporateHours,
  logHoursSchema,
} from './service';

/** US-1.5 — a volunteer's committed load against the hours they offered. */
export { getVolunteerLoad, type VolunteerLoad } from './availability';

/** US-6.3 shared workspace (tasks & milestones) and US-6.4 progress. */
export {
  createMilestone,
  achieveMilestone,
  createTask,
  updateTask,
  getWorkspaceBoard,
  getDeliveryProgress,
  findWorkspaceForParticipant,
  milestoneSchema,
  taskSchema,
  updateTaskSchema,
  type MilestoneInput,
  type TaskInput,
  type UpdateTaskInput,
} from './workspace';
