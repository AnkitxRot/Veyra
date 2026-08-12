export interface LanguageInfo {
  id: string;
  name: string;
  monacoId: string;
  runnable: boolean;
}

export function getLanguageInfo(filename: string | null): LanguageInfo {
  if (!filename) {
    return { id: 'plaintext', name: 'Plain Text', monacoId: 'plaintext', runnable: false };
  }

  const ext = filename.split('.').pop()?.toLowerCase() ?? '';

  switch (ext) {
    case 'py':
      return { id: 'python', name: 'Python', monacoId: 'python', runnable: true };
    case 'c':
    case 'h':
      return { id: 'c', name: 'C', monacoId: 'c', runnable: true };
    case 'cpp':
    case 'cc':
    case 'cxx':
    case 'hpp':
      return { id: 'cpp', name: 'C++', monacoId: 'cpp', runnable: true };
    case 'java':
      return { id: 'java', name: 'Java', monacoId: 'java', runnable: true };
    case 'js':
    case 'mjs':
    case 'cjs':
      return { id: 'node', name: 'Node.js', monacoId: 'javascript', runnable: true };
    case 'ts':
      return { id: 'typescript', name: 'TypeScript', monacoId: 'typescript', runnable: true };
    case 'jsx':
      return { id: 'react', name: 'React (JSX)', monacoId: 'javascript', runnable: false };
    case 'tsx':
      return { id: 'react', name: 'React (TSX)', monacoId: 'typescript', runnable: false };
    case 'html':
    case 'htm':
      return { id: 'html', name: 'HTML', monacoId: 'html', runnable: false };
    case 'css':
    case 'scss':
    case 'less':
      return { id: 'css', name: 'CSS', monacoId: 'css', runnable: false };
    case 'json':
      return { id: 'json', name: 'JSON', monacoId: 'json', runnable: false };
    case 'md':
    case 'markdown':
      return { id: 'markdown', name: 'Markdown', monacoId: 'markdown', runnable: false };
    case 'sh':
    case 'bash':
      return { id: 'shell', name: 'Shell', monacoId: 'shell', runnable: false };
    case 'sql':
      return { id: 'sql', name: 'SQL', monacoId: 'sql', runnable: false };
    case 'xml':
    case 'svg':
      return { id: 'xml', name: 'XML', monacoId: 'xml', runnable: false };
    case 'yaml':
    case 'yml':
      return { id: 'yaml', name: 'YAML', monacoId: 'yaml', runnable: false };
    default:
      return { id: 'plaintext', name: 'Plain Text', monacoId: 'plaintext', runnable: false };
  }
}
