import React from 'react';
import { getLanguageInfo } from '../../utils/language';

export default function Toolbar({ project, activeFile, capabilities }: any) {
  const [isRunning, setIsRunning] = React.useState(false);

  React.useEffect(() => {
    const onStart = () => setIsRunning(true);
    const onStop = () => setIsRunning(false);
    document.addEventListener('run-started', onStart);
    document.addEventListener('run-stopped', onStop);
    return () => {
      document.removeEventListener('run-started', onStart);
      document.removeEventListener('run-stopped', onStop);
    };
  }, []);

  const langInfo = getLanguageInfo(activeFile);
  const langDisplay = langInfo.name;
  const runnable = langInfo.runnable;
  const langId = langInfo.id;

  const handleRun = () => {
    if (project && !isRunning && activeFile) {
      document.dispatchEvent(new CustomEvent('ide-run', {
        detail: {
          language: langId,
          activeFile,
          langDisplay
        }
      }));
    }
  };

  const handleStop = () => {
    if (isRunning) {
      document.dispatchEvent(new Event('ide-stop'));
    }
  };

  let toolchainAvailable = true;
  let notRunnableTitle = activeFile ? `Files of type ${langDisplay} cannot be executed directly.` : 'Open a file to run';

  if (runnable && capabilities) {
    if (!capabilities.docker) {
      toolchainAvailable = false;
      notRunnableTitle = 'Docker Sandbox unavailable. CloudeeeIDE requires Docker Desktop for execution.';
    } else if (!capabilities.runnerImage) {
      toolchainAvailable = false;
      notRunnableTitle = 'Runner Image unavailable. Please build cloudeeeide-runner:latest.';
    } else if (langId === 'python' && !capabilities.languages.python) toolchainAvailable = false;
    else if (langId === 'node' && !capabilities.languages.node) toolchainAvailable = false;
    else if (langId === 'typescript' && !capabilities.languages.typescript) toolchainAvailable = false;
    else if (langId === 'c' && !capabilities.languages.c) toolchainAvailable = false;
    else if (langId === 'cpp' && !capabilities.languages.cpp) toolchainAvailable = false;
    else if (langId === 'java' && !capabilities.languages.java) toolchainAvailable = false;

    if (runnable && !toolchainAvailable && notRunnableTitle === '') {
      notRunnableTitle = `Required toolchain for ${langDisplay} is unavailable in the runner image.`;
    }
  }

  const runLabel = langDisplay && runnable ? `Run ${langDisplay}` : 'Run';
  const canRun = runnable && toolchainAvailable;

  return (
    <div className="toolbar">
      <div style={{ flex: 1, color: 'var(--muted)', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '16px' }}>
        <div>{project ? `${project.name} ${activeFile ? `> ${activeFile}` : ''}` : 'No Project'}</div>

        {capabilities && (
          <div title="Execution Environment Capabilities" style={{ display: 'flex', gap: '8px', padding: '4px 8px', background: 'var(--panel-2)', borderRadius: '4px' }}>
            <span>Env: </span>
            <span style={{ color: capabilities.docker ? 'var(--text)' : '#f38ba8' }}>
              {capabilities.docker ? '✓' : '✗'} Docker
            </span>
            <span style={{ color: capabilities.runnerImage ? 'var(--text)' : '#f38ba8' }}>
              {capabilities.runnerImage ? '✓' : '✗'} Runner
            </span>
            <span style={{ color: capabilities.languages.python ? 'var(--text)' : '#f38ba8' }}>
              {capabilities.languages.python ? '✓' : '✗'} Python
            </span>
            <span style={{ color: capabilities.languages.node ? 'var(--text)' : '#f38ba8' }}>
              {capabilities.languages.node ? '✓' : '✗'} Node
            </span>
            <span style={{ color: capabilities.languages.c ? 'var(--text)' : '#f38ba8' }}>
              {capabilities.languages.c ? '✓' : '✗'} GCC
            </span>
            <span style={{ color: capabilities.languages.java ? 'var(--text)' : '#f38ba8' }}>
              {capabilities.languages.java ? '✓' : '✗'} Java
            </span>
          </div>
        )}
      </div>
      <div className="toolbar-actions" style={{ display: 'flex', gap: '8px' }}>
        {isRunning ? (
          <button onClick={handleStop} style={{ background: '#f38ba8', color: '#111' }}>Stop</button>
        ) : (
          <button
            onClick={handleRun}
            disabled={!canRun}
            title={canRun ? '' : notRunnableTitle}
            style={{
              background: canRun ? 'var(--accent)' : 'var(--panel-2)',
              color: canRun ? '#111' : 'var(--muted)',
              cursor: canRun ? 'pointer' : 'not-allowed'
            }}
          >
            {runLabel}
          </button>
        )}
      </div>
    </div>
  );
}
