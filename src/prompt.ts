import { createInterface } from 'node:readline';

/** Prompt for a line of visible input on the terminal. */
export function promptLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Prompt for hidden input (a password) by suppressing the echo of typed
 * characters. Dependency-free: overrides readline's internal `_writeToOutput`,
 * the standard technique, so typed keys are not shown but Enter still advances.
 */
export function promptHidden(question: string): Promise<string> {
  const output = process.stdout;
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  output.write(question);
  const internal = rl as unknown as { _writeToOutput: (s: string) => void };
  internal._writeToOutput = (s: string) => {
    if (s.includes('\n')) output.write('\n');
  };
  return new Promise((resolve) => {
    rl.question('', (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
