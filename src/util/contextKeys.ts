import * as vscode from 'vscode';

/** Context keys used in `when` clauses of package.json. */
export const ContextKey = {
  hasRepo: 'bitbucketPr.hasRepo',
  signedIn: 'bitbucketPr.signedIn',
  hasPr: 'bitbucketPr.hasPr',
  loading: 'bitbucketPr.loading',
  readOnly: 'bitbucketPr.readOnly',
  inlineCommenting: 'bitbucketPr.inlineCommenting',
} as const;

export type ContextKeyName = (typeof ContextKey)[keyof typeof ContextKey];

export function setContext(key: ContextKeyName, value: boolean): Thenable<void> {
  return vscode.commands.executeCommand('setContext', key, value);
}
