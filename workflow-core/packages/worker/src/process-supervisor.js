import { spawn } from 'node:child_process';

export class ProcessSupervisor {
  constructor({ log = () => {} } = {}) { this.log = log; this.children = new Set(); }
  spawn(command, args = [], options = {}) {
    const child = spawn(command, args, { ...options, stdio: options.stdio || ['pipe', 'pipe', 'pipe'] });
    this.children.add(child);
    const remove = () => this.children.delete(child);
    child.once('exit', remove); child.once('error', remove);
    return child;
  }
  async stopAll(signal = 'SIGTERM') {
    for (const child of this.children) child.kill?.(signal);
    await Promise.all([...this.children].map((child) => new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve); setTimeout(() => { child.kill?.('SIGKILL'); resolve(); }, 2_000).unref?.();
    })));
    this.children.clear();
  }
}
