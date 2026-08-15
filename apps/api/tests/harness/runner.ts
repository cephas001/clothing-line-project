// apps/api/tests/harness/runner.ts
//
// Minimal synchronous-registration, async-execution test runner.
//
// Tests register suites at import time via describe()/it() (each test file
// imports cleanly and side-effect free); tests/run.ts imports every *.test.ts
// and calls runAll(). A failing assertion aborts that one test and the runner
// continues, reporting a PASS/FAIL summary and exiting non-zero on any failure
// so CI gates on the financial invariants.

export interface TestCase {
  name: string;
  fn: () => void | Promise<void>;
}

export interface Suite {
  name: string;
  tests: TestCase[];
}

const suites: Suite[] = [];
let currentSuite: Suite | null = null;

export function describe(name: string, body: () => void): void {
  const suite: Suite = { name, tests: [] };
  const previous = currentSuite;
  currentSuite = suite;
  try {
    body();
  } finally {
    currentSuite = previous;
  }
  suites.push(suite);
}

export function it(name: string, fn: () => void | Promise<void>): void {
  if (!currentSuite) {
    throw new Error("`it()` must be called inside `describe()`.");
  }
  currentSuite.tests.push({ name, fn });
}

export interface RunResult {
  total: number;
  passed: number;
  failed: number;
}

interface Failure {
  suite: string;
  test: string;
  error: unknown;
}

export async function runAll(): Promise<RunResult> {
  let passed = 0;
  let total = 0;
  const failures: Failure[] = [];

  for (const suite of suites) {
    if (suite.tests.length === 0) {
      continue;
    }
    console.log(`\n${suite.name}`);
    for (const test of suite.tests) {
      total += 1;
      try {
        await test.fn();
        passed += 1;
        console.log(`  PASS  ${test.name}`);
      } catch (error) {
        failures.push({ suite: suite.name, test: test.name, error });
        console.log(`  FAIL  ${test.name}`);
      }
    }
  }

  for (const failure of failures) {
    console.error(`\nFAIL [${failure.suite}] ${failure.test}`);
    console.error(
      failure.error instanceof Error
        ? failure.error.stack ?? failure.error.message
        : String(failure.error),
    );
  }

  return { total, passed, failed: failures.length };
}