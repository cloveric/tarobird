/** Native tool names differ across CLI engines. Keep display semantics shared
 * with the summary producer; never infer an action from arbitrary shell text. */
export function runToolAction(name = "", input?: Record<string, unknown>): "read" | "edit" | "search" | "execute" | "plan" | "delegate" | "other" {
  // Native delegation tools only: an unrelated MCP tool named Task is not a child.
  if (name === "Agent" || name === "Task" || name === "CodexAgent") return "delegate";
  const key = name.split(/__|[.:/]/).at(-1)!.replace(/[_-]/g, "").toLowerCase();
  if (key === "strreplaceeditor") return input?.command === "view" ? "read" : "edit";
  if (["todowrite", "settodolist", "updateplan"].includes(key)) return "plan";
  if (["read", "readfile", "viewfile", "viewfileoutline", "viewcodeitem", "listdir"].includes(key)) return "read";
  if (["write", "writefile", "writetofile", "edit", "editfile", "strreplacefile", "replacefilecontent", "multireplacefilecontent", "applypatch", "filechange"].includes(key)) return "edit";
  if (/search|webfetch|webextract|browse/.test(key) || ["grep", "glob", "findbyname"].includes(key)) return "search";
  if (["bash", "shell", "execcommand", "shellcommand", "commandexecution", "terminal", "runcommand", "commandstatus", "sendcommandinput"].includes(key)) return "execute";
  return "other";
}

export function runToolLabels(input: Record<string, unknown>, name?: string): Record<string, string> {
  const first = (...keys: string[]) => keys.map(key => input[key]).find(value => typeof value === "string" && value.trim()) as string | undefined;
  const file = first("file_path", "path", "file", "filename", "filePath", "TargetFile", "AbsolutePath", "DirectoryPath", "SearchPath");
  const query = first("query", "q", "Query", "SearchTerm", "pattern", "Pattern");
  const description = first("description", "Description");
  const command = name?.split(/[.:/]/).at(-1) === "str_replace_editor" && ["view", "create", "str_replace", "insert", "undo_edit"].includes(String(input.command)) ? String(input.command) : undefined;
  const action = name === "CodexAgent" ? first("action") : undefined;
  return { ...(action ? { action } : {}), ...(command ? { command } : {}), ...(file ? { file_path: file } : {}), ...(query ? { query } : {}), ...(description ? { description } : {}) };
}
