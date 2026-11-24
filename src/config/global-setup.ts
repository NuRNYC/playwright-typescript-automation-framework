import type { FullConfig } from '@playwright/test';
import { config, runtimeFacts } from '@/config';
import { effectiveConfigProblems, enforce } from '@/config/security';

/**
 * Checkpoint B of the execution boundary (ADR-0005, rule I5b).
 *
 * Global setup runs in the CLI process after command-line overrides have been
 * applied and before any project, setup test, worker or browser starts
 * (verified). It re-checks the EFFECTIVE reporter and recording settings for
 * restricted targets -- defence in depth behind checkpoint A, catching unsafe
 * settings however they arrived. For public demos it does nothing.
 *
 * Limitation (verified): UI mode and the test server do not run global setup
 * at startup, which is why checkpoint A refuses those launch modes outright.
 */
export default function globalSetup(full: FullConfig): void {
  enforce(
    'Global-setup checkpoint',
    effectiveConfigProblems(
      config.tier,
      {
        reporters: full.reporter.map(([name]) => name),
        projects: full.projects.map((project) => ({
          name: project.name,
          trace: project.use.trace,
          screenshot: project.use.screenshot,
          video: project.use.video,
          headless: project.use.headless,
        })),
      },
      runtimeFacts,
    ),
  );
}
