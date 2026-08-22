import React from 'react';
import { IconFile, IconFileCode } from './Icons';

// Language Specific File Icon Helper
export function getLanguageIcon(filename: string, size = 14) {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'py':
      return React.createElement(IconFileCode, { size, color: '#f9e2af', title: 'Python File' });
    case 'js':
    case 'mjs':
    case 'cjs':
      return React.createElement(IconFileCode, { size, color: '#f9e2af', title: 'JavaScript File' });
    case 'ts':
      return React.createElement(IconFileCode, { size, color: '#89b4fa', title: 'TypeScript File' });
    case 'jsx':
    case 'tsx':
      return React.createElement(IconFileCode, { size, color: '#74c7ec', title: 'React File' });
    case 'c':
    case 'h':
      return React.createElement(IconFileCode, { size, color: '#94e2d5', title: 'C Source File' });
    case 'cpp':
    case 'hpp':
    case 'cc':
      return React.createElement(IconFileCode, { size, color: '#89dceb', title: 'C++ Source File' });
    case 'java':
      return React.createElement(IconFileCode, { size, color: '#eba0ac', title: 'Java Source File' });
    case 'html':
    case 'htm':
      return React.createElement(IconFileCode, { size, color: '#fab387', title: 'HTML Document' });
    case 'css':
    case 'scss':
    case 'less':
      return React.createElement(IconFileCode, { size, color: '#89b4fa', title: 'Stylesheet' });
    case 'json':
      return React.createElement(IconFileCode, { size, color: '#cba6f7', title: 'JSON Config' });
    case 'md':
    case 'markdown':
      return React.createElement(IconFileCode, { size, color: '#a6adc8', title: 'Markdown File' });
    case 'sh':
    case 'bash':
      return React.createElement(IconFileCode, { size, color: '#a6e3a1', title: 'Shell Script' });
    default:
      return React.createElement(IconFile, { size, color: '#6c7086', title: 'Text File' });
  }
}
