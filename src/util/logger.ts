import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

function out(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('Bitbucket PR');
  }
  return channel;
}

function ts(): string {
  return new Date().toISOString();
}

/** Output-channel logger. Never pass secrets to it. */
export const log = {
  info(message: string): void {
    out().appendLine(`[${ts()}] INFO  ${message}`);
  },
  warn(message: string): void {
    out().appendLine(`[${ts()}] WARN  ${message}`);
  },
  error(message: string, err?: unknown): void {
    const detail = err instanceof Error ? ` ${err.message}` : err ? ` ${String(err)}` : '';
    out().appendLine(`[${ts()}] ERROR ${message}${detail}`);
  },
  show(): void {
    out().show(true);
  },
  dispose(): void {
    channel?.dispose();
    channel = undefined;
  },
};
