/**
 * CLI Output Utilities
 *
 * Provides colorful, structured output for CLI interactions:
 * - Green for success messages
 * - Red for errors
 * - Yellow for warnings
 * - Task status tracking (working -> [done])
 * - Detailed step-by-step feedback
 */

// ANSI color codes
export const COLORS = {
  // Text colors
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  
  // Foreground colors
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  
  // Background colors
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
} as const;

// Icons
export const ICONS = {
  success: '✓',
  error: '✗',
  warning: '⚠',
  info: 'ℹ',
  working: '◌',
  done: '●',
  arrow: '→',
  bullet: '•',
  chevron: '›',
} as const;

// Spinner frames
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL = 80;

/**
 * Strip ANSI color codes from string (for length calculation)
 */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Pad string to width (considering ANSI codes)
 */
function padRight(str: string, width: number): string {
  const visibleLen = stripAnsi(str).length;
  return str + ' '.repeat(Math.max(0, width - visibleLen));
}

// ============================================================================
// Output Stream
// ============================================================================

export type OutputStream = NodeJS.WritableStream;

const defaultStderr: OutputStream = process.stderr;
const defaultStdout: OutputStream = process.stdout;

// ============================================================================
// Basic Output Functions
// ============================================================================

/**
 * Print success message (green)
 */
export function success(message: string, stream: OutputStream = defaultStderr): void {
  stream.write(`${COLORS.green}${ICONS.success}${COLORS.reset} ${message}\n`);
}

/**
 * Print error message (red)
 */
export function error(message: string, stream: OutputStream = defaultStderr): void {
  stream.write(`${COLORS.red}${ICONS.error}${COLORS.reset} ${message}\n`);
}

/**
 * Print warning message (yellow)
 */
export function warning(message: string, stream: OutputStream = defaultStderr): void {
  stream.write(`${COLORS.yellow}${ICONS.warning}${COLORS.reset} ${message}\n`);
}

/**
 * Print info message (cyan)
 */
export function info(message: string, stream: OutputStream = defaultStderr): void {
  stream.write(`${COLORS.cyan}${ICONS.info}${COLORS.reset} ${message}\n`);
}

/**
 * Print a step/progress message
 */
export function step(stepNum: number, total: number, message: string, stream: OutputStream = defaultStderr): void {
  const counter = `${COLORS.dim}[${stepNum}/${total}]${COLORS.reset}`;
  stream.write(`${counter} ${message}\n`);
}

/**
 * Print a sub-item (indented)
 */
export function subItem(message: string, indent: number = 2, stream: OutputStream = defaultStderr): void {
  const spaces = ' '.repeat(indent);
  stream.write(`${spaces}${COLORS.dim}${ICONS.bullet}${COLORS.reset} ${message}\n`);
}

/**
 * Print a key-value pair
 */
export function keyValue(key: string, value: string, stream: OutputStream = defaultStderr): void {
  stream.write(`  ${COLORS.dim}${key}:${COLORS.reset} ${value}\n`);
}

/**
 * Print a header/section title
 */
export function header(title: string, stream: OutputStream = defaultStderr): void {
  stream.write(`\n${COLORS.bold}${COLORS.blue}■ ${title}${COLORS.reset}\n`);
}

/**
 * Print a separator line
 */
export function separator(stream: OutputStream = defaultStderr): void {
  stream.write(`${COLORS.dim}${'─'.repeat(50)}${COLORS.reset}\n`);
}

// ============================================================================
// Task Status Tracker
// ============================================================================

export interface TaskStatus {
  name: string;
  status: 'pending' | 'working' | 'done' | 'failed' | 'skipped';
  message?: string;
  details?: string[];
  duration?: number;
}

export class TaskRunner {
  private tasks: TaskStatus[] = [];
  private currentTaskIndex: number = -1;
  private startTime: number = 0;
  private spinnerInterval: Timer | null = null;
  private frameIndex = 0;
  private stream: OutputStream;
  private json: boolean;

  constructor(stream: OutputStream = defaultStderr, json: boolean = false) {
    this.stream = stream;
    this.json = json;
  }

  /**
   * Register a task
   */
  addTask(name: string): this {
    this.tasks.push({ name, status: 'pending' });
    return this;
  }

