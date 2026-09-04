/**
 * Small server/frontend-neutral control surface for task 56.
 */
export function createHermesTrainingControl({ training, lessons, skills } = {}) {
  if (!training || !lessons || !skills) throw new TypeError('training, lessons, and skills are required');
  return {
    async status() {
      const [lessonStore, generatedSkill] = await Promise.all([lessons.inspect(), skills.inspect()]);
      return { training: training.status(), lessons: lessonStore, generatedSkill };
    },
    start: () => training.start(),
    stop: (reason) => training.stop(reason),
    trainNow: () => training.trigger('operator'),
    viewerActivity: (reason) => training.preemptForViewerActivity(reason),
    addLesson: (lesson) => lessons.add(lesson),
    clearLessons: () => lessons.clear(),
    rollbackLessons: (revision) => lessons.rollback(revision),
    proposeSkill: (candidate, options) => skills.propose(candidate, options),
    rollbackSkill: (revision) => skills.rollback(revision),
    clearSkill: () => skills.clear(),
  };
}