/** Fail before network access when a historical API cannot establish scope. */
export function rejectUnsafeLegacyOperation(operation: string): never {
  throw new Error(`${operation} is disabled because its legacy URL-only API cannot safely enforce instance scope or non-destructive maintenance. Use createMnemosyne(...).consolidate({ dryRun: true }), createMnemosyne(...).dream(), or maintainMemory(scopedDb). No network access or mutation was attempted.`);
}