  /**
   * Start a task by name or index
   */
  start(taskIdentifier: string | number, message?: string): void {
    if (this.json) return;
    
    const index = typeof taskIdentifier === 'number' 
      ? taskIdentifier 
      : this.tasks.findIndex(t => t.name === taskIdentifier);
    
    if (index === -1) return;
    
    this.currentTaskIndex = index;
    this.tasks[index].status = 'working';
    this.tasks[index].message = message;
    this.startTime = Date.now();
    
    this.render();
    this.startSpinner();
  }

  /**
   * Complete current task successfully
   */
  succeed(message?: string, details?: string[]): void {
    if (this.json) return;
    
    this.stopSpinner();
    
    if (this.currentTaskIndex >= 0) {
      const task = this.tasks[this.currentTaskIndex];
      task.status = 'done';
      task.message = message;
      task.details = details;
      task.duration = Date.now() - this.startTime;
    }
    
    this.render();
  }

  /**
   * Fail current task
   */
  fail(message?: string, details?: string[]): void {
    if (this.json) return;
    
    this.stopSpinner();
    
    if (this.currentTaskIndex >= 0) {
      const task = this.tasks[this.currentTaskIndex];
      task.status = 'failed';
      task.message = message;
      task.details = details;
      task.duration = Date.now() - this.startTime;
    }
    
    this.render();
  }

  /**
   * Skip current task
   */
  skip(reason?: string): void {
    if (this.json) return;
    
    this.stopSpinner();
    
    if (this.currentTaskIndex >= 0) {
      const task = this.tasks[this.currentTaskIndex];
      task.status = 'skipped';
      task.message = reason;
    }
    
    this.render();
  }

  /**
   * Update current task message (while working)
   */
  update(message: string): void {
    if (this.json) return;
    
    if (this.currentTaskIndex >= 0) {
      this.tasks[this.currentTaskIndex].message = message;
      this.render();
    }
  }

  /**
   * Add detail to current task
   */
  addDetail(detail: string): void {
    if (this.json) return;
    
    if (this.currentTaskIndex >= 0) {
      const task = this.tasks[this.currentTaskIndex];
      if (!task.details) task.details = [];
      task.details.push(detail);
    }
  }

  /**
   * Print summary of all tasks
   */
  summary(): void {
    if (this.json) return;
    
    this.stopSpinner();
    this.stream.write('\n');
    
    const done = this.tasks.filter(t => t.status === 'done').length;
    const failed = this.tasks.filter(t => t.status === 'failed').length;
    const skipped = this.tasks.filter(t => t.status === 'skipped').length;
    const total = this.tasks.length;
    
    // Summary line
    const parts: string[] = [];
    if (done > 0) parts.push(`${COLORS.green}${done} passed${COLORS.reset}`);
    if (failed > 0) parts.push(`${COLORS.red}${failed} failed${COLORS.reset}`);
    if (skipped > 0) parts.push(`${COLORS.yellow}${skipped} skipped${COLORS.reset}`);
    
    const summaryText = parts.join(', ') || 'No tasks';
    this.stream.write(`${COLORS.bold}Summary:${COLORS.reset} ${summaryText} (${total} total)\n`);
  }

  // -----------------------------------------------------------------------
  // Private methods
  // -----------------------------------------------------------------------

