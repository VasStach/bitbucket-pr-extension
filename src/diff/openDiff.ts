import * as vscode from 'vscode';
import type { ChangedFile, PrModel } from '../pr/prModel';
import { log } from '../util/logger';
import { makePrFileUri, prIdentityForModel } from './prUris';

/** Opens the PR diff (target version vs. source version) of a changed file in the diff editor. */
export async function openPrDiff(model: PrModel, file: ChangedFile, options: { line?: number; preserveFocus?: boolean } = {}): Promise<void> {
  const coords = prIdentityForModel(model);

  let fromHash = model.targetCommit;
  let toHash = model.sourceCommit;
  try {
    const fd = await model.loadFileDiff(file.path);
    if (fd) {
      fromHash = fd.fromHash || fromHash;
      toHash = fd.toHash || toHash;
    }
  } catch (e) {
    log.warn(`Diff metadata unavailable for ${file.path}: ${(e as Error).message}`);
  }

  const type = file.change.type;
  const leftPath = file.srcPath ?? file.path;
  const left = makePrFileUri({ ...coords, side: 'FROM', path: leftPath, commit: type === 'ADD' ? '' : fromHash });
  const right = makePrFileUri({ ...coords, side: 'TO', path: file.path, commit: type === 'DELETE' ? '' : toHash });

  const name = file.path.split('/').pop() ?? file.path;
  const title = `${name} (PR #${model.id}: ${model.pr.toRef.displayId} ⟷ ${model.pr.fromRef.displayId})`;
  const showOptions: vscode.TextDocumentShowOptions = { preserveFocus: options.preserveFocus ?? false, preview: true };
  if (options.line) {
    const pos = new vscode.Position(Math.max(0, options.line - 1), 0);
    showOptions.selection = new vscode.Range(pos, pos);
  }
  await vscode.commands.executeCommand('vscode.diff', left, right, title, showOptions);
}
