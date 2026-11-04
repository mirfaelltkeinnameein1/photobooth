const { installStateManagerQueueSchedulerMethods } = require("./stateManager.queue.scheduler");
const { installStateManagerQueueGenerationMethods } = require("./stateManager.queue.generation");
const { installStateManagerQueueAcceptanceMethods } = require("./stateManager.queue.acceptance");

// Queue module composer. Keeps stateManager.js slim-ish.
function installStateManagerQueueMethods(StateManager) {
  installStateManagerQueueAcceptanceMethods(StateManager);
  installStateManagerQueueGenerationMethods(StateManager);
  installStateManagerQueueSchedulerMethods(StateManager);
}

module.exports = { installStateManagerQueueMethods };