  private startSpinner(): void {
    this.stopSpinner();
    this.spinnerInterval = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % SPINNER_FRAMES.length;
      this.render();
    }, SPINNER_INTERVAL);
  }

  private stopSpinner(): void {
    if (this.spinnerInterval) {
      clearInterval(this.spinnerInterval);
      this.spinnerInterval = null;
    }
  }

  private render(): void {
    // Clear previous output
    const linesToClear = this.tasks.length + 
      this.tasks.reduce((sum, t) => sum + (t.details?.length ?? 0), 0);
    
    for (let i = 0; i < linesToClear + 2; i++) {
      this.stream.write('\x1b[F\x1b[K'); // Move up and clear line
    }
    
    // Render each task
    for (let i = 0; i < this.tasks.length; i++) {
      const task = this.tasks[i];
      this.renderTask(task, i === this.currentTaskIndex);
    }
    
    this.stream.write('\n');
  }

  private renderTask(task: TaskStatus, isCurrent: boolean): void {
    const icon = this.getStatusIcon(task.status, isCurrent);
    const color = this.getStatusColor(task.status);
    const name = task.name;
    const message = task.message ? ` ${COLORS.dim}${task.message}${COLORS.reset}` : '';
    const duration = task.duration ? ` ${COLORS.dim}(${formatDuration(task.duration)})${COLORS.reset}` : '';
    
    this.stream.write(`${color}${icon}${COLORS.reset} ${name}${message}${duration}\n`);
    
    // Render details
    if (task.details && task.details.length > 0) {
      for (const detail of task.details) {
        this.stream.write(`    ${COLORS.dim}${ICONS.chevron} ${detail}${COLORS.reset}\n`);
      }
    }
  }

  private getStatusIcon(status: TaskStatus['status'], isCurrent: boolean): string {
    if (status === 'working' && isCurrent) {
      return SPINNER_FRAMES[this.frameIndex];
    }
    
    switch (status) {
      case 'pending': return '○';
      case 'working': return SPINNER_FRAMES[this.frameIndex];
      case 'done': return ICONS.done;
      case 'failed': return ICONS.error;
      case 'skipped': return '○';
      default: return '○';
    }
  }

  private getStatusColor(status: TaskStatus['status']): string {
    switch (status) {
      case 'done': return COLORS.green;
      case 'failed': return COLORS.red;
      case 'skipped': return COLORS.yellow;
      case 'working': return COLORS.cyan;
      default: return COLORS.dim;
    }
  }
}

// ============================================================================
// Progress Spinner (Simple)
// ============================================================================

export interface ProgressSpinner {
  start(message: string): void;
  update(message: string): void;
  succeed(message?: string): void;
  fail(message?: string): void;
  warn(message?: string): void;
  stop(): void;
}

export function createSpinner(stream: OutputStream = defaultStderr): ProgressSpinner {
  let frameIndex = 0;
  let interval: Timer | null = null;
  let currentMessage = '';
  let isRunning = false;

  function clearLine(): void {
    stream.write('\r\x1b[K');
  }

  function render(): void {
    if (!isRunning) return;
    const frame = SPINNER_FRAMES[frameIndex];
    clearLine();
    stream.write(`\x1b[36m${frame}\x1b[0m ${currentMessage}`);
    frameIndex = (frameIndex + 1) % SPINNER_FRAMES.length;
  }

  function start(message: string): void {
    if (isRunning) stop();
    currentMessage = message;
    isRunning = true;
    frameIndex = 0;
    render();
    interval = setInterval(render, SPINNER_INTERVAL);
  }

  function update(message: string): void {
    currentMessage = message;
    if (!isRunning) {
      start(message);
    }
  }

  function stop(): void {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    if (isRunning) {
      clearLine();
      isRunning = false;
    }
  }

  function succeed(message?: string): void {
    stop();
    const text = message || currentMessage;
    stream.write(`\x1b[32m${ICONS.success}\x1b[0m ${text}\n`);
  }

  function fail(message?: string): void {
    stop();
    const text = message || currentMessage;
    stream.write(`\x1b[31m${ICONS.error}\x1b[0m ${text}\n`);
  }

  function warn(message?: string): void {
    stop();
    const text = message || currentMessage;
    stream.write(`\x1b[33m${ICONS.warning}\x1b[0m ${text}\n`);
  }

  return { start, update, succeed, fail, warn, stop };
}

// ============================================================================
// Result Reporter
// ============================================================================

export interface OperationResult {
  ok: boolean;
  message?: string;
  details?: Record<string, unknown>;
  warnings?: string[];
  errors?: string[];
}

/**
 * Print detailed operation result
 */
export function reportResult(
  result: OperationResult,
  stream: OutputStream = defaultStderr
): void {
  if (result.ok) {
    success(result.message || 'Operation completed successfully', stream);
  } else {
    error(result.message || 'Operation failed', stream);
  }
  
  // Print details
  if (result.details) {
    for (const [key, value] of Object.entries(result.details)) {
      keyValue(key, String(value), stream);
    }
  }
  
  // Print warnings
  if (result.warnings && result.warnings.length > 0) {
    for (const w of result.warnings) {
      warning(w, stream);
    }
  }
  
  // Print errors
  if (result.errors && result.errors.length > 0) {
    for (const e of result.errors) {
      subItem(`${COLORS.red}${e}${COLORS.reset}`, 4, stream);
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Format duration in human-readable form
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/**
 * Format bytes
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/**
 * Format count with singular/plural
 */
export function formatCount(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : (plural || singular + 's')}`;
}