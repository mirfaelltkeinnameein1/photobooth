const fs = require("fs");
const path = require("path");
const { PATHS } = require("./paths");
const { readJsonSafe, atomicWriteJson, ensureDir } = require("./fsutils");
// Tiny JSON job store (filesystem is our db here).

async function loadAllJobs() {
  await ensureDir(PATHS.RUNTIME_JOBS);
  const entries = await fs.promises.readdir(PATHS.RUNTIME_JOBS, { withFileTypes: true });
  const jobs = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(PATHS.RUNTIME_JOBS, entry.name);
    const job = await readJsonSafe(filePath, null);
    if (job && job.uuid) jobs.push(job);
  }

  // newest first to match queue/operator list ordering.
  jobs.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  return jobs;
}

async function saveJob(job) {
  const filePath = path.join(PATHS.RUNTIME_JOBS, `${job.uuid}.json`);
  await atomicWriteJson(filePath, job);
}

module.exports = {
  loadAllJobs,
  saveJob
};
