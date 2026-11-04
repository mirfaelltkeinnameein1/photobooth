const { JOB_STATES } = require("./constants");

// Queue acceptance predicates. Keep these tiny so theyre easy to trust.
function installStateManagerQueueAcceptanceMethods(StateManager) {
  StateManager.prototype.jobNeedsInitialGeneration = function jobNeedsInitialGeneration(job) {
    if (!job) return false;
    const blockedStates = [JOB_STATES.BLOCKED, JOB_STATES.DELIVERED, JOB_STATES.ACCEPTED_BOTH];
    if (blockedStates.includes(job.state)) return false;
    return this.groupNeedsCandidate(job, "group1") || this.groupNeedsCandidate(job, "group2");
  };

  StateManager.prototype.hasAnyCandidate = function hasAnyCandidate(job, group) {
    return (job.candidates?.[group]?.length || 0) > 0 || !!job.manual?.candidates?.[group];
  };

  StateManager.prototype.getLatestGeneratedCandidate = function getLatestGeneratedCandidate(job, group) {
    const arr = job?.candidates?.[group] || [];
    return arr.length ? arr[arr.length - 1] : null;
  };

  StateManager.prototype.groupNeedsCandidate = function groupNeedsCandidate(job, group) {
    if (job.accepted?.[group]) return false;
    if (job.manual?.candidates?.[group]) return false;
    return (job.candidates?.[group]?.length || 0) === 0;
  };
}

module.exports = { installStateManagerQueueAcceptanceMethods };
