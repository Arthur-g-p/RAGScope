enum LogLevel {
  INFO = 'INFO',
  WARNING = 'WARNING',
  ERROR = 'ERROR'
}

class Logger {
  private logs: Array<{ timestamp: string; level: LogLevel; message: string }> = [];

  private log(level: LogLevel, message: string): void {
    const timestamp = new Date().toISOString();
    const logEntry = { timestamp, level, message };
    
    this.logs.push(logEntry);
    
    const formattedMessage = `[${timestamp}] ${level}: ${message}`;
    
    switch (level) {
      case LogLevel.INFO:
        console.log(formattedMessage);
        break;
      case LogLevel.WARNING:
        console.warn(formattedMessage);
        break;
      case LogLevel.ERROR:
        console.error(formattedMessage);
        break;
    }
  }

  info(message: string): void {
    this.log(LogLevel.INFO, message);
  }

  warning(message: string): void {
    this.log(LogLevel.WARNING, message);
  }

  error(message: string): void {
    this.log(LogLevel.ERROR, message);
  }

  getLogs(): Array<{ timestamp: string; level: string; message: string }> {
    return [...this.logs];
  }

  exportLogs(): string {
    return this.logs
      .map(log => `[${log.timestamp}] ${log.level}: ${log.message}`)
      .join('\n');
  }
}

export const logger = new Logger();

logger.info('Frontend logging initialized');