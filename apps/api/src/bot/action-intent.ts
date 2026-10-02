export function isCancelledTask(text: string) {
  return (
    /\b(?:never\s*mind|forget (?:it|that)|don['’]t|do not)\b/iu.test(text) ||
    /^(?:stop|stop (?:it|that)|cancel|cancel (?:it|that|this|the (?:task|request|operation)))[.!]?$/iu.test(
      text.trim(),
    )
  );
}

export function isWriteToolName(name: string) {
  if (name === "export_job_status") return false;
  if (
    /(?:^|_)(?:assign|unassign|cancel|mark|remind|confirm|create|decline|delete|draft|duplicate|export|match|pause|resume|send|start|stop|sync|toggle|unmatch|update|upsert)(?:_|$)/u.test(
      name,
    )
  )
    return true;
  // New operations fail closed until explicitly classified as a read.
  return !(
    /^reports_/u.test(name) ||
    /(?:^|_)(?:list|get|search|summary|analytics|status|balances|currencies|details|members|connections)(?:_|$)/u.test(
      name,
    )
  );
}
