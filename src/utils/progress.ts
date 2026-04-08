/**
 * Progress indicator with spinner animation for long-running operations.
 */

export interface ProgressIndicator {
  start(message: string): void;
  update(message: string): void;
  succeed(message?: string): void;
  fail(message?: string): void;
  stop(): void;
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL = 80;

/**
 * Create a progress indicator with spinner animation.
 * @param stream Output stream (default: process.stderr)
 */
export function createProgress(stream: NodeJS.WritableStream = process.stderr): ProgressIndicator {
  let frameIndex = 0;
  let interval: Timer | null = null;
  let currentMessage = '';
  let isRunning = false;

  function clearLine() {
    stream.write('\r\x1b[K');
  }

  function render() {
    if (!isRunning) return;
    const frame = SPINNER_FRAMES[frameIndex];
    clearLine();
    stream.write(`\x1b[36m${frame}\x1b[0m ${currentMessage}`);
    frameIndex = (frameIndex + 1) % SPINNER_FRAMES.length;
  }

  function start(message: string) {
    if (isRunning) stop();
    currentMessage = message;
    isRunning = true;
    frameIndex = 0;
    render();
    interval = setInterval(render, SPINNER_INTERVAL);
  }

  function update(message: string) {
    currentMessage = message;
    if (!isRunning) {
      start(message);
    }
  }

  function stop() {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    if (isRunning) {
      clearLine();
      isRunning = false;
    }
  }

  function succeed(message?: string) {
    stop();
    const text = message || currentMessage;
    stream.write(`\x1b[32m✓\x1b[0m ${text}\n`);
  }

  function fail(message?: string) {
    stop();
    const text = message || currentMessage;
    stream.write(`\x1b[31m✗\x1b[0m ${text}\n`);
  }

  return { start, update, succeed, fail, stop };
}

/**
 * Simple spinner for async operations.
 * Usage: const done = spinner.start('Processing...'); await task(); done('Done');
 */
export function spinner(stream: NodeJS.WritableStream = process.stderr) {
  const progress = createProgress(stream);
  
  return {
    start(message: string) {
      progress.start(message);
      return (finalMessage?: string) => {
        progress.succeed(finalMessage);
      };
    },
    fail(message: string) {
      progress.fail(message);
    },
  };
}

/**
 * Progress bar for batch operations.
 */
export function progressBar(total: number, stream: NodeJS.WritableStream = process.stderr) {
  let current = 0;
  let lastPercent = -1;

  function render(label: string) {
    const percent = Math.floor((current / total) * 100);
    if (percent === lastPercent) return;
    lastPercent = percent;

    const barWidth = 30;
    const filled = Math.floor((current / total) * barWidth);
    const empty = barWidth - filled;
    const bar = '█'.repeat(filled) + '░'.repeat(empty);

    stream.write(`\r\x1b[K${label} [${bar}] ${percent}% (${current}/${total})`);
  }

  return {
    start(label: string) {
      current = 0;
      lastPercent = -1;
      render(label);
    },
    increment(label: string) {
      current++;
      render(label);
    },
    done(label: string) {
      current = total;
      render(label);
      stream.write('\n');
    },
  };
}

/**
 * Format duration in human-readable form.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/**
 * Measure and report operation duration.
 */
export async function withProgress<T>(
  message: string,
  fn: () => Promise<T>,
  stream: NodeJS.WritableStream = process.stderr
): Promise<T> {
  const progress = createProgress(stream);
  const start = Date.now();
  
  progress.start(message);
  
  try {
    const result = await fn();
    const duration = formatDuration(Date.now() - start);
    progress.succeed(`${message} (${duration})`);
    return result;
  } catch (error) {
    progress.fail(`${message} - failed`);
    throw error;
  }
}