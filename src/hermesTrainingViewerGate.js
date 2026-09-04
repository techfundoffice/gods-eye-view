/**
 * A tiny single-process read/write admission gate.
 *
 * Training is exclusive and keeps its lease through execution, observation,
 * lesson persistence, and generated-skill validation. Viewer transitions may
 * overlap one another, but no viewer transition can start during training and
 * no training run can start while a viewer transition is in progress.
 */
export function createHermesTrainingViewerGate() {
  let training = false;
  let viewerTransitions = 0;

  function releaseOnce(release) {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  }

  return {
    tryBeginTraining() {
      if (training || viewerTransitions > 0) return null;
      training = true;
      return releaseOnce(() => { training = false; });
    },
    async tryViewerTransition(callback) {
      if (training) return { entered: false, value: null };
      viewerTransitions += 1;
      try {
        return { entered: true, value: await callback() };
      } finally {
        viewerTransitions = Math.max(0, viewerTransitions - 1);
      }
    },
    status() {
      return { training, viewerTransitions };
    },
  };
}