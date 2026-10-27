import { useEffect } from "react";
import { api } from "../api";
import { monaco } from "../monacoSetup";
import { parseSnippets, type Snippet } from "../snippets";
import type { TreeNode } from "../types";

export const USER_SNIPPETS_KEY = "veyra_user_snippets";

export function snippetFilePaths(tree: TreeNode[]): string[] {
  const dir = tree.find((n) => n.type === "dir" && n.name === ".veyra")?.children?.find(
    (n) => n.type === "dir" && n.name === "snippets",
  );
  return (dir?.children ?? []).filter((n) => n.type === "file" && n.name.endsWith(".json")).map((n) => n.path);
}

/**
 * M104: registers user (localStorage) + project (`.veyra/snippets/*.json`)
 * snippets as Monaco completions for every language. Reloads when the set of
 * snippet files changes or the project switches.
 */
export function useSnippets(projectId: string | undefined, tree: TreeNode[]): void {
  const key = snippetFilePaths(tree).join("|");
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    let disposable: { dispose(): void } | undefined;
    void (async () => {
      const all: Snippet[] = [];
      try {
        all.push(...parseSnippets(localStorage.getItem(USER_SNIPPETS_KEY) ?? ""));
      } catch {
        /* storage unavailable */
      }
      for (const p of key ? key.split("|") : []) {
        try {
          const res = await api<{ content: string }>(
            `/api/projects/${projectId}/file?path=${encodeURIComponent(p)}`,
          );
          all.push(...parseSnippets(res.content));
        } catch {
          /* unreadable snippet file — skip */
        }
      }
      if (cancelled || all.length === 0) return;
      disposable = monaco.languages.registerCompletionItemProvider("*", {
        provideCompletionItems: (model, position) => {
          const word = model.getWordUntilPosition(position);
          const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
          return {
            suggestions: all.map((s) => ({
              label: s.prefix,
              detail: s.description,
              kind: monaco.languages.CompletionItemKind.Snippet,
              insertText: s.body,
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              range,
            })),
          };
        },
      });
    })();
    return () => {
      cancelled = true;
      disposable?.dispose();
    };
  }, [projectId, key]);
}
