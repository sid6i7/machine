import { exec } from 'child_process';
import { promisify } from 'util';

const execPromise = promisify(exec);

export class ShellExecutor {
  static async run(command: string): Promise<{ stdout: string, stderr: string }> {
    return execPromise(command);
  }
}
