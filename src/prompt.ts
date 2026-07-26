import { createInterface } from 'node:readline';

// Control characters handled while reading a hidden password in raw mode.
const ENTER = ['\r', '\n'];
const CTRL_C = '';
const CTRL_D = '';
const BACKSPACE = ['', '\b'];

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
 * Prompt for hidden input (a password). Reads stdin in raw mode so the label is
 * always shown and typed characters are never echoed — the readline-based mute
 * trick redraws the line and dropped the label on Windows. Handles Enter,
 * Backspace and Ctrl-C. Requires a TTY (login guards for one first).
 */
export function promptHidden(question: string): Promise<string> {
  const { stdin, stdout } = process;
  stdout.write(question);

  return new Promise((resolve) => {
    const wasRaw = stdin.isRaw ?? false;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let input = '';

    const finish = (value: string) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdout.write('\n');
      resolve(value);
    };

    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ENTER.includes(ch) || ch === CTRL_D) {
          finish(input);
          return;
        }
        if (ch === CTRL_C) {
          stdin.setRawMode(wasRaw);
          stdout.write('\n');
          process.exit(130);
        } else if (BACKSPACE.includes(ch)) {
          input = input.slice(0, -1);
        } else if (ch >= ' ') {
          // Printable character (other control codes are ignored).
          input += ch;
        }
      }
    };

    stdin.on('data', onData);
  });
}
