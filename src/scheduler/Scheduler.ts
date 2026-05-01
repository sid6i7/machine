import cron, { type ScheduledTask } from 'node-cron';
import { logger } from '../utils/logger.js';
import type { Job, JobContext } from '../jobs/Job.js';

export class Scheduler {
  private jobs = new Map<string, Job>();
  private tasks = new Map<string, ScheduledTask>();

  constructor(private ctx: JobContext) {}

  // Discover and instantiate jobs listed in ENABLED_JOBS env (comma-separated
  // class names). Mirrors ActionDispatcher.init's dynamic-import approach.
  async loadEnabled(): Promise<void> {
    const enabled = (process.env.ENABLED_JOBS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    for (const name of enabled) {
      try {
        const module = await import(`../jobs/${name}.js`);
        const JobClass = module[name];
        if (!JobClass) {
          logger.error({ name }, 'Job class not found in module');
          continue;
        }
        const instance: Job = new JobClass();
        this.jobs.set(instance.name, instance);
        logger.info({ name: instance.name, schedule: instance.schedule }, 'Loaded job');
      } catch (err) {
        logger.error({ err, name }, 'Failed to load job');
      }
    }
  }

  start(): void {
    const tz = process.env.SCHEDULER_TZ || 'Asia/Kolkata';
    for (const job of this.jobs.values()) {
      const task = cron.schedule(
        job.schedule,
        () => {
          this.runOnce(job.name).catch(err => {
            logger.error({ err, job: job.name }, 'Scheduled job tick failed');
          });
        },
        { timezone: tz }
      );
      this.tasks.set(job.name, task);
    }
    logger.info({ jobs: Array.from(this.jobs.keys()), tz }, 'Scheduler started');
  }

  // Invoke a job by name immediately. Records to scheduler_runs regardless of
  // outcome. Re-throws so callers (CLI) can set a non-zero exit code.
  async runOnce(name: string): Promise<void> {
    const job = this.jobs.get(name);
    if (!job) {
      throw new Error(`Job not loaded: ${name}. Enable it via ENABLED_JOBS.`);
    }
    const startedAt = Date.now();
    let ok = 1;
    let error: string | null = null;
    try {
      logger.info({ job: name }, 'Job run starting');
      await job.run(this.ctx);
      logger.info({ job: name, ms: Date.now() - startedAt }, 'Job run complete');
    } catch (err: unknown) {
      ok = 0;
      error = err instanceof Error ? (err.stack || err.message) : String(err);
      throw err;
    } finally {
      this.ctx.db.prepare(
        'INSERT INTO scheduler_runs (job_name, ran_at, ok, error) VALUES (?, ?, ?, ?)'
      ).run(name, startedAt, ok, error);
    }
  }

  list(): Job[] {
    return Array.from(this.jobs.values());
  }

  stop(): void {
    for (const task of this.tasks.values()) {
      task.stop();
    }
    this.tasks.clear();
  }
}
